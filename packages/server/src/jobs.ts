/**
 * Agent dispatch: REST surface over packages/core/src/dispatch.ts.
 *
 * Dispatch and diff review are exactly the propose-then-apply discipline
 * from unity-assistant-spec.md Part IX: a job never touches the working
 * tree on its own. This module's job is turning that into HTTP — assembling
 * the request, streaming progress over the bus, and translating accept/
 * reject into the one-time merge or discard that worktree.ts performs.
 *
 * See design/uassist-spec.md Part IX, Part XI.
 */

import {
  acceptJob,
  BudgetExceededError,
  getJobDiff,
  listAdapterIds,
  NotAGitRepoError,
  rejectJob,
  runJob,
  startJob,
  type Budget,
  type Card,
  type Job,
  type JobState,
  type Status,
} from "@uassist/core";
import type { EventBus } from "./bus.ts";
import { fail, json, type Ctx } from "./api.ts";

/**
 * How a job's state reflects onto its card — Part IX's job-lifecycle table
 * in uassist-spec.md, applied automatically so the board never shows a card
 * sitting in `open` while its job is actually running.
 */
const CARD_STATUS_FOR_JOB_STATE: Partial<Record<JobState, Status>> = {
  dispatched: "active",
  running: "active",
  awaiting_answer: "blocked",
  returned: "review",
  review: "review",
  accepted: "done",
  rejected: "open",
};

function syncCardStatus(ctx: Ctx, card: Card, jobState: JobState): void {
  const nextStatus = CARD_STATUS_FOR_JOB_STATE[jobState];
  if (!nextStatus || card.status === nextStatus) return;
  const updated: Card = { ...card, status: nextStatus, version: card.version + 1, updatedAt: Date.now() };
  ctx.store.putCard(updated);
  ctx.bus.publish({ kind: "cardChanged", seq: ctx.store.lastSeq, id: card.id, fields: ["status"] });
}

// ---------------------------------------------------------------------------
// GET /api/adapters
// ---------------------------------------------------------------------------

export function getAdapters(): Response {
  return json({ adapters: listAdapterIds() });
}

// ---------------------------------------------------------------------------
// POST /api/cards/:id/dispatch
// ---------------------------------------------------------------------------

interface DispatchRequest {
  agentId: string;
  maxCostUsd: number;
  maxDurationMs: number;
  maxAttempts: number;
  objectiveOverride?: string;
}

function parseDispatchRequest(body: unknown): DispatchRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;

  if (typeof b["agentId"] !== "string" || b["agentId"].trim().length === 0) {
    return { error: "agentId must be a non-empty string" };
  }
  const num = (key: string, fallback: number): number | { error: string } => {
    const v = b[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { error: `${key} must be a non-negative number` };
    return v;
  };

  const maxCostUsd = num("maxCostUsd", 2);
  if (typeof maxCostUsd === "object") return maxCostUsd;
  const maxDurationMs = num("maxDurationMs", 10 * 60 * 1000);
  if (typeof maxDurationMs === "object") return maxDurationMs;
  const maxAttempts = num("maxAttempts", 1);
  if (typeof maxAttempts === "object") return maxAttempts;

  const objectiveOverride = b["objectiveOverride"];
  if (objectiveOverride !== undefined && typeof objectiveOverride !== "string") {
    return { error: "objectiveOverride must be a string" };
  }

  return { agentId: b["agentId"].trim(), maxCostUsd, maxDurationMs, maxAttempts, objectiveOverride };
}

