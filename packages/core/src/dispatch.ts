/**
 * Job dispatch and execution.
 *
 * `startJob` is the synchronous-ish setup: assemble the packet, check the
 * cost cap, create the worktree, spawn the adapter. `runJob` is the
 * long-running consumption loop — it is meant to be started and left running
 * in the background (`void runJob(...)`), the same "fire and forget, stream
 * through events" shape `postChat` already uses for AI chat.
 *
 * Deliberately server-agnostic: nothing here imports the WebSocket bus. The
 * caller passes an `onEvent` callback and gets to decide what a "job event"
 * means to it — broadcast, log, both. That is what makes this testable
 * without a running HTTP server.
 *
 * See design/uassist-spec.md Part IX and Part XI (cost ledger).
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { getAdapter } from "./adapters/registry.ts";
import type { AgentEvent, JobHandle } from "./adapters/types.ts";
import { newId } from "./ids.ts";
import { anchorSource, assembleContextPacket } from "./packet.ts";
import type { Store } from "./store.ts";
import type { Budget, Card, Job, JobState } from "./types.ts";
import { findUnityBinary } from "./unity/bootstrap.ts";
import { runUnityCompileCheck, type CompileCheckResult } from "./unity/verify.ts";
import {
  acceptWorktree,
  computeDiff,
  createWorktree,
  hasChanges,
  removeWorktree,
  type DiffStat,
  type WorktreeInfo,
} from "./worktree.ts";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Hard stop at cap, checked before dispatch — Part XI: "dispatch is refused,
 * not throttled." Refusing says which cap and the current total, so the
 * error is actionable rather than a bare rejection.
 */
export function checkBudget(store: Store, requestedMaxCostUsd: number): void {
  const project = store.getProject();
  if (!project) throw new Error("no project — run `uassist init`");

  const today = store.ledgerTotalToday();
  if (today >= project.dailyCapUsd) {
    throw new BudgetExceededError(
      `daily cap reached: $${today.toFixed(2)} spent of $${project.dailyCapUsd.toFixed(2)}`,
    );
  }
  if (today + requestedMaxCostUsd > project.dailyCapUsd) {
    throw new BudgetExceededError(
      `this job's budget ($${requestedMaxCostUsd.toFixed(2)}) would exceed the daily cap ` +
        `($${today.toFixed(2)} spent of $${project.dailyCapUsd.toFixed(2)})`,
    );
  }

  const allTime = store.ledgerTotalAllTime();
  if (allTime >= project.totalCapUsd) {
    throw new BudgetExceededError(
      `total cap reached: $${allTime.toFixed(2)} spent of $${project.totalCapUsd.toFixed(2)}`,
    );
  }
}

export interface DispatchOptions {
  agentId: string;
  budget: Budget;
  objectiveOverride?: string;
}

export interface StartedJob {
  job: Job;
  worktreeInfo: WorktreeInfo;
  handle: JobHandle;
}

/** Assemble, budget-check, branch a worktree, and start the adapter. Does not
 *  consume any events — call `runJob` with the result to do that. */
