import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * The Decisions queue end to end over real HTTP — a real workspace link
 * through PATCH /api/project triggers a real scanAndReconcile (see
 * workspace.ts), which is what actually produces the suggestions this file
 * exercises. reconcile.ts's own unit tests already cover the matching logic
 * directly; this file is about the HTTP wrapper — status codes, accept
 * actually writing a card, and reject/hold not writing anything.
 */

let root: string;
let unityRoot: string;
let baseUrl: string;
let stop: () => void;

function write(rootDir: string, relPath: string, content = ""): void {
  const full = join(rootDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uassist-suggestions-http-"));
  const { store } = initProject(root, "SuggestionsHttpTest");
  store.close();

  unityRoot = mkdtempSync(join(tmpdir(), "uassist-suggestions-unity-"));
  mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
  write(unityRoot, "Assets/Prefabs/EnemyGrunt.prefab", "%YAML 1.1\n--- fake\n");

  const { server } = await startServer({ root, port: 58930 });
  baseUrl = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);

  const linkRes = await fetch(`${baseUrl}/api/project`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unityProjectPath: unityRoot }),
  });
  expect(linkRes.status).toBe(200);
});

afterAll(() => {
  stop?.();
  rmSync(root, { recursive: true, force: true });
  rmSync(unityRoot, { recursive: true, force: true });
});

describe("GET /api/suggestions", () => {
  test("linking a workspace with an unaccounted-for asset produced a pending suggestion", async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].kind).toBe("create_card");
    expect(body.suggestions[0].status).toBe("pending");
  });

  test("?status=accepted is empty before anything has been decided", async () => {
    const res = await fetch(`${baseUrl}/api/suggestions?status=accepted`);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
  });

  test("an invalid status is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/suggestions?status=bogus`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/suggestions/:id/reject and /hold", () => {
  test("reject moves it out of the pending queue without creating a card", async () => {
    // A second asset appearing after the initial link, picked up by an
    // explicit rescan — a second, independent suggestion, so this test
    // doesn't consume the "Enemy Grunt" one the accept test below needs.
    write(unityRoot, "Assets/Audio/klaxon.wav", "RIFF....");
    const rescan = await fetch(`${baseUrl}/api/workspace/scan`, { method: "POST" });
    expect(rescan.status).toBe(200);

    const list = await fetch(`${baseUrl}/api/suggestions`).then((r) => r.json());
    const target = list.suggestions.find((s: { payload: { title?: string } }) => s.payload.title === "Klaxon");
    expect(target).toBeDefined();

    const rejectRes = await fetch(`${baseUrl}/api/suggestions/${target.id}/reject`, { method: "POST" });
    expect(rejectRes.status).toBe(200);
    const rejected = await rejectRes.json();
    expect(rejected.suggestion.status).toBe("rejected");

    const cardsRes = await fetch(`${baseUrl}/api/cards`).then((r) => r.json());
    expect(cardsRes.cards.some((c: { title: string }) => c.title === "Klaxon")).toBe(false);
  });

  test("a decided suggestion cannot be decided again", async () => {
    const list = await fetch(`${baseUrl}/api/suggestions?status=rejected`).then((r) => r.json());
    const already = list.suggestions[0];
    const res = await fetch(`${baseUrl}/api/suggestions/${already.id}/hold`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("404s on an unknown suggestion id", async () => {
    const res = await fetch(`${baseUrl}/api/suggestions/suggestion_nonexistent/reject`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/suggestions/:id/accept", () => {
  test("accepting a create_card suggestion actually creates the card", async () => {
    const list = await fetch(`${baseUrl}/api/suggestions`).then((r) => r.json());
    const target = list.suggestions.find((s: { payload: { title?: string } }) => s.payload.title === "Enemy Grunt");
    expect(target).toBeDefined();

    const acceptRes = await fetch(`${baseUrl}/api/suggestions/${target.id}/accept`, { method: "POST" });
    expect(acceptRes.status).toBe(200);
    const accepted = await acceptRes.json();
    expect(accepted.suggestion.status).toBe("accepted");

    const cardsRes = await fetch(`${baseUrl}/api/cards`).then((r) => r.json());
    const card = cardsRes.cards.find((c: { title: string }) => c.title === "Enemy Grunt");
    expect(card).toBeDefined();
    expect(card.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/EnemyGrunt.prefab" });
  });
});