export async function postDispatch(ctx: Ctx, cardId: string, req: Request): Promise<Response> {
  const card = ctx.store.getCard(cardId as Card["id"]);
  if (!card) return fail(404, "no such card");

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const parsed = parseDispatchRequest(body);
  if ("error" in parsed) return fail(400, parsed.error);

  if (!listAdapterIds().includes(parsed.agentId)) {
    return fail(400, `no such agent adapter: ${parsed.agentId} — one of: ${listAdapterIds().join(", ")}`);
  }

  const budget: Budget = {
    maxCostUsd: parsed.maxCostUsd,
    maxDurationMs: parsed.maxDurationMs,
    maxAttempts: parsed.maxAttempts,
  };

  let started;
  try {
    started = await startJob(ctx.store, card, {
      agentId: parsed.agentId,
      budget,
      objectiveOverride: parsed.objectiveOverride,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) return fail(402, err.message);
    if (err instanceof NotAGitRepoError) return fail(409, err.message);
    return fail(400, err instanceof Error ? err.message : String(err));
  }

  syncCardStatus(ctx, card, started.job.state);
  ctx.bus.publish({
    kind: "jobUpdated",
    seq: ctx.store.lastSeq,
    id: started.job.id,
    cardId: card.id,
    state: started.job.state,
  });

  void runJob(ctx.store, started, (event) => {
    switch (event.kind) {
      case "state": {
        const fresh = ctx.store.getCard(card.id);
        if (fresh) syncCardStatus(ctx, fresh, event.job.state);
        ctx.bus.publish({
          kind: "jobUpdated",
          seq: ctx.store.lastSeq,
          id: event.job.id,
          cardId: event.job.cardId,
          state: event.job.state,
        });
        break;
      }
      case "output":
        ctx.bus.publish({
          kind: "jobOutput",
          seq: ctx.store.lastSeq,
          id: event.jobId,
          cardId: card.id,
          text: event.text,
        });
        break;
      case "question":
        ctx.bus.publish({
          kind: "jobQuestion",
          seq: ctx.store.lastSeq,
          id: event.jobId,
          cardId: card.id,
          question: event.question,
          options: event.options,
        });
        break;
    }
  });

  return json({ job: started.job, seq: ctx.store.lastSeq }, 202);
}

// ---------------------------------------------------------------------------
// GET /api/cards/:id/jobs, GET /api/jobs/:id
// ---------------------------------------------------------------------------

export function listCardJobs(ctx: Ctx, cardId: string): Response {
  return json({ jobs: ctx.store.listJobsForCard(cardId as Card["id"]), seq: ctx.store.lastSeq });
}

export function getJob(ctx: Ctx, jobId: string): Response {
  const job = ctx.store.getJob(jobId as Job["id"]);
  if (!job) return fail(404, "no such job");
  return json({ job, seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/jobs/:id/diff
// ---------------------------------------------------------------------------

export async function getDiff(ctx: Ctx, jobId: string): Promise<Response> {
  const job = ctx.store.getJob(jobId as Job["id"]);
  if (!job) return fail(404, "no such job");
  if (job.state !== "returned" && job.state !== "review") {
    return fail(409, `job is ${job.state} — no diff to review yet`);
  }

  // First view moves review -> review is a no-op, but returned -> review
  // marks the transition from "ready" to "a human is looking at this now."
  if (job.state === "returned") {
    // Card status is already "review" from the returned→review card mapping
    // (see CARD_STATUS_FOR_JOB_STATE) — only the job record needs to move.
    const reviewing: Job = { ...job, state: "review", updatedAt: Date.now() };
    ctx.store.putJob(reviewing);
    ctx.bus.publish({ kind: "jobUpdated", seq: ctx.store.lastSeq, id: job.id, cardId: job.cardId, state: "review" });
  }

  try {
    const { diff, stat } = await getJobDiff(ctx.store, job);
    return json({ diff, stat, seq: ctx.store.lastSeq });
  } catch (err) {
    return fail(500, `could not compute diff: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/accept, POST /api/jobs/:id/reject
// ---------------------------------------------------------------------------

export async function postAccept(ctx: Ctx, jobId: string, req: Request): Promise<Response> {
  const job = ctx.store.getJob(jobId as Job["id"]);
  if (!job) return fail(404, "no such job");
  if (job.state !== "returned" && job.state !== "review") {
    return fail(409, `job is ${job.state} — nothing to accept`);
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Accept with no body is fine; a default commit message is used.
  }
  const commitMessage =
    typeof (body as { commitMessage?: unknown }).commitMessage === "string"
      ? (body as { commitMessage: string }).commitMessage
      : `Accept job ${job.id} for card ${job.cardId}`;

  let accepted: Job;
  try {
    accepted = await acceptJob(ctx.store, job, commitMessage);
  } catch (err) {
    return fail(500, `accept failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const card = ctx.store.getCard(job.cardId);
  if (card) syncCardStatus(ctx, card, "accepted");
  ctx.bus.publish({ kind: "jobUpdated", seq: ctx.store.lastSeq, id: accepted.id, cardId: accepted.cardId, state: "accepted" });

  return json({ job: accepted, seq: ctx.store.lastSeq });
}

export async function postReject(ctx: Ctx, jobId: string): Promise<Response> {
  const job = ctx.store.getJob(jobId as Job["id"]);
  if (!job) return fail(404, "no such job");
  if (job.state !== "returned" && job.state !== "review" && job.state !== "awaiting_answer") {
    return fail(409, `job is ${job.state} — nothing to reject`);
  }

  let rejected: Job;
  try {
    rejected = await rejectJob(ctx.store, job);
  } catch (err) {
    return fail(500, `reject failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const card = ctx.store.getCard(job.cardId);
  if (card) syncCardStatus(ctx, card, "rejected");
  ctx.bus.publish({ kind: "jobUpdated", seq: ctx.store.lastSeq, id: rejected.id, cardId: rejected.cardId, state: "rejected" });

  return json({ job: rejected, seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/ledger
// ---------------------------------------------------------------------------

export function getLedger(ctx: Ctx): Response {
  const project = ctx.store.getProject();
  return json({
    entries: ctx.store.listLedgerEntries(),
    totalToday: ctx.store.ledgerTotalToday(),
    totalAllTime: ctx.store.ledgerTotalAllTime(),
    dailyCapUsd: project?.dailyCapUsd,
    totalCapUsd: project?.totalCapUsd,
    seq: ctx.store.lastSeq,
  });
}
