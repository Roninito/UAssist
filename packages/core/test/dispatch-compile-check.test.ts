import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliAdapter } from "../src/adapters/cli.ts";
import { registerAdapter, unregisterAdapter } from "../src/adapters/registry.ts";
import { runJob, startJob, type JobEvent } from "../src/dispatch.ts";
import { importPlan } from "../src/plan/import.ts";
import { initProject, Store } from "../src/store.ts";
import type { Card } from "../src/types.ts";

/**
 * Exercises the exit gate stated in design/automation-spec.md Part II
 * verbatim: "a dispatched job's acceptance check runs a real Unity
 * batch-mode compile, not a guess from reading the diff." The Unity binary
 * itself is a fake script (deterministic, no license dependency) standing in
 * for the real one — the thing under test is dispatch.ts's own wiring
 * (maybeRunCompileCheck's preconditions, the job-state transition on
 * failure, the worktree-relative path math), not Unity itself, which
 * unity-verify.test.ts already covers directly including a live check
 * against the real installed binary.
 */

const AGENT_FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");

const dirs: string[] = [];
const originalUnityPath = process.env["UNITY_PATH"];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-compile-check-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  unregisterAdapter("fake");
  if (originalUnityPath === undefined) delete process.env["UNITY_PATH"];
  else process.env["UNITY_PATH"] = originalUnityPath;
});

/** A fake Unity binary: prints a canned log and exits with a given code —
 *  exactly the same fixture pattern unity-verify.test.ts uses. */
function fakeUnityBinary(dir: string, log: string, exitCode: number): string {
  const path = join(dir, "fake-unity.sh");
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${log}\nEOF\nexit ${exitCode}\n`, { mode: 0o755 });
  return path;
}

const CLEAN_LOG = `Reloading assemblies after fresh import\nExiting batchmode successfully now!`;
const ERROR_LOG = `Assets/Scripts/AmmoDatabase.cs(9,5): error CS1002: ; expected\nCompilation failed: 1 errors, 0 warnings`;

/** The Unity project lives *inside* the git repo at <root>/UnityProject —
 *  the one configuration maybeRunCompileCheck can actually verify, per its
 *  own doc comment. */
async function setupProject(): Promise<{ root: string; unityDir: string; store: Store; card: Card }> {
  const root = scratch();
  const { $ } = await import("bun");
  await $`git init -q`.cwd(root).quiet();
  await $`git config user.email test@example.com`.cwd(root).quiet();
  await $`git config user.name Test`.cwd(root).quiet();

  const unityDir = join(root, "UnityProject");
  mkdirSync(join(unityDir, "Assets"), { recursive: true });
  mkdirSync(join(unityDir, "ProjectSettings"), { recursive: true });
  writeFileSync(join(unityDir, "Assets", "AmmoDatabase.cs"), "class AmmoDatabase {}\n", "utf8");
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");

  await $`git add -A`.cwd(root).quiet();
  await $`git commit -q -m initial`.cwd(root).quiet();

  const { store } = initProject(root, "CompileCheckTest");
  importPlan(store, "## Phase 0 — Corridor\n\n- Add an Electric ammo type.\n\n**Exit gate.** Build runs.\n", "plan.md");
  const card = store.listCards().find((c) => c.title.includes("Electric ammo"))!;

  store.putCard({ ...card, anchor: { kind: "script", path: "AmmoDatabase.cs" } });

  return { root, unityDir, store, card: store.getCard(card.id)! };
}

function configureCliIntegration(store: Store, unityDir: string): void {
  const project = store.getProject()!;
  store.putProject({
    ...project,
    unityProjectPath: unityDir,
    engineIntegration: { unity: { method: "cli" } },
  });
}

/**
 * fake-agent.ts always writes agent-output.txt at the worktree root, not
 * inside any Unity subdirectory — `hasChanges` (checked before the compile
 * gate runs) is repo-wide regardless, and the fake Unity binary below
 * ignores project contents entirely (it just echoes a canned log), so this
 * is sufficient without needing the agent to target Assets/ specifically.
 */
function fakeAgentAdapter() {
  return createCliAdapter({
    id: "fake",
    capabilities: ["code.write"],
    command: process.execPath,
    buildArgs: () => ["run", AGENT_FIXTURE],
    stdin: (p) => p.objective,
  });
}

describe("compile-check gate — a real, if fake, Unity binary invoked from the worktree", () => {
  test("a clean compile lets the job through to returned, with the result logged", async () => {
    const { store, unityDir, card } = await setupProject();
    configureCliIntegration(store, unityDir);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), CLEAN_LOG, 0);
    registerAdapter(fakeAgentAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    const events: JobEvent[] = [];
    await runJob(store, started, (e) => events.push(e));

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("returned");
    expect(readFileSync(final.logPath, "utf8")).toContain("compile check: passed");

    store.close();
  });

  test("a compile failure rejects the job with the real CS error surfaced, not a generic message", async () => {
    const { store, unityDir, card } = await setupProject();
    configureCliIntegration(store, unityDir);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), ERROR_LOG, 1);
    registerAdapter(fakeAgentAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    const events: JobEvent[] = [];
    await runJob(store, started, (e) => events.push(e));

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("rejected");
    expect(final.attempts.at(-1)?.note).toContain("CS1002");
    expect(readFileSync(final.logPath, "utf8")).toContain("compile check: FAILED");

    // The worktree is preserved for inspection, same as any other failure.
    const { existsSync } = await import("node:fs");
    expect(existsSync(final.worktree)).toBe(true);

    store.close();
  });

  test("without CLI integration configured, the compile check is a no-op — no Unity spawn, no gate", async () => {
    const { store, card } = await setupProject();
    // Deliberately not calling configureCliIntegration — engineIntegration
    // stays unset, so the card's Unity anchor alone must not be enough to
    // trigger a Unity spawn.
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), ERROR_LOG, 1); // if this ran, the job would be rejected
    registerAdapter(fakeAgentAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("returned"); // not rejected — the fake error log was never consulted
    expect(readFileSync(final.logPath, "utf8")).not.toContain("compile check");

    store.close();
  });

  test("a non-Unity-anchored card skips the compile check even with CLI integration configured", async () => {
    const { store, unityDir, card } = await setupProject();
    configureCliIntegration(store, unityDir);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), ERROR_LOG, 1);
    store.putCard({ ...card, anchor: { kind: "commit", sha: "deadbeef" } }); // not a Unity-source anchor
    registerAdapter(fakeAgentAdapter());

    const started = await startJob(store, card, {
      agentId: "fake",
      budget: { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 },
    });
    await runJob(store, started, () => {});

    const final = store.getJob(started.job.id)!;
    expect(final.state).toBe("returned");

    store.close();
  });
});
