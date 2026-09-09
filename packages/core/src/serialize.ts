/**
 * Deterministic JSON serialization for the git-tracked mirror.
 *
 * Byte-stable output requires more than JSON.stringify: keys go in a declared
 * order (never Object.keys order), id arrays are sorted, undefined fields are
 * omitted rather than written as null, and every file ends with a newline.
 *
 * See design/uassist-spec.md Part IV.
 */

import type { Asset, Card, HealthItem, Job, Milestone, Project, Suggestion } from "./types.ts";

/** Fields in write order. Anything not listed is dropped from the mirror. */
export const CARD_KEY_ORDER = [
  "id",
  "title",
  "description",
  "milestoneId",
  "category",
  "subsystem",
  "kind",
  "status",
  "priority",
  "assignee",
  "owner",
  "estimate",
  "timeSpentHours",
  "anchor",
  "source",
  "sourceKey",
  "dependencies",
  "blockedBy",
  "related",
  "acceptance",
  "tags",
  "version",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Card)[];

export const MILESTONE_KEY_ORDER = [
  "id",
  "title",
  "phaseNumber",
  "description",
  "timebox",
  "gateCondition",
  "demoCondition",
  "status",
  "source",
  "sourceKey",
  "startDate",
  "targetDate",
  "completedDate",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Milestone)[];

export const ASSET_KEY_ORDER = [
  "id",
  "name",
  "kind",
  "stage",
  "sourceFile",
  "engineFile",
  "provenance",
  "licence",
  "tags",
  "variants",
  "dependents",
  "derivedFrom",
  "previews",
  "version",
  "lastExportedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Asset)[];

export const JOB_KEY_ORDER = [
  "id",
  "cardId",
  "agent",
  "state",
  "packet",
  "worktree",
  "acceptance",
  "budget",
  "attempts",
  "costUsd",
  "logPath",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Job)[];

export const HEALTH_KEY_ORDER = [
  "id",
  "severity",
  "source",
  "fingerprint",
  "message",
  "anchor",
  "cardId",
  "autoClose",
  "resolved",
  "firstSeenAt",
  "lastSeenAt",
] as const satisfies readonly (keyof HealthItem)[];

export const PROJECT_KEY_ORDER = [
  "id",
  "name",
  "rootPath",
  "unityProjectPath",
  "blenderSourcePath",
  "workspaceScannedAt",
  "planSourcePath",
  "conventions",
  "dailyCapUsd",
  "totalCapUsd",
  "aiConfig",
  "engineIntegration",
  "scanSchedule",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Project)[];

export const SUGGESTION_KEY_ORDER = [
  "id",
  "kind",
  "source",
  "rationale",
  "payload",
  "fingerprint",
  "relatedCardId",
  "status",
  "createdAt",
  "decidedAt",
] as const satisfies readonly (keyof Suggestion)[];

/** Arrays of ids that must be sorted before writing, so order never churns. */
const SORTED_ARRAY_KEYS = new Set([
  "dependencies",
  "blockedBy",
  "related",
  "variants",
  "dependents",
  "derivedFrom",
  "tags",
]);

function orderValue(key: string, value: unknown): unknown {
  if (SORTED_ARRAY_KEYS.has(key) && Array.isArray(value)) {
    return [...(value as string[])].sort();
  }
  return value;
}

/**
 * Project a record onto its declared key order, dropping undefined fields.
 *
 * Omitting rather than nulling matters: a card that never had a description
 * and a card whose description was cleared should produce the same bytes.
 */
export function orderKeys<T extends object>(
  record: T,
  keyOrder: readonly (keyof T & string)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keyOrder) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = orderValue(key, value);
  }
  return out;
}

/** Two-space indent, trailing newline. The only serializer the mirror uses. */
export function stableStringify<T extends object>(
  record: T,
  keyOrder: readonly (keyof T & string)[],
): string {
  return JSON.stringify(orderKeys(record, keyOrder), null, 2) + "\n";
}

export const serializeCard = (c: Card) => stableStringify(c, CARD_KEY_ORDER);
export const serializeMilestone = (m: Milestone) =>
  stableStringify(m, MILESTONE_KEY_ORDER);
export const serializeAsset = (a: Asset) => stableStringify(a, ASSET_KEY_ORDER);
export const serializeJob = (j: Job) => stableStringify(j, JOB_KEY_ORDER);
export const serializeHealthItem = (h: HealthItem) =>
  stableStringify(h, HEALTH_KEY_ORDER);
export const serializeProject = (p: Project) =>
  stableStringify(p, PROJECT_KEY_ORDER);
export const serializeSuggestion = (s: Suggestion) =>
  stableStringify(s, SUGGESTION_KEY_ORDER);
