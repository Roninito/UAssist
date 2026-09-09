/**
 * The Decisions queue — see design/automation-spec.md Part IV.
 */

import {
  applySuggestion,
  ApplySuggestionError,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
} from "@uassist/core";
import { fail, json, oneOf, type Ctx } from "./api.ts";

// ---------------------------------------------------------------------------
// GET /api/suggestions
// ---------------------------------------------------------------------------

export function listSuggestions(ctx: Ctx, req: Request): Response {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  if (statusParam !== undefined) {
    const status = oneOf(statusParam, SUGGESTION_STATUSES);
    if (!status) {
      return fail(400, `status must be one of: ${SUGGESTION_STATUSES.join(", ")}`);
    }
    return json({ suggestions: ctx.store.listSuggestions({ status }), seq: ctx.store.lastSeq });
  }
  // No filter defaults to "pending" — the Decisions queue is a to-do list,
  // not a full history; ?status=accepted etc. is how the UI looks at the rest.
  return json({
    suggestions: ctx.store.listSuggestions({ status: "pending" as SuggestionStatus }),
    seq: ctx.store.lastSeq,
  });
}

// ---------------------------------------------------------------------------
// POST /api/suggestions/:id/accept, /reject, /hold
// ---------------------------------------------------------------------------

async function decide(ctx: Ctx, id: string, status: Exclude<SuggestionStatus, "pending">): Promise<Response> {
  const suggestion = ctx.store.getSuggestion(id);
  if (!suggestion) return fail(404, "no such suggestion");
  if (suggestion.status !== "pending") {
    return fail(409, `suggestion is already ${suggestion.status}`);
  }

  if (status === "accepted") {
    try {
      const result = applySuggestion(ctx.store, suggestion);
      ctx.bus.publish(
        result.created
          ? { kind: "cardCreated", seq: ctx.store.lastSeq, id: result.cardId }
          : { kind: "cardChanged", seq: ctx.store.lastSeq, id: result.cardId },
      );
    } catch (err) {
      // The write never happened — leave the suggestion pending so a human
      // decides what to do next, rather than silently marking it accepted
      // over a failed apply.
      const message = err instanceof ApplySuggestionError ? err.message : `apply failed: ${err instanceof Error ? err.message : String(err)}`;
      return fail(err instanceof ApplySuggestionError ? 409 : 500, message);
    }
  }

  const decided = ctx.store.decideSuggestion(id, status);
  if (!decided) return fail(404, "no such suggestion");

  ctx.bus.publish({ kind: "suggestionsChanged", seq: ctx.store.lastSeq });
  return json({ suggestion: decided, seq: ctx.store.lastSeq });
}

export async function postAcceptSuggestion(ctx: Ctx, id: string): Promise<Response> {
  return decide(ctx, id, "accepted");
}

export async function postRejectSuggestion(ctx: Ctx, id: string): Promise<Response> {
  return decide(ctx, id, "rejected");
}

export async function postHoldSuggestion(ctx: Ctx, id: string): Promise<Response> {
  return decide(ctx, id, "held");
}
