import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliAdapter } from "../src/adapters/cli.ts";
import { registerAdapter, unregisterAdapter } from "../src/adapters/registry.ts";
import {
  acceptJob,
  BudgetExceededError,
  checkBudget,
  getJobDiff,
  rejectJob,
  runJob,
  startJob,
  type JobEvent,
} from "../src/dispatch.ts";
import { importPlan } from "../src/plan/import.ts";
import { initProject, Store } from "../src/store.ts";
import type { Card } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-dispatch-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  unregisterAdapter("fake");
});

/** A real git repo AND a real UAssist project in the same directory — a
 *  dispatch needs both: git for worktrees, .uassist/ for the store. */
async function setupProject(): Promise<{ root: string; store: Store; card: Card }> {
  const root = scratch();
  const { $ } = await import("bun");
  await $`git init -q`.cwd(root).quiet();
  await $`git config user.email test@example.com`.cwd(root).quiet();
  await $`git config user.name Test`.cwd(root).quiet();
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
  await $`git add -A`.cwd(root).quiet();
  await $`git commit -q -m initial`.cwd(root).quiet();

  const { store } = initProject(root, "DispatchTest");
  importPlan(
    store,
    "## Phase 0 — Corridor\n\n- Add an Electric ammo type.\n\n**Exit gate.** Build runs.\n",
    "plan.md",
  );
  const card = store.listCards().find((c) => c.title.includes("Electric ammo"))!;
  return { root, store, card };
}

/** --fail makes the fixture exit 1 after writing a file, so a job can be
 *  driven into every terminal state a test needs. */
function fakeAdapter(extraArgs: string[] = []) {
  return createCliAdapter({
    id: "fake",
    capabilities: ["code.write"],
    command: process.execPath,
    buildArgs: () => ["run", FIXTURE, ...extraArgs],
    stdin: (p) => p.objective,
  });
}

describe("checkBudget", () => {
  test("allows dispatch when nothing has been spent", () => {
    const { store } = (() => {
      const root = scratch();
      return initProject(root, "BudgetTest");
    })();
    expect(() => checkBudget(store, 1)).not.toThrow();
    store.close();
  });

  test("refuses a job whose own budget would exceed the daily cap", () => {
    const root = scratch();
    const { store, project } = initProject(root, "BudgetTest2");
    store.putProject({ ...project, dailyCapUsd: 5 });
    expect(() => checkBudget(store, 10)).toThrow(BudgetExceededError);
    store.close();
  });

  test("refuses outright once the daily cap is already spent", () => {
    const root = scratch();
    const { store, project } = initProject(root, "BudgetTest3");
    store.putProject({ ...project, dailyCapUsd: 1 });
    store.putLedgerEntry({
      id: "l1",
      jobId: "job_x" as never,
      cardId: "card_x" as never,
      agent: "fake",
      amountUsd: 1,
      durationMs: 100,
      at: Date.now(),
    });
    expect(() => checkBudget(store, 0.01)).toThrow(BudgetExceededError);
    store.close();
  });
});

