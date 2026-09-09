import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importPlan, initProject } from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * POST /api/validate over real HTTP. validate.ts's own unit tests already
 * cover the check logic directly (packages/core/test/validate.test.ts);
 * this file is about the HTTP wrapper — that it actually writes health
 * items reachable from GET /api/health, and that a fixed condition closes.
 */

let root: string;
let baseUrl: string;
let stop: () => void;
let cardId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uassist-validate-http-"));
  const { store } = initProject(root, "ValidateHttpTest");
  importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
  const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
  cardId = card.id;
  // Anchored to a file that was never scanned into the catalog — a real,
  // deterministic broken anchor without needing a fake Unity binary at all.
  store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/DoesNotExist.cs" } });
  store.close();

  const { server } = await startServer({ root, port: 58940 });
  baseUrl = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);
});

afterAll(() => {
  stop?.();
  rmSync(root, { recursive: true, force: true });
});

// This fixture has no Unity/Blender path linked at all, so
// checkWorkspaceIncomplete (validate.ts) also fires here on every run,
// alongside whatever this file is actually testing — assertions below
// filter to the broken-anchor item specifically rather than assume it's
// the only thing in `created`/`health`.
function brokenAnchorItems(items: { source: string; cardId?: string }[]) {
  return items.filter((h) => h.source === "broken_anchor");
}

describe("POST /api/validate", () => {
  test("finds the broken anchor and writes a reachable health item", async () => {
    const res = await fetch(`${baseUrl}/api/validate`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    const created = brokenAnchorItems(body.created);
    expect(created).toHaveLength(1);
    expect(created[0].cardId).toBe(cardId);
    expect(body.health.length).toBeGreaterThanOrEqual(1);

    const healthRes = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    expect(healthRes.health.some((h: { cardId?: string }) => h.cardId === cardId)).toBe(true);
  });

  test("re-running with nothing fixed does not duplicate the item", async () => {
    const before = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    await fetch(`${baseUrl}/api/validate`, { method: "POST" });
    const after = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    expect(after.health.length).toBe(before.health.length);
  });

  test("fixing the anchor closes the item on the next run", async () => {
    const patchRes = await fetch(`${baseUrl}/api/cards/${cardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: { kind: "commit", sha: "deadbeef" } }),
    });
    expect(patchRes.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/validate`, { method: "POST" });
    const body = await res.json();
    expect(body.closed).toBeGreaterThanOrEqual(1);
    expect(body.health.some((h: { cardId?: string }) => h.cardId === cardId)).toBe(false);
  });
});
