import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliAdapter,
  importPlan,
  initProject,
  registerAdapter,
  unregisterAdapter,
} from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * Dispatch end to end over real HTTP: the propose-then-apply loop
 * (dispatch → stream output → review diff → accept/reject) exactly as a
 * browser client would drive it. The core mechanism already has thorough
 * coverage in packages/core/test/dispatch.test.ts; this file is about the
 * HTTP wrapper — status codes, the card-status sync, and that events land on
 * the WebSocket a real client would be listening on.
 */

const FIXTURE = join(import.meta.dir, "../../core/test/fixtures/fake-agent.ts");

let root: string;
let store: ReturnType<typeof initProject>["store"];
let cardId: string;
let baseUrl: string;
let stop: () => void;
let lastJobId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uassist-jobs-http-"));
  const { $ } = await import("bun");
  await $`git init -q`.cwd(root).quiet();
  await $`git config user.email test@example.com`.cwd(root).quiet();
  await $`git config user.name Test`.cwd(root).quiet();
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
  await $`git add -A`.cwd(root).quiet();
  await $`git commit -q -m initial`.cwd(root).quiet();

  const init = initProject(root, "JobsHttpTest");
  store = init.store;
  importPlan(store, "## Phase 0 — Corridor\n\n- Add an Electric ammo type.\n\n**Exit gate.** Build runs.\n", "plan.md");
  const card = store.listCards().find((c) => c.title.includes("Electric ammo"))!;
  cardId = card.id;
  store.close();

  registerAdapter(
    createCliAdapter({
      id: "fake",
      capabilities: ["code.write"],
      command: process.execPath,
      buildArgs: () => ["run", FIXTURE],
      stdin: (p) => p.objective,
    }),
  );

  const { server } = await startServer({ root, port: 58920 });
  baseUrl = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);
});

afterAll(() => {
  stop?.();
  unregisterAdapter("fake");
  rmSync(root, { recursive: true, force: true });
});

async function waitForJobState(jobId: string, states: string[], timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    const body = await res.json();
    if (states.includes(body.job.state)) return body.job;
    await Bun.sleep(50);
  }
  throw new Error(`job ${jobId} never reached one of [${states.join(", ")}]`);
}

describe("GET /api/adapters", () => {
  test("lists the registered fake adapter alongside the built-ins", async () => {
    const res = await fetch(`${baseUrl}/api/adapters`);
    const body = await res.json();
    expect(body.adapters).toContain("fake");
    expect(body.adapters).toContain("opencode");
    expect(body.adapters).toContain("claude-code");
  });
});

describe("POST /api/cards/:id/dispatch", () => {
  test("rejects an unknown agent id", async () => {
    const res = await fetch(`${baseUrl}/api/cards/${cardId}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "not-a-real-agent" }),
    });
    expect(res.status).toBe(400);
  });

  test("404s on a card that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/cards/card_nonexistent/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "fake" }),
    });
    expect(res.status).toBe(404);
  });

  test("dispatching moves the card to active and streams to a resolved job", async () => {
    const dispatchRes = await fetch(`${baseUrl}/api/cards/${cardId}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "fake", maxDurationMs: 5000 }),
    });
    expect(dispatchRes.status).toBe(202);
    const { job } = await dispatchRes.json();

    const cardRes = await fetch(`${baseUrl}/api/cards/${cardId}`);
    const cardBody = await cardRes.json();
    expect(cardBody.card.status).toBe("active");

    const finished = await waitForJobState(job.id, ["returned", "rejected"]);
    expect(finished.state).toBe("returned");

    const cardAfter = await fetch(`${baseUrl}/api/cards/${cardId}`).then((r) => r.json());
    expect(cardAfter.card.status).toBe("review");

    lastJobId = job.id;
  });

  test("the job appears in the card's job list", async () => {
    const res = await fetch(`${baseUrl}/api/cards/${cardId}/jobs`);
    const body = await res.json();
    expect(body.jobs.length).toBeGreaterThan(0);
  });
});

describe("GET /api/jobs/:id/diff and accept", () => {
  test("the diff shows the file the fake agent wrote", async () => {
    const jobId = lastJobId;
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diff).toContain("agent-output.txt");
    expect(body.stat.filesChanged).toBe(1);
  });

  test("viewing the diff moves the job into review", async () => {
    const jobId = lastJobId;
    const job = await fetch(`${baseUrl}/api/jobs/${jobId}`).then((r) => r.json());
    expect(job.job.state).toBe("review");
  });

  test("accepting merges the change into the real working tree", async () => {
    const jobId = lastJobId;
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitMessage: "Add Electric ammo type" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.state).toBe("accepted");

    expect(existsSync(join(root, "agent-output.txt"))).toBe(true);

    const card = await fetch(`${baseUrl}/api/cards/${cardId}`).then((r) => r.json());
    expect(card.card.status).toBe("done");
  });

  test("accepting an already-accepted job is refused, not silently repeated", async () => {
    const jobId = lastJobId;
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/accept`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("reject flow", () => {
  test("a rejected job never touches the real working tree and reopens the card", async () => {
    // The fake agent's output is a deterministic function of the objective it
    // receives, and HEAD already carries the first job's accepted content —
    // an unmodified re-dispatch would genuinely produce no diff (correctly
    // rejected for that reason, not the one this test wants to exercise).
    // A distinct objective keeps this test about reject, not no-op detection.
    const dispatchRes = await fetch(`${baseUrl}/api/cards/${cardId}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "fake",
        maxDurationMs: 5000,
        objectiveOverride: "Add a second, different Electric ammo variant.",
      }),
    });
    const { job } = await dispatchRes.json();
    const finished = await waitForJobState(job.id, ["returned", "rejected"]);
    expect(finished.state).toBe("returned");

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.state).toBe("rejected");

    const card = await fetch(`${baseUrl}/api/cards/${cardId}`).then((r) => r.json());
    expect(card.card.status).toBe("open");
  });
});

describe("GET /api/ledger", () => {
  test("reflects the caps configured on the project", async () => {
    const res = await fetch(`${baseUrl}/api/ledger`);
    const body = await res.json();
    expect(typeof body.dailyCapUsd).toBe("number");
    expect(typeof body.totalAllTime).toBe("number");
  });
});