describe("startJob → runJob (full lifecycle)", () => {
  test("a successful run grounds the packet, streams output, and returns for review", async () => {
    const { root, store, card } = await setupProject();
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });

    // The packet is grounded on the card's anchor, or absent when there is
    // none — this card has no anchor (nothing scanned it), so files/[] is
    // itself a meaningful assertion: dispatch never invents a path.
    expect(started.job.packet.objective).toContain("Electric ammo");

    const events: JobEvent[] = [];
    await runJob(store, started, (e) => events.push(e));

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("returned");
    expect(final.attempts.at(-1)?.outcome).toBe("returned");

    expect(events.some((e) => e.kind === "output")).toBe(true);
    expect(existsSync(final.logPath)).toBe(true);
    expect(readFileSync(final.logPath, "utf8")).toContain("received objective");

    // The real repo's working tree was never touched — only the worktree.
    expect(existsSync(join(root, "agent-output.txt"))).toBe(false);
    expect(existsSync(join(final.worktree, "agent-output.txt"))).toBe(true);

    store.close();
  });

  test("accepting a returned job merges it into the real working tree", async () => {
    const { root, store, card } = await setupProject();
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const returned = store.getJob(started.job.id)!;
    const { diff, stat } = await getJobDiff(store, returned);
    expect(diff).toContain("agent-output.txt");
    expect(stat.filesChanged).toBe(1);

    const accepted = await acceptJob(store, returned, "Add Electric ammo type");
    expect(accepted.state).toBe("accepted");
    expect(existsSync(join(root, "agent-output.txt"))).toBe(true);
    expect(existsSync(returned.worktree)).toBe(false);

    store.close();
  });

  test("rejecting a returned job discards the worktree and never touches the real tree", async () => {
    const { root, store, card } = await setupProject();
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const returned = store.getJob(started.job.id)!;
    const rejected = await rejectJob(store, returned);

    expect(rejected.state).toBe("rejected");
    expect(existsSync(join(root, "agent-output.txt"))).toBe(false);
    expect(existsSync(returned.worktree)).toBe(false);

    store.close();
  });

  test("an agent exiting non-zero is rejected, and its worktree is preserved for inspection", async () => {
    const { store, card } = await setupProject();
    registerAdapter(fakeAdapter(["--fail"]));

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("rejected");
    expect(final.attempts.at(-1)?.note).toContain("exited with code 1");
    // Preserved, not cleaned up automatically — a human can inspect a
    // failure before it's pruned.
    expect(existsSync(final.worktree)).toBe(true);

    store.close();
  });

  test("an agent that produces no changes is rejected with a clear reason", async () => {
    const { store, card } = await setupProject();
    // No FIXTURE args write nothing — reuse a trivial inline adapter that
    // exits immediately with no file writes.
    registerAdapter(
      createCliAdapter({
        id: "fake",
        capabilities: [],
        command: process.execPath,
        buildArgs: () => ["-e", "process.exit(0)"],
        stdin: () => undefined,
      }),
    );

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("rejected");
    expect(final.attempts.at(-1)?.note).toContain("no changes");

    store.close();
  });

  test("a job that hangs past its budget is killed and rejected, not left running", async () => {
    const { store, card } = await setupProject();
    registerAdapter(fakeAdapter(["--hang"]));

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 300, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("rejected");
    expect(final.attempts.at(-1)?.note).toContain("duration");

    store.close();
  });

  test("dispatch refuses to start when the budget would already exceed the cap", async () => {
    const { store, project, card } = await (async () => {
      const base = await setupProject();
      return { ...base, project: base.store.getProject()! };
    })();
    store.putProject({ ...project, dailyCapUsd: 0.001 });
    registerAdapter(fakeAdapter());

    await expect(
      startJob(store, card, {
        agentId: "fake",
        budget: { maxCostUsd: 5, maxDurationMs: 0, maxAttempts: 1 },
      }),
    ).rejects.toThrow(BudgetExceededError);

    store.close();
  });
});

describe("writeMcpConfig — .mcp.json written into the worktree", () => {
  test("no engineIntegration configured: no .mcp.json at all", async () => {
    const { store, card } = await setupProject();
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });

    expect(existsSync(`${started.worktreeInfo.path}/.mcp.json`)).toBe(false);

    await rejectJob(store, started.job);
    store.close();
  });

  test("an MCP-configured engine gets a real .mcp.json Claude Code can read", async () => {
    const { store, card } = await setupProject();
    const project = store.getProject()!;
    store.putProject({
      ...project,
      engineIntegration: {
        unity: { method: "mcp", mcpServerUrl: "http://127.0.0.1:9999/mcp" },
      },
    });
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });

    const config = JSON.parse(readFileSync(`${started.worktreeInfo.path}/.mcp.json`, "utf8"));
    expect(config.mcpServers.unity.url).toBe("http://127.0.0.1:9999/mcp");

    await rejectJob(store, started.job);
    store.close();
  });

  test('method "cli" (not mcp or both) writes no config for that engine', async () => {
    const { store, card } = await setupProject();
    const project = store.getProject()!;
    store.putProject({
      ...project,
      engineIntegration: { unity: { method: "cli" } },
    });
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });

    expect(existsSync(`${started.worktreeInfo.path}/.mcp.json`)).toBe(false);

    await rejectJob(store, started.job);
    store.close();
  });

  test('method "both" writes a config alongside the CLI path being usable too', async () => {
    const { store, card } = await setupProject();
    const project = store.getProject()!;
    store.putProject({
      ...project,
      engineIntegration: {
        unity: { method: "both", mcpServerUrl: "http://127.0.0.1:9999/mcp" },
      },
    });
    registerAdapter(fakeAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });

    const config = JSON.parse(readFileSync(`${started.worktreeInfo.path}/.mcp.json`, "utf8"));
    expect(config.mcpServers.unity.url).toBe("http://127.0.0.1:9999/mcp");

    await rejectJob(store, started.job);
    store.close();
  });
});
