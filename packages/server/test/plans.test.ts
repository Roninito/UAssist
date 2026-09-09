import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * Exercises POST /api/plans/import as real HTTP against a real running
 * server — the core diff/merge logic already has thorough coverage in
 * packages/core/test/import.test.ts; this file is about the thin HTTP
 * wrapper: path validation, the dry-run/apply distinction, and that a
 * successful apply records planSourcePath for the web UI's "last imported
 * from" field.
 */

const PLAN = `## Phase 0 — Corridor

*2 weeks.*

- Custom 3D motor: walk and run.
- Cinemachine follow camera.

**Exit gate.** Build runs.
`;

let projectRoot: string;
let planPath: string;
let baseUrl: string;
let stop: () => void;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "uassist-plans-http-"));
  initProject(projectRoot, "PlansHttpTest").store.close();

  const planDir = mkdtempSync(join(tmpdir(), "uassist-plans-src-"));
  planPath = join(planDir, "plan.md");
  writeFileSync(planPath, PLAN, "utf8");

  const { server } = await startServer({ root: projectRoot, port: 58910 });
  baseUrl = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);
});

afterAll(() => {
  stop?.();
  rmSync(projectRoot, { recursive: true, force: true });
});

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/plans/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("POST /api/plans/import", () => {
  test("rejects a missing path field", async () => {
    const { status, json } = await post({});
    expect(status).toBe(400);
    expect(json.error).toContain("path");
  });

  test("rejects a path that does not exist", async () => {
    const { status, json } = await post({ path: "/definitely/not/a/real/file.md" });
    expect(status).toBe(404);
    expect(json.error).toContain("no such file");
  });

  test("a dry run reports the diff and writes nothing", async () => {
    const { status, json } = await post({ path: planPath, dryRun: true });
    expect(status).toBe(200);
    expect(json.applied).toBe(false);
    expect(json.addedCards.length).toBeGreaterThan(0);

    // This fixture project has no Unity/Blender path linked, so the
    // server's own self-healing setup cards (bootstrap.ts) are expected
    // here — sourceKey is what distinguishes a plan-imported card from
    // one of those, and a dry run must add none of the former.
    const cards = await fetch(`${baseUrl}/api/cards`).then((r) => r.json());
    expect(cards.cards.filter((c: { sourceKey?: string }) => c.sourceKey)).toHaveLength(0);
  });

  test("applying imports cards and records planSourcePath", async () => {
    const { status, json } = await post({ path: planPath, dryRun: false });
    expect(status).toBe(200);
    expect(json.applied).toBe(true);
    expect(json.fileName).toBe("plan.md");

    const cards = await fetch(`${baseUrl}/api/cards`).then((r) => r.json());
    expect(cards.cards.length).toBeGreaterThan(0);

    const project = await fetch(`${baseUrl}/api/project`).then((r) => r.json());
    expect(project.project.planSourcePath).toBe(planPath);
  });

  test("re-importing the same plan is a no-op diff", async () => {
    const { json } = await post({ path: planPath, dryRun: false });
    expect(json.addedCards).toHaveLength(0);
    expect(json.updatedCards).toHaveLength(0);
    expect(json.orphanedCards).toHaveLength(0);
  });
});
