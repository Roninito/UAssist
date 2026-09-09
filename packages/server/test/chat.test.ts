import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importPlan, initProject } from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * Card chat end to end over real HTTP, against a real (fake, in-process)
 * OpenAI-compatible SSE endpoint — the same fixture pattern
 * packages/core/test/llm.test.ts uses at the unit level. This file is
 * about the HTTP wrapper: that a reasoning model's exhausted-budget case
 * (a real bug found live against Ollama — "shows Ollama but no reply")
 * produces a helpful, non-empty stored message, not just that llm.ts
 * parses SSE correctly in isolation.
 */

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function startFakeProvider(chunks: string[]) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

let root: string;
let baseUrl: string;
let stopServer: () => void;
let cardId: string;
const fakeProviders: (() => void)[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uassist-chat-http-"));
  const { store } = initProject(root, "ChatHttpTest");
  importPlan(store, "## Phase 0 — Corridor\n\n- Discuss the plan.\n", "plan.md");
  cardId = store.listCards()[0]!.id;
  store.close();

  const { server } = await startServer({ root, port: 58960 });
  baseUrl = `http://127.0.0.1:${server.port}`;
  stopServer = () => server.stop(true);
});

afterAll(() => {
  stopServer?.();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const fn of fakeProviders.splice(0)) fn();
});

async function configureProvider(url: string, maxTokens = 4096): Promise<void> {
  const res = await fetch(`${baseUrl}/api/ai/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      activeProviderId: "fake",
      providers: [{ id: "fake", kind: "ollama", name: "Fake", baseUrl: url, model: "fake-model", enabled: true }],
      systemPrompt: "test",
      maxContextMessages: 10,
      maxTokens,
      temperature: 0.5,
    }),
  });
  expect(res.status).toBe(200);
}

async function waitForAssistantReply(timeoutMs = 5000): Promise<{ role: string; content: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await fetch(`${baseUrl}/api/cards/${cardId}/chat`).then((r) => r.json());
    const last = body.thread?.messages?.at(-1);
    if (last?.role === "assistant") return last;
    await Bun.sleep(50);
  }
  throw new Error("no assistant reply within timeout");
}

describe("POST /api/cards/:id/chat", () => {
  test("a normal reply streams through and is stored", async () => {
    const fake = startFakeProvider([
      sseChunk({ role: "assistant", content: "Hi" }),
      sseChunk({ content: " there" }),
      sseChunk({}, "stop"),
    ]);
    fakeProviders.push(fake.stop);
    await configureProvider(fake.url);

    const res = await fetch(`${baseUrl}/api/cards/${cardId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "say hi" }),
    });
    expect(res.status).toBe(200);

    const reply = await waitForAssistantReply();
    expect(reply.content).toBe("Hi there");
  });

  test("a reasoning model that exhausts its budget before any content produces a helpful message, not a blank one", async () => {
    const fake = startFakeProvider([
      sseChunk({ content: "", reasoning: "thinking really hard" }),
      sseChunk({}, "length"),
    ]);
    fakeProviders.push(fake.stop);
    await configureProvider(fake.url, 100);

    const res = await fetch(`${baseUrl}/api/cards/${cardId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "say hi" }),
    });
    expect(res.status).toBe(200);

    const reply = await waitForAssistantReply();
    expect(reply.content.length).toBeGreaterThan(0);
    expect(reply.content).toContain("100");
    expect(reply.content.toLowerCase()).toContain("max tokens");
  });
});
