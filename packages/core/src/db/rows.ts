/**
 * Row ↔ record mapping.
 *
 * SQLite holds scalars in columns and everything structured as JSON text.
 * These functions are the only place that knows which is which.
 */

import type {
  AcceptanceCriterion,
  Anchor,
  Assignee,
  AiConfig,
  Attempt,
  Budget,
  Card,
  Category,
  CardKind,
  ChatMessage,
  ChatThread,
  ContextPacket,
  DocThread,
  EngineIntegrationConfig,
  Estimate,
  HealthItem,
  Job,
  JobState,
  LedgerEntry,
  Milestone,
  MilestoneStatus,
  Priority,
  Project,
  ScanScheduleConfig,
  Severity,
  SourceRange,
  Status,
  Suggestion,
  SuggestionKind,
  SuggestionSource,
  SuggestionStatus,
} from "../types.ts";
import { anchorPath } from "../types.ts";
import type { CardId, HealthItemId, JobId, MilestoneId, ProjectId } from "../ids.ts";

const j = (v: unknown): string => JSON.stringify(v);
const p = <T>(v: string | null, fallback: T): T =>
  v === null ? fallback : (JSON.parse(v) as T);
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const jOrNull = (v: unknown): string | null =>
  v === undefined ? null : JSON.stringify(v);
