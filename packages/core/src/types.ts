/**
 * Domain model. Defined once, imported by the server, the CLI, and the web UI.
 *
 * See design/uassist-spec.md Part III.
 */

import type {
  AssetId,
  CardId,
  HealthItemId,
  JobId,
  MilestoneId,
  ProjectId,
} from "./ids.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Fixed, five words, does not grow. */
export const STATUSES = ["open", "active", "blocked", "review", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const CATEGORIES = [
  "Systems",
  "Gameplay",
  "AI",
  "UI",
  "Audio",
  "Art",
  "Narrative",
  "Infra",
  "Unknown",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CARD_KINDS = [
  "task",
  "deliverable",
  "gate",
  "decision",
  "risk",
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const PRIORITIES = ["blocker", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MILESTONE_STATUSES = [
  "planned",
  "active",
  "done",
  "at-risk",
  "slipped",
] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const ASSET_KINDS = [
  "mesh",
  "texture",
  "material",
  "animation",
  "audio",
  "vfx",
  "prefab",
  "scene",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STAGES = [
  "concept",
  "inProgress",
  "inEngine",
  "review",
  "shippable",
  "cut",
] as const;
export type AssetStage = (typeof ASSET_STAGES)[number];

export const SEVERITIES = ["blocker", "high", "normal", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Shared value objects
// ---------------------------------------------------------------------------

export interface Estimate {
  minWeeks: number;
  maxWeeks: number;
  /** 0..1. Absent when the plan gave a range but no signal about confidence. */
  confidence?: number;
}

export interface SourceRange {
  file: string;
  startLine: number;
  endLine: number;
}

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
  verifiedBy?: "human" | "validator" | "agent";
}

export type Assignee =
  | { kind: "human"; id: string; name: string }
  | { kind: "agent"; id: string; adapter: string }
  | { kind: "ai"; id: "assistant" }
  | { kind: "unassigned" };

export type Anchor =
  | { kind: "asset"; path: string }
  | { kind: "blenderObject"; blendFile: string; objectName: string }
  | { kind: "unityAsset"; path: string; guid?: string }
  | {
      kind: "unityGameObject";
      scene: string;
      path: string;
      instanceId?: number;
    }
  | { kind: "unityPrefab"; path: string }
  | { kind: "script"; path: string; range?: [number, number] }
  | { kind: "scene"; path: string }
  | { kind: "dataTable"; path: string; sheet?: string }
  | { kind: "commit"; sha: string }
  | { kind: "worktree"; path: string };

/**
 * Anchors are stored as JSON but indexed on these two extracted columns, so
 * "what work is open on this prefab?" is one indexed query, not a scan.
 */
export function anchorPath(anchor: Anchor): string {
  switch (anchor.kind) {
    case "blenderObject":
      return `${anchor.blendFile}#${anchor.objectName}`;
    case "unityGameObject":
      return `${anchor.scene}#${anchor.path}`;
    case "commit":
      return anchor.sha;
    default:
      return anchor.path;
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Project {
  id: ProjectId;
  name: string;
  rootPath: string;
  unityProjectPath?: string;
  blenderSourcePath?: string;
  /** Set on every `POST /api/workspace/scan`. See design/workspace-spec.md Part III. */
  workspaceScannedAt?: number;
  /** Absolute path of the last-imported plan source, for one-click re-import. */
  planSourcePath?: string;
  conventions: string[];
  dailyCapUsd: number;
  totalCapUsd: number;
  /** Assistant configuration lives with the project. */
  aiConfig: AiConfig;
  /** See design/automation-spec.md Part II. Absent means CLI-only, the
   *  zero-config default — nothing to set up before dispatch works. */
  engineIntegration?: EngineIntegrationConfig;
  /** See design/automation-spec.md Part III. Absent defaults to enabled at
   *  15 minutes — the same "on by default, not a thing to remember to turn
   *  on" stance the rest of this document takes toward keeping the board honest. */
  scanSchedule?: ScanScheduleConfig;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Engine integration — design/automation-spec.md Part II
// ---------------------------------------------------------------------------

export const ENGINE_INTEGRATION_METHODS = ["cli", "mcp", "both"] as const;
export type EngineIntegrationMethod = (typeof ENGINE_INTEGRATION_METHODS)[number];

export interface EngineMethodConfig {
  method: EngineIntegrationMethod;
  /** Required when method is "mcp" or "both". */
  mcpServerUrl?: string;
}

export interface EngineIntegrationConfig {
  unity?: EngineMethodConfig;
  blender?: EngineMethodConfig;
}

// ---------------------------------------------------------------------------
// Scheduled scanning — design/automation-spec.md Part III
// ---------------------------------------------------------------------------

export interface ScanScheduleConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export const DEFAULT_SCAN_SCHEDULE: ScanScheduleConfig = { enabled: true, intervalMinutes: 15 };

export interface Card {
  id: CardId;
  title: string;
  description?: string;
  milestoneId?: MilestoneId;

  category: Category;
  subsystem?: string;
  kind: CardKind;

  status: Status;
  priority: Priority;

  assignee: Assignee;
  owner?: string;

  estimate?: Estimate;
  timeSpentHours: number;

  anchor?: Anchor;
  source?: SourceRange;
  /** Stable identity across plan re-imports. See plan/sourceKey.ts. */
  sourceKey?: string;

  dependencies: CardId[];
  blockedBy: CardId[];
  related: CardId[];

  acceptance: AcceptanceCriterion[];
  tags: string[];

  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Milestone {
  id: MilestoneId;
  title: string;
  phaseNumber?: number;
  description: string;
  timebox?: Estimate;
  gateCondition?: string;
  demoCondition?: string;
  status: MilestoneStatus;
  source?: SourceRange;
  sourceKey?: string;
  startDate?: number;
  targetDate?: number;
  completedDate?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Provenance {
  origin: "authored" | "purchased" | "generated" | "unknown";
  author?: string;
  url?: string;
}

export interface Licence {
  spdx?: string;
  text?: string;
  verified: boolean;
}

export interface Asset {
  id: AssetId;
  name: string;
  kind: AssetKind;
  stage: AssetStage;
  sourceFile?: string;
  engineFile?: string;
  provenance: Provenance;
  licence: Licence;
  tags: string[];
  variants: AssetId[];
  dependents: AssetId[];
  derivedFrom: AssetId[];
  previews: string[];
  version: number;
  lastExportedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HealthItem {
  id: HealthItemId;
  severity: Severity;
  /** Validator id. */
  source: string;
  /**
   * Stable across runs. A validator run produces a set of fingerprints; open
   * auto-close items whose fingerprint is absent get resolved.
   */
  fingerprint: string;
  message: string;
  anchor?: Anchor;
  cardId?: CardId;
  autoClose: boolean;
  resolved: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

export const JOB_STATES = [
  "drafted",
  "dispatched",
  "running",
  "awaiting_answer",
  "returned",
  "review",
  "accepted",
  "rejected",
  "refined",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface Budget {
  maxCostUsd: number;
  maxDurationMs: number;
  maxAttempts: number;
}

export interface ContextPacket {
  objective: string;
  anchor?: Anchor;
  anchorState: Record<string, unknown>;
  files: { path: string; reason: string }[];
  conventions: string[];
  priorJobs: { id: JobId; outcome: string }[];
  acceptance: string[];
  constraints: string[];
}

export interface Attempt {
  at: number;
  outcome: "returned" | "failed" | "cancelled";
  note?: string;
}

export interface Job {
  id: JobId;
  cardId: CardId;
  agent: string;
  state: JobState;
  packet: ContextPacket;
  worktree: string;
  acceptance: string[];
  budget: Budget;
  attempts: Attempt[];
  costUsd: number;
  logPath: string;
  createdAt: number;
  updatedAt: number;
}

/** Part XI, uassist-spec.md — one row per completed unit of agent spend. */
export interface LedgerEntry {
  id: string;
  jobId: JobId;
  cardId: CardId;
  agent: string;
  amountUsd: number;
  durationMs: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Suggestions — the Decisions queue. See design/automation-spec.md Part IV.
// ---------------------------------------------------------------------------

/**
 * `close_health_item` is specified but not produced by anything yet — it
 * needs the validator runner to exist at all (Phase 4). Listed now so the
 * type is stable when that lands, rather than widened later.
 *
 * `update_card_status` IS produced today, by reconcile.ts, but
 * deliberately conservatively: with no mechanically-checkable acceptance
 * criteria yet (Phase 4), it only ever proposes moving a card to "review"
 * ("worth a look") when its anchored asset changed — never "done."
 */
export const SUGGESTION_KINDS = [
  "create_card",
  "attach_anchor",
  "update_card_status",
  "dispatch",
  "close_health_item",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected", "held"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type SuggestionSource = "reconciliation" | "assistant";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  source: SuggestionSource;
  /** One sentence, shown verbatim — "why this, now." */
  rationale: string;
  /** Shape depends on `kind`; validated at accept time by the handler for
   *  that kind, not at creation — see automation-spec.md Part IX, decision 2. */
  payload: Record<string, unknown>;
  /** Dedup key. Same kind + same underlying fact must produce the same
   *  fingerprint, so a re-run of reconciliation never duplicates a pending
   *  suggestion or resurrects a rejected one. */
  fingerprint: string;
  relatedCardId?: CardId;
  status: SuggestionStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface CreateCardPayload {
  title: string;
  category: Category;
  anchor: Anchor;
}

export interface AttachAnchorPayload {
  cardId: CardId;
  anchor: Anchor;
}

/**
 * Reconciliation evidence, not a claim of completion — automation-spec.md
 * Part III is explicit that a changed file is "worth a look," never "mark
 * this done." `toStatus` is always "review" (the board's own "look at
 * this" state), not "done"; accepting still requires a human to actually
 * look and move it further.
 */
export interface UpdateCardStatusPayload {
  cardId: CardId;
  toStatus: Extract<Status, "review">;
}

// ---------------------------------------------------------------------------
// AI / Assistant
// ---------------------------------------------------------------------------

export type AiProviderKind = "ollama" | "lmstudio" | "openai";

export const AI_PROVIDER_KINDS: AiProviderKind[] = ["ollama", "lmstudio", "openai"];

export interface AiProviderConfig {
  /** Stable id assigned by the client or config form. */
  id: string;
  kind: AiProviderKind;
  /** Display name chosen by the user. */
  name: string;
  /** Base URL, e.g. http://127.0.0.1:11434/v1 or http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** API key, optional for local providers. */
  apiKey?: string;
  /** Default model to use when this provider is selected. */
  model: string;
  /** Whether this provider is currently enabled. */
  enabled: boolean;
}

export interface AiConfig {
  /** The active provider id. */
  activeProviderId?: string;
  /** All configured providers. */
  providers: AiProviderConfig[];
  /** System prompt used for per-card chat. */
  systemPrompt: string;
  /** Max context messages to keep in a chat thread before summarising. */
  maxContextMessages: number;
  /** Default max tokens for a chat completion. */
  maxTokens: number;
  /** Temperature for chat completions. */
  temperature: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional name for multi-agent/provider distinction. */
  name?: string;
  createdAt: number;
}

export interface ChatThread {
  cardId: CardId;
  messages: ChatMessage[];
  model?: string;
  providerId?: string;
  updatedAt: number;
}

/**
 * A chat thread scoped to a document (design/workspace-spec.md Part V)
 * rather than a card. Same shape as ChatThread by design — deliberately a
 * separate type and table rather than a generalized `ChatSubject` key on the
 * existing one; see that doc for why.
 */
export interface DocThread {
  docPath: string;
  messages: ChatMessage[];
  model?: string;
  providerId?: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const UNASSIGNED: Assignee = { kind: "unassigned" };

export function newCardDefaults(now: number) {
  return {
    category: "Unknown" as Category,
    kind: "task" as CardKind,
    status: "open" as Status,
    priority: "normal" as Priority,
    assignee: UNASSIGNED,
    timeSpentHours: 0,
    dependencies: [] as CardId[],
    blockedBy: [] as CardId[],
    related: [] as CardId[],
    acceptance: [] as AcceptanceCriterion[],
    tags: [] as string[],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultAiConfig(): AiConfig {
  return {
    activeProviderId: undefined,
    providers: [
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        enabled: true,
      },
      {
        id: "lmstudio",
        kind: "lmstudio",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        enabled: true,
      },
    ],
    systemPrompt:
      "You are a helpful game-development assistant. You help the user think through tasks for a Unity + Blender project. Keep answers concise and practical.",
    maxContextMessages: 50,
    maxTokens: 4096,
    temperature: 0.7,
  };
}
