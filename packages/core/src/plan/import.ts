/**
 * Plan import and re-ingest.
 *
 * Computes a structural diff between a parsed plan and current state, then
 * applies it. Cards with history are never silently deleted — they are
 * reported as orphaned and left for a human decision.
 *
 * See design/uassist-spec.md Part V.
 */

import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";

import type { Card, Milestone } from "../types.ts";
import type { Store } from "../store.ts";
import { parsePlan, type ParsedPlan } from "./parse.ts";
import { titleSimilarity } from "./sourceKey.ts";

/** Below this, two titles are different tasks rather than a rename. */
export const RENAME_THRESHOLD = 0.6;

export interface PlanDiff {
  addedMilestones: Milestone[];
  updatedMilestones: { from: Milestone; to: Milestone }[];
  addedCards: Card[];
  updatedCards: { from: Card; to: Card }[];
  renamedCards: { from: Card; to: Card; similarity: number }[];
  /** In the store, absent from the plan. Never auto-deleted. */
  orphanedCards: Card[];
  warnings: string[];
}

export interface ImportResult extends PlanDiff {
  applied: boolean;
  planPath?: string;
}

function summarizeCard(c: Card): string {
  return JSON.stringify([
    c.title,
    c.milestoneId,
    c.category,
    c.subsystem ?? null,
    c.kind,
    c.acceptance.map((a) => a.text),
  ]);
}

function summarizeMilestone(m: Milestone): string {
  return JSON.stringify([
    m.title,
    m.phaseNumber ?? null,
    m.description,
    m.timebox ?? null,
    m.gateCondition ?? null,
    m.demoCondition ?? null,
  ]);
}

/**
 * Carry forward everything a human or an agent changed, taking only the
 * plan-derived fields from the freshly parsed card.
 *
 * This is what makes re-ingest safe: re-importing an edited plan must not
 * reset a card that someone moved to `active` or assigned to an agent.
 */