const undef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardRow {
  id: string;
  title: string;
  description: string | null;
  milestone_id: string | null;
  category: string;
  subsystem: string | null;
  kind: string;
  status: string;
  priority: string;
  assignee: string;
  owner: string | null;
  estimate: string | null;
  time_spent: number;
  anchor: string | null;
  anchor_kind: string | null;
  anchor_path: string | null;
  source: string | null;
  source_key: string | null;
  acceptance: string;
  tags: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export function cardToRow(c: Card): CardRow {
  const anchor = c.anchor;
  return {
    id: c.id,
    title: c.title,
    description: orNull(c.description),
    milestone_id: orNull(c.milestoneId),
    category: c.category,
    subsystem: orNull(c.subsystem),
    kind: c.kind,
    status: c.status,
    priority: c.priority,
    assignee: j(c.assignee),
    owner: orNull(c.owner),
    estimate: jOrNull(c.estimate),
    time_spent: c.timeSpentHours,
    anchor: jOrNull(anchor),
    anchor_kind: anchor ? anchor.kind : null,
    anchor_path: anchor ? anchorPath(anchor) : null,
    source: jOrNull(c.source),
    source_key: orNull(c.sourceKey),
    acceptance: j(c.acceptance),
    tags: j(c.tags),
    version: c.version,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/**
 * Link arrays live in card_links, so they are supplied separately rather than
 * read off the row — the caller joins them in one query for the whole set.
 */
export function rowToCard(
  r: CardRow,
  links: { dependencies: CardId[]; blockedBy: CardId[]; related: CardId[] },
): Card {
  return {
    id: r.id as CardId,
    title: r.title,
    description: undef(r.description),
    milestoneId: undef(r.milestone_id) as MilestoneId | undefined,
    category: r.category as Category,
    subsystem: undef(r.subsystem),
    kind: r.kind as CardKind,
    status: r.status as Status,
    priority: r.priority as Priority,
    assignee: JSON.parse(r.assignee) as Assignee,
    owner: undef(r.owner),
    estimate: r.estimate === null ? undefined : (JSON.parse(r.estimate) as Estimate),
    timeSpentHours: r.time_spent,
    anchor: r.anchor === null ? undefined : (JSON.parse(r.anchor) as Anchor),
    source: r.source === null ? undefined : (JSON.parse(r.source) as SourceRange),
    sourceKey: undef(r.source_key),
    dependencies: links.dependencies,
    blockedBy: links.blockedBy,
    related: links.related,
    acceptance: p<AcceptanceCriterion[]>(r.acceptance, []),
    tags: p<string[]>(r.tags, []),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Milestone
// ---------------------------------------------------------------------------

export interface MilestoneRow {
  id: string;
  title: string;
  phase_number: number | null;
  description: string;
  timebox: string | null;
  gate_condition: string | null;
  demo_condition: string | null;
  status: string;
  source: string | null;
  source_key: string | null;
  start_date: number | null;
  target_date: number | null;
  completed_date: number | null;
  created_at: number;
  updated_at: number;
}

export function milestoneToRow(m: Milestone): MilestoneRow {
  return {
    id: m.id,
    title: m.title,
    phase_number: orNull(m.phaseNumber),
    description: m.description,
    timebox: jOrNull(m.timebox),
    gate_condition: orNull(m.gateCondition),
    demo_condition: orNull(m.demoCondition),
    status: m.status,
    source: jOrNull(m.source),
    source_key: orNull(m.sourceKey),
    start_date: orNull(m.startDate),
    target_date: orNull(m.targetDate),
    completed_date: orNull(m.completedDate),
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

export function rowToMilestone(r: MilestoneRow): Milestone {
  return {
    id: r.id as MilestoneId,
    title: r.title,
    phaseNumber: undef(r.phase_number),
    description: r.description,
    timebox: r.timebox === null ? undefined : (JSON.parse(r.timebox) as Estimate),
    gateCondition: undef(r.gate_condition),
    demoCondition: undef(r.demo_condition),
    status: r.status as MilestoneStatus,
    source: r.source === null ? undefined : (JSON.parse(r.source) as SourceRange),
    sourceKey: undef(r.source_key),
    startDate: undef(r.start_date),
    targetDate: undef(r.target_date),
    completedDate: undef(r.completed_date),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  unity_project_path: string | null;
  blender_source_path: string | null;
  workspace_scanned_at: number | null;
  plan_source_path: string | null;
  conventions: string;
  daily_cap_usd: number;
  total_cap_usd: number;
  ai_config: string;
  engine_integration: string | null;
  scan_schedule: string | null;
  created_at: number;
  updated_at: number;
}

export function projectToRow(p_: Project): ProjectRow {
  return {
    id: p_.id,
    name: p_.name,
    root_path: p_.rootPath,
    unity_project_path: orNull(p_.unityProjectPath),
    blender_source_path: orNull(p_.blenderSourcePath),
    workspace_scanned_at: orNull(p_.workspaceScannedAt),
    plan_source_path: orNull(p_.planSourcePath),
    conventions: j(p_.conventions),
    daily_cap_usd: p_.dailyCapUsd,
    total_cap_usd: p_.totalCapUsd,
    ai_config: j(p_.aiConfig),
    engine_integration: jOrNull(p_.engineIntegration),
    scan_schedule: jOrNull(p_.scanSchedule),
    created_at: p_.createdAt,
    updated_at: p_.updatedAt,
  };
}

export function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id as ProjectId,
    name: r.name,
    rootPath: r.root_path,
    unityProjectPath: undef(r.unity_project_path),
    blenderSourcePath: undef(r.blender_source_path),
    workspaceScannedAt: undef(r.workspace_scanned_at),
    planSourcePath: undef(r.plan_source_path),
    conventions: p<string[]>(r.conventions, []),
    dailyCapUsd: r.daily_cap_usd,
    totalCapUsd: r.total_cap_usd,
    aiConfig: p<AiConfig>(r.ai_config, {
      activeProviderId: undefined,
      providers: [],
      systemPrompt: "",
      maxContextMessages: 50,
      maxTokens: 4096,
      temperature: 0.7,
    }),
    engineIntegration: r.engine_integration === null ? undefined : (JSON.parse(r.engine_integration) as EngineIntegrationConfig),
    scanSchedule: r.scan_schedule === null ? undefined : (JSON.parse(r.scan_schedule) as ScanScheduleConfig),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Chat thread
// ---------------------------------------------------------------------------

export interface ChatThreadRow {
  card_id: string;
  provider_id: string | null;
  model: string | null;
  messages: string;
  updated_at: number;
}

export function chatThreadToRow(t: ChatThread): ChatThreadRow {
  return {
    card_id: t.cardId,
    provider_id: orNull(t.providerId),
    model: orNull(t.model),
    messages: j(t.messages),
    updated_at: t.updatedAt,
  };
}

export function rowToThread(r: ChatThreadRow): ChatThread {
  return {
    cardId: r.card_id as CardId,
    providerId: undef(r.provider_id),
    model: undef(r.model),
    messages: p<ChatMessage[]>(r.messages, []),
    updatedAt: r.updated_at,
  };
}

export function chatMessageToRow(_m: ChatMessage): string {
  return j(_m);
}

// ---------------------------------------------------------------------------
// Health item
// ---------------------------------------------------------------------------

export interface HealthRow {
  id: string;
  severity: string;
  source: string;
  fingerprint: string;
  message: string;
  anchor: string | null;
  anchor_kind: string | null;
  anchor_path: string | null;
  card_id: string | null;
  auto_close: number;
  resolved: number;
  first_seen_at: number;
  last_seen_at: number;
}

export function healthToRow(h: HealthItem): HealthRow {
  return {
    id: h.id,
    severity: h.severity,
    source: h.source,
    fingerprint: h.fingerprint,
    message: h.message,
    anchor: jOrNull(h.anchor),
    anchor_kind: h.anchor ? h.anchor.kind : null,
    anchor_path: h.anchor ? anchorPath(h.anchor) : null,
    card_id: orNull(h.cardId),
    auto_close: h.autoClose ? 1 : 0,
    resolved: h.resolved ? 1 : 0,
    first_seen_at: h.firstSeenAt,
    last_seen_at: h.lastSeenAt,
  };
}

export function rowToHealth(r: HealthRow): HealthItem {
  return {
    id: r.id as HealthItemId,
    severity: r.severity as Severity,
    source: r.source,
    fingerprint: r.fingerprint,
    message: r.message,
    anchor: r.anchor === null ? undefined : (JSON.parse(r.anchor) as Anchor),
    cardId: undef(r.card_id) as CardId | undefined,
    autoClose: r.auto_close === 1,
    resolved: r.resolved === 1,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

// ---------------------------------------------------------------------------
// Workspace asset — imported separately: this module stays free of a
// dependency on packages/core/src/workspace/* to keep the row layer generic;
// the type is small enough to inline here rather than import.
// ---------------------------------------------------------------------------

export interface WorkspaceAssetLike {
  path: string;
  source: "unity" | "blender";
  kind: string;
  sizeBytes: number;
  mtimeMs: number;
  classNames?: string[];
  hash: string;
}

export interface WorkspaceAssetRow {
  path: string;
  source: string;
  kind: string;
  size_bytes: number;
  mtime_ms: number;
  class_names: string | null;
  hash: string;
}

export function workspaceAssetToRow(a: WorkspaceAssetLike): WorkspaceAssetRow {
  return {
    path: a.path,
    source: a.source,
    kind: a.kind,
    size_bytes: a.sizeBytes,
    mtime_ms: a.mtimeMs,
    class_names: jOrNull(a.classNames),
    hash: a.hash,
  };
}

export function rowToWorkspaceAsset(r: WorkspaceAssetRow): WorkspaceAssetLike {
  return {
    path: r.path,
    source: r.source as "unity" | "blender",
    kind: r.kind,
    sizeBytes: r.size_bytes,
    mtimeMs: r.mtime_ms,
    classNames: r.class_names === null ? undefined : (JSON.parse(r.class_names) as string[]),
    hash: r.hash,
  };
}

// ---------------------------------------------------------------------------
// Document chat thread
// ---------------------------------------------------------------------------

export interface DocThreadRow {
  doc_path: string;
  provider_id: string | null;
  model: string | null;
  messages: string;
  updated_at: number;
}

export function docThreadToRow(t: DocThread): DocThreadRow {
  return {
    doc_path: t.docPath,
    provider_id: orNull(t.providerId),
    model: orNull(t.model),
    messages: j(t.messages),
    updated_at: t.updatedAt,
  };
}

export function rowToDocThread(r: DocThreadRow): DocThread {
  return {
    docPath: r.doc_path,
    providerId: undef(r.provider_id),
    model: undef(r.model),
    messages: p<ChatMessage[]>(r.messages, []),
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  card_id: string;
  agent: string;
  state: string;
  packet: string;
  worktree: string;
  acceptance: string;
  budget: string;
  attempts: string;
  cost_usd: number;
  log_path: string;
  created_at: number;
  updated_at: number;
}

export function jobToRow(job: Job): JobRow {
  return {
    id: job.id,
    card_id: job.cardId,
    agent: job.agent,
    state: job.state,
    packet: j(job.packet),
    worktree: job.worktree,
    acceptance: j(job.acceptance),
    budget: j(job.budget),
    attempts: j(job.attempts),
    cost_usd: job.costUsd,
    log_path: job.logPath,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export function rowToJob(r: JobRow): Job {
  return {
    id: r.id as JobId,
    cardId: r.card_id as CardId,
    agent: r.agent,
    state: r.state as JobState,
    packet: JSON.parse(r.packet) as ContextPacket,
    worktree: r.worktree,
    acceptance: p<string[]>(r.acceptance, []),
    budget: JSON.parse(r.budget) as Budget,
    attempts: p<Attempt[]>(r.attempts, []),
    costUsd: r.cost_usd,
    logPath: r.log_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Ledger entry
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  job_id: string;
  card_id: string;
  agent: string;
  amount_usd: number;
  duration_ms: number;
  at: number;
}

export function ledgerEntryToRow(e: LedgerEntry): LedgerRow {
  return {
    id: e.id,
    job_id: e.jobId,
    card_id: e.cardId,
    agent: e.agent,
    amount_usd: e.amountUsd,
    duration_ms: e.durationMs,
    at: e.at,
  };
}

export function rowToLedgerEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    jobId: r.job_id as JobId,
    cardId: r.card_id as CardId,
    agent: r.agent,
    amountUsd: r.amount_usd,
    durationMs: r.duration_ms,
    at: r.at,
  };
}

// ---------------------------------------------------------------------------
// Suggestion — the Decisions queue. See design/automation-spec.md Part IV.
// ---------------------------------------------------------------------------

export interface SuggestionRow {
  id: string;
  kind: string;
  source: string;
  rationale: string;
  payload: string;
  fingerprint: string;
  related_card_id: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
}

export function suggestionToRow(s: Suggestion): SuggestionRow {
  return {
    id: s.id,
    kind: s.kind,
    source: s.source,
    rationale: s.rationale,
    payload: j(s.payload),
    fingerprint: s.fingerprint,
    related_card_id: orNull(s.relatedCardId),
    status: s.status,
    created_at: s.createdAt,
    decided_at: orNull(s.decidedAt),
  };
}

export function rowToSuggestion(r: SuggestionRow): Suggestion {
  return {
    id: r.id,
    kind: r.kind as SuggestionKind,
    source: r.source as SuggestionSource,
    rationale: r.rationale,
    payload: p<Record<string, unknown>>(r.payload, {}),
    fingerprint: r.fingerprint,
    relatedCardId: undef(r.related_card_id) as CardId | undefined,
    status: r.status as SuggestionStatus,
    createdAt: r.created_at,
    decidedAt: undef(r.decided_at),
  };
}