export async function startJob(
  store: Store,
  card: Card,
  options: DispatchOptions,
): Promise<StartedJob> {
  checkBudget(store, options.budget.maxCostUsd);

  const adapter = getAdapter(options.agentId);
  if (!adapter) throw new Error(`no such agent adapter: ${options.agentId}`);

  const packet = assembleContextPacket(store, card, {
    objectiveOverride: options.objectiveOverride,
  });

  const jobId = newId("job");
  const worktreeInfo = await createWorktree(store.root, store.dir, jobId);

  const logDir = join(store.dir, "jobs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${jobId}.log`);

  const job: Job = {
    id: jobId,
    cardId: card.id,
    agent: options.agentId,
    state: "dispatched",
    packet,
    worktree: worktreeInfo.path,
    acceptance: card.acceptance.map((a) => a.text),
    budget: options.budget,
    attempts: [],
    costUsd: 0,
    logPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.putJob(job);

  writeMcpConfig(store, worktreeInfo.path);

  const handle = await adapter.dispatch(packet, worktreeInfo.path, options.budget);
  return { job, worktreeInfo, handle };
}

/**
 * Write a project-scoped `.mcp.json` into the worktree when any engine has
 * an MCP server configured — design/automation-spec.md Part II: "available
 * to ... MCP-capable agent adapters via the context packet." Claude Code
 * natively reads `.mcp.json` from its working directory, so this is deliberately
 * dispatch-level rather than adapter-specific: any MCP-aware CLI launched in
 * this worktree picks it up the same way, with no adapter code needed to
 * know engine integration exists at all.
 */
function writeMcpConfig(store: Store, worktreePath: string): void {
  const project = store.getProject();
  const integration = project?.engineIntegration;
  if (!integration) return;

  const servers: Record<string, { url: string }> = {};
  for (const [engine, config] of Object.entries(integration) as [string, { method: string; mcpServerUrl?: string }][]) {
    if (!config || (config.method !== "mcp" && config.method !== "both")) continue;
    if (!config.mcpServerUrl) continue;
    servers[engine] = { url: config.mcpServerUrl };
  }
  if (Object.keys(servers).length === 0) return;

  writeFileSync(
    join(worktreePath, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    "utf8",
  );
}

export type JobEvent =
  | { kind: "state"; job: Job }
  | { kind: "output"; jobId: string; text: string }
  | { kind: "question"; jobId: string; question: string; options?: string[] };

type CompileCheckOutcome =
  | ({ ran: true } & CompileCheckResult)
  | { ran: false };

/**
 * Run the real Unity compile check (design/automation-spec.md Part II) when
 * — and only when — every precondition holds:
 *
 *   1. CLI engine integration is configured for Unity ("cli" or "both").
 *   2. The card is Unity-anchored (a script, prefab, scene, or asset).
 *   3. A Unity Editor binary can be found on this machine.
 *   4. The Unity project lives *inside* this repo's own working tree.
 *
 * Condition 4 is the one worth explaining: worktree isolation (worktree.ts)
 * branches `store.root`'s own git repo — that is the entire mechanism. If
 * the Unity project is a separate repo entirely (a common real setup — most
 * studios keep the game repo and a coordination tool's state apart), the
 * agent's worktree contains no copy of it at all, edited or otherwise, and
 * there is nothing here to compile-check. Extending isolation to span a
 * second, independent repo is a real design question this function does not
 * attempt to answer — it degrades to a no-op instead of doing something
 * incorrect.
 */
async function maybeRunCompileCheck(
  store: Store,
  job: Job,
  worktreeInfo: { path: string },
): Promise<CompileCheckOutcome> {
  const project = store.getProject();
  const unityIntegration = project?.engineIntegration?.unity;
  if (!unityIntegration || (unityIntegration.method !== "cli" && unityIntegration.method !== "both")) {
    return { ran: false };
  }

  const card = store.getCard(job.cardId);
  if (!card || anchorSource(card) !== "unity") return { ran: false };

  if (!project?.unityProjectPath) return { ran: false };
  const rel = relative(store.root, project.unityProjectPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ran: false };

  const unityBinary = findUnityBinary();
  if (!unityBinary) return { ran: false };

  const result = await runUnityCompileCheck({
    unityBinary,
    projectPath: join(worktreeInfo.path, rel),
  });
  return { ran: true, ...result };
}

function compileCheckFailureNote(result: { ran: true } & CompileCheckResult): string {
  if (result.timedOut) return "compile check timed out";
  if (result.licenseFailed) return "compile check could not run: no Unity license on this machine";
  if (result.errors.length > 0) return `compile check failed: ${result.errors[0]}`;
  return `compile check failed: Unity exited ${result.exitCode}`;
}

/**
 * Consume an already-started job's event stream to completion. Meant to be
 * run detached (`void runJob(...)`) — the caller learns what happened through
 * `onEvent`, not through this function's return value, which resolves only
 * once the job reaches a terminal state.
 */
export async function runJob(
  store: Store,
  started: StartedJob,
  onEvent: (event: JobEvent) => void,
): Promise<void> {
  const { worktreeInfo, handle } = started;
  let job = started.job;

  const adapter = getAdapter(job.agent);
  if (!adapter) {
    job = { ...job, state: "rejected", updatedAt: Date.now() };
    store.putJob(job);
    onEvent({ kind: "state", job });
    return;
  }

  const project = store.getProject();
  const dailyCap = project?.dailyCapUsd ?? Number.POSITIVE_INFINITY;

  const setState = (state: JobState) => {
    job = { ...job, state, updatedAt: Date.now() };
    store.putJob(job);
    onEvent({ kind: "state", job });
  };

  setState("running");

  const appendLog = (text: string) => {
    try {
      appendFileSync(job.logPath, text.endsWith("\n") ? text : text + "\n", "utf8");
    } catch {
      // A log write failure must not take down the job itself.
    }
  };

  let cancelledForBudget = false;

  for await (const event of adapter.events(handle) as AsyncIterable<AgentEvent>) {
    switch (event.kind) {
      case "output":
        appendLog(event.text);
        onEvent({ kind: "output", jobId: job.id, text: event.text });
        break;

      case "cost": {
        job = { ...job, costUsd: job.costUsd + event.amountUsd, updatedAt: Date.now() };
        store.putJob(job);
        store.putLedgerEntry({
          id: newId("ledger"),
          jobId: job.id,
          cardId: job.cardId,
          agent: job.agent,
          amountUsd: event.amountUsd,
          durationMs: Date.now() - job.createdAt,
          at: Date.now(),
        });
        // Mid-flight enforcement — Part XI: a runaway job is killed, not
        // discovered afterward.
        if (!cancelledForBudget && store.ledgerTotalToday() > dailyCap) {
          cancelledForBudget = true;
          await adapter.cancel(handle);
          appendLog("[uassist] cancelled: daily cost cap exceeded mid-run");
        }
        break;
      }

      case "question":
        setState("awaiting_answer");
        onEvent({ kind: "question", jobId: job.id, question: event.question, options: event.options });
        break;

      case "done": {
        if (cancelledForBudget) {
          job = {
            ...job,
            attempts: [...job.attempts, { at: Date.now(), outcome: "cancelled", note: "budget cap exceeded" }],
          };
          store.putJob(job);
          setState("rejected");
          await removeWorktree(store.root, worktreeInfo);
          return;
        }

        if (event.timedOut) {
          job = {
            ...job,
            attempts: [...job.attempts, { at: Date.now(), outcome: "failed", note: "budget duration exceeded" }],
          };
          store.putJob(job);
          setState("rejected");
          await removeWorktree(store.root, worktreeInfo);
          return;
        }

        const changed = await hasChanges(worktreeInfo.path, worktreeInfo.baseSha);
        if (!changed) {
          job = {
            ...job,
            attempts: [...job.attempts, { at: Date.now(), outcome: "failed", note: "agent produced no changes" }],
          };
          store.putJob(job);
          setState("rejected");
          await removeWorktree(store.root, worktreeInfo);
          return;
        }

        if (event.exitCode !== 0) {
          job = {
            ...job,
            attempts: [...job.attempts, { at: Date.now(), outcome: "failed", note: `exited with code ${event.exitCode}` }],
          };
          store.putJob(job);
          setState("rejected");
          // Non-zero exit with changes present: leave the worktree so a
          // human can inspect what the agent did before it failed, rather
          // than destroying evidence. `uassist worktree prune` reclaims it
          // once reviewed.
          return;
        }

        // Real compile verification — design/automation-spec.md Part II, the
        // literal check the Four Gates doctrine asks for instead of a guess
        // from reading the diff. Silently a no-op unless CLI integration is
        // configured, the card is Unity-anchored, and the Unity project
        // lives inside this repo (see maybeRunCompileCheck's own doc comment
        // for why that last condition is required).
        const compileCheck = await maybeRunCompileCheck(store, job, worktreeInfo);
        if (compileCheck.ran) {
          appendLog(
            compileCheck.compiled
              ? "[uassist] compile check: passed"
              : `[uassist] compile check: FAILED\n${compileCheck.errors.join("\n") || compileCheckFailureNote(compileCheck)}`,
          );
          if (!compileCheck.compiled) {
            job = {
              ...job,
              attempts: [
                ...job.attempts,
                { at: Date.now(), outcome: "failed", note: compileCheckFailureNote(compileCheck) },
              ],
            };
            store.putJob(job);
            setState("rejected");
            // Preserved for inspection — same reasoning as a non-zero exit.
            return;
          }
        }

        job = {
          ...job,
          attempts: [...job.attempts, { at: Date.now(), outcome: "returned" }],
        };
        store.putJob(job);
        setState("returned");
        return;
      }
    }
  }
}

export interface JobDiff {
  diff: string;
  stat: DiffStat;
}

export async function getJobDiff(store: Store, job: Job): Promise<JobDiff> {
  // baseSha is not stored on Job directly; recovered from the worktree's own
  // branch point rather than adding a field only this call needs.
  const { $ } = await import("bun");
  const mergeBase = await $`git merge-base HEAD ${`uassist/${job.id}`}`.cwd(store.root).quiet();
  const baseSha = mergeBase.stdout.toString("utf8").trim();
  return computeDiff(job.worktree, baseSha);
}

/**
 * Neither `acceptWorktree` nor `removeWorktree` actually reads `baseSha` —
 * only path and branch matter to them (see worktree.ts). `getJobDiff` is the
 * one place that genuinely needs it, recovered there via `git merge-base`.
 * This placeholder keeps the WorktreeInfo shape without a wasted git call.
 */
function worktreeRefFor(job: Job): WorktreeInfo {
  return { path: job.worktree, branch: `uassist/${job.id}`, baseSha: "", createdAt: job.createdAt };
}

/** Accept: merge the worktree into the real working tree as one commit,
 *  advance the job and its card. Reject: discard the worktree, leave the
 *  working tree untouched — the entire point of isolation. */
export async function acceptJob(store: Store, job: Job, commitMessage: string): Promise<Job> {
  const { sha } = await acceptWorktree(store.root, worktreeRefFor(job), commitMessage);

  const accepted: Job = {
    ...job,
    state: "accepted",
    updatedAt: Date.now(),
    attempts: [...job.attempts, { at: Date.now(), outcome: "returned", note: `merged as ${sha.slice(0, 8)}` }],
  };
  store.putJob(accepted);
  return accepted;
}

export async function rejectJob(store: Store, job: Job): Promise<Job> {
  await removeWorktree(store.root, worktreeRefFor(job));

  const rejected: Job = { ...job, state: "rejected", updatedAt: Date.now() };
  store.putJob(rejected);
  return rejected;
}
