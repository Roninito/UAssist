import { afterEach, describe, expect, test } from "bun:test";

import { createLlmClient, describeEmptyReply } from "../src/llm.ts";
import type { AiProviderConfig, ChatMessage } from "../src/types.ts";

/**
 * A real OpenAI-compatible SSE endpoint, spun up in-process via Bun.serve —
 * the same pattern mcp-client.test.ts uses. Exercises llm.ts's actual SSE
 * parsing against a real streamed response, not a mocked fetch.
 */
function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function startFakeOpenAiServer(chunks: string[], opts: { status?: number; errorBody?: unknown } = {}) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (opts.status && opts.status !== 200) {
        return Response.json(opts.errorBody ?? { error: { message: "boom" } }, { status: opts.status });
      }
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fakeProvider(baseUrl: string): AiProviderConfig {
  return { id: "fake", kind: "ollama", name: "Fake", baseUrl, model: "fake-model", enabled: true };
}

const USER_MESSAGE: ChatMessage = { role: "user", content: "say hi", createdAt: Date.now() };

describe("createLlmClient — real SSE streaming", () => {
  test("streams content chunks and reports done with the finish reason", async () => {
    const { url, stop } = startFakeOpenAiServer([
      sseChunk({ role: "assistant", content: "Hi" }),
      sseChunk({ content: " there" }),
      sseChunk({}, "stop"),
    ]);
    cleanups.push(stop);

    const client = createLlmClient(fakeProvider(url));
    const received: { content: string; done: boolean }[] = [];
    for await (const chunk of client.chat({ messages: [USER_MESSAGE] })) {
      received.push({ content: chunk.content, done: chunk.done });
      if (chunk.done) expect(chunk.finishReason).toBe("stop");
    }

    expect(received.map((c) => c.content).join("")).toBe("Hi there");
    expect(received.at(-1)?.done).toBe(true);
  });

  test("a reasoning model's hidden trace (a non-standard delta field) never surfaces as content", async () => {
    // Mirrors what Ollama actually sends for a "thinking" model: content is
    // empty on every chunk while the trace streams through a `reasoning`
    // field this client deliberately never reads, then the budget runs out.
    const { url, stop } = startFakeOpenAiServer([
      sseChunk({ content: "", reasoning: "Let me think" }),
      sseChunk({ content: "", reasoning: " about this..." }),
      sseChunk({}, "length"),
    ]);
    cleanups.push(stop);

    const client = createLlmClient(fakeProvider(url));
    let content = "";
    let finishReason: string | undefined;
    for await (const chunk of client.chat({ messages: [USER_MESSAGE] })) {
      content += chunk.content;
      if (chunk.done) finishReason = chunk.finishReason;
    }

    expect(content).toBe("");
    expect(finishReason).toBe("length");
  });

  test("a non-ok response throws with the provider's own error message", async () => {
    const { url, stop } = startFakeOpenAiServer([], { status: 400, errorBody: { error: { message: "model not found" } } });
    cleanups.push(stop);

    const client = createLlmClient(fakeProvider(url));
    await expect(async () => {
      for await (const _chunk of client.chat({ messages: [USER_MESSAGE] })) {
        // draining is enough to trigger the throw
      }
    }).toThrow("model not found");
  });
});

describe("describeEmptyReply", () => {
  test("undefined when the model actually said something (finishReason stop)", () => {
    expect(describeEmptyReply("stop", 100)).toBeUndefined();
  });

  test("undefined when there is no finish reason at all yet", () => {
    expect(describeEmptyReply(undefined, 100)).toBeUndefined();
  });

  test("a helpful message, naming the actual token budget, when cut off at the length limit", () => {
    const message = describeEmptyReply("length", 100);
    expect(message).toBeDefined();
    expect(message).toContain("100");
    expect(message).toContain("Max tokens");
  });
});