function mergeCard(existing: Card, parsed: Card): Card {
  return {
    ...existing,
    title: parsed.title,
    description: parsed.description ?? existing.description,
    milestoneId: parsed.milestoneId,
    category: existing.category !== "Unknown" ? existing.category : parsed.category,
    subsystem: parsed.subsystem ?? existing.subsystem,
    kind: parsed.kind,
    source: parsed.source,
    sourceKey: parsed.sourceKey,
    // Preserve which criteria are already met, matched on text.
    acceptance: parsed.acceptance.map((criterion) => {
      const prior = existing.acceptance.find((a) => a.text === criterion.text);
      return prior ? { ...criterion, met: prior.met, verifiedBy: prior.verifiedBy } : criterion;
    }),
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
}

function mergeMilestone(existing: Milestone, parsed: Milestone): Milestone {
  return {
    ...existing,
    title: parsed.title,
    phaseNumber: parsed.phaseNumber,
    description: parsed.description,
    timebox: parsed.timebox ?? existing.timebox,
    gateCondition: parsed.gateCondition,
    demoCondition: parsed.demoCondition,
    source: parsed.source,
    sourceKey: parsed.sourceKey,
    updatedAt: Date.now(),
  };
}

/** Compute the diff without touching the store. */
export function diffPlan(store: Store, plan: ParsedPlan): PlanDiff {
  const diff: PlanDiff = {
    addedMilestones: [],
    updatedMilestones: [],
    addedCards: [],
    updatedCards: [],
    renamedCards: [],
    orphanedCards: [],
    warnings: [...plan.warnings],
  };

  // --- milestones -----------------------------------------------------------
  // Parsed cards point at freshly minted milestone ids. Where a milestone
  // already exists, remap so cards keep landing in the right lane.
  const milestoneIdRemap = new Map<string, string>();

  for (const parsed of plan.milestones) {
    const existing = parsed.sourceKey
      ? store.findMilestoneBySourceKey(parsed.sourceKey)
      : undefined;
    if (!existing) {
      diff.addedMilestones.push(parsed);
      continue;
    }
    milestoneIdRemap.set(parsed.id, existing.id);
    const merged = mergeMilestone(existing, parsed);
    if (summarizeMilestone(existing) !== summarizeMilestone(merged)) {
      diff.updatedMilestones.push({ from: existing, to: merged });
    }
  }

  const remap = (card: Card): Card => {
    if (!card.milestoneId) return card;
    const mapped = milestoneIdRemap.get(card.milestoneId);
    return mapped ? { ...card, milestoneId: mapped as Card["milestoneId"] } : card;
  };

  // --- cards ----------------------------------------------------------------
  const matchedExisting = new Set<string>();
  const unmatchedParsed: Card[] = [];

  for (const raw of plan.cards) {
    const parsed = remap(raw);
    const existing = parsed.sourceKey
      ? store.findCardBySourceKey(parsed.sourceKey)
      : undefined;
    if (!existing) {
      unmatchedParsed.push(parsed);
      continue;
    }
    matchedExisting.add(existing.id);
    const merged = mergeCard(existing, parsed);
    if (summarizeCard(existing) !== summarizeCard(merged)) {
      diff.updatedCards.push({ from: existing, to: merged });
    }
  }

  // Anything imported before, still in the store, that this parse did not
  // claim by source key. Candidates for rename or orphan.
  const candidates = store
    .listCards()
    .filter((c) => c.sourceKey !== undefined && !matchedExisting.has(c.id));

  const claimed = new Set<string>();
  for (const parsed of unmatchedParsed) {
    let best: { card: Card; score: number } | undefined;
    for (const candidate of candidates) {
      if (claimed.has(candidate.id)) continue;
      // A rename stays inside its milestone; across lanes it is a new card.
      if (candidate.milestoneId !== parsed.milestoneId) continue;
      if (candidate.kind !== parsed.kind) continue;
      const score = titleSimilarity(candidate.title, parsed.title);
      if (score >= RENAME_THRESHOLD && (!best || score > best.score)) {
        best = { card: candidate, score };
      }
    }
    if (best) {
      claimed.add(best.card.id);
      diff.renamedCards.push({
        from: best.card,
        to: mergeCard(best.card, parsed),
        similarity: best.score,
      });
    } else {
      diff.addedCards.push(parsed);
    }
  }

  diff.orphanedCards = candidates.filter((c) => !claimed.has(c.id));
  return diff;
}

export interface ImportOptions {
  /** Compute the diff and report it without writing anything. */
  dryRun?: boolean;
}

export function importPlan(
  store: Store,
  markdown: string,
  sourceFile: string,
  options: ImportOptions = {},
): ImportResult {
  const plan = parsePlan(markdown, basename(sourceFile));
  const diff = diffPlan(store, plan);

  if (options.dryRun) {
    return { ...diff, applied: false };
  }

  for (const m of diff.addedMilestones) store.putMilestone(m, { event: false });
  for (const { to } of diff.updatedMilestones) store.putMilestone(to, { event: false });
  for (const c of diff.addedCards) store.putCard(c, { event: false });
  for (const { to } of diff.updatedCards) store.putCard(to, { event: false });
  for (const { to } of diff.renamedCards) store.putCard(to, { event: false });

  // Retain the source verbatim so the next import diffs against known text.
  const planPath = join(store.dir, "plans", basename(sourceFile));
  writeFileSync(planPath, markdown, "utf8");

  store.appendEvent("planImported", {
    file: basename(sourceFile),
    addedMilestones: diff.addedMilestones.length,
    updatedMilestones: diff.updatedMilestones.length,
    added: diff.addedCards.length,
    updated: diff.updatedCards.length,
    renamed: diff.renamedCards.length,
    orphaned: diff.orphanedCards.length,
  });
  store.mirror.flush();

  return { ...diff, applied: true, planPath };
}
