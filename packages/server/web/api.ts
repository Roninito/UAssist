/**
 * Server API client.
 *
 * Types come from @uassist/core — the same file the server writes against, so
 * a schema change is one edit and a type error rather than a runtime surprise.
 */

import type {
  AiConfig,
  Anchor,
  BoardResponse,
  Card,
  CardId,
  ChatMessage,
  ChatThread,
  DocThread,
  EngineIntegrationConfig,
  HealthItem,
  ImportResult,
  Job,
  Milestone,
  Project,
  Severity,
  Status,
  Suggestion,
  SuggestionStatus,
  WorkspaceAsset,
  WorkspaceStatus,
} from "@uassist/core";

export interface AssetSummary {
  totalAssets: number;
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  uncoveredCount: number;
  orphanedCardCount: number;
  openHealthCount: number;
  lastScannedAt?: number;
}

export interface AssetDetail {
  asset: {
    source: string;
    path: string;
    kind: string;
    sizeBytes: number;
    mtimeMs: number;
    classNames?: string[];
    hash: string;
  };
  cards: { id: string; title: string; status: Status; priority: string }[];
  health: { id: string; severity: Severity; message: string; resolved: boolean }[];
  related: { source: string; path: string; kind: string }[];
  seq: number;
}

export interface AssetListResponse {
  assets: {
    source: string;
    path: string;
    kind: string;
    sizeBytes: number;
    mtimeMs: number;
    classNames?: string[];
    cardCount: number;
    openHealthCount: number;
  }[];
  seq: number;
}

export type { Suggestion, SuggestionStatus } from "@uassist/core";
export type { EngineIntegrationConfig, EngineIntegrationMethod, EngineMethodConfig } from "@uassist/core";

/**
 * Duplicated, not imported as a value: every other web/*.ts file only ever
 * imports *types* from @uassist/core (`import type`), which the bundler
 * fully erases. A real value import pulls the whole core barrel into this
 * browser-targeted bundle — including server-only modules that
 * `await import("bun")` — and `bun build --compile` refuses to bundle that
 * for a browser target at all, even when it's dead code from here.
 */
export const ENGINE_INTEGRATION_METHODS = ["cli", "mcp", "both"] as const;

export type { Job } from "@uassist/core";

export interface JobDiffResponse {
  diff: string;
  stat: { filesChanged: number; insertions: number; deletions: number; files: string[] };
  seq: number;
}

export interface LedgerResponse {
  entries: { id: string; jobId: string; cardId: string; agent: string; amountUsd: number; durationMs: number; at: number }[];
  totalToday: number;
  totalAllTime: number;
  dailyCapUsd?: number;
  totalCapUsd?: number;
  seq: number;
}

export interface MilestoneWithProgress extends Milestone {
  cardCount: number;
  doneCount: number;
  percent: number;
}

export interface ProjectSummary {
  project: Project;
  milestones: Milestone[];
  counts: Record<string, number>;
  total: number;
  seq: number;
}

export interface CardDetail {
  card: Card;
  milestone?: Milestone;
  links: {
    dependencies: { id: CardId; title: string; status: Status }[];
    blockedBy: { id: CardId; title: string; status: Status }[];
    related: { id: CardId; title: string; status: Status }[];
  };
}

export interface ViewSummary {
  id: string;
  name: string;
  columns: string;
  rows: string;
  swimlanes: string;
}

export type {
  AiConfig,
  AiProviderConfig,
  AiProviderKind,
  Anchor,
  ChatMessage,
  ChatThread,
  DocThread,
  WorkspaceAsset,
  WorkspaceStatus,
} from "@uassist/core";

export interface RegistryEntry {
  id: string;
  name: string;
  root: string;
  addedAt: number;
  lastOpenedAt: number;
  reachable: boolean;
  self: boolean;
  url?: string;
}

export interface DocSummary {
  path: string;
  title: string;
  updatedAt: number;
  sizeBytes: number;
  isPlan: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface BoardQuery {
  view: string;
  search?: string;
}

export const api = {
  project: () => request<ProjectSummary>("/api/project"),

  views: () => request<ViewSummary[]>("/api/views"),

  board: (query: BoardQuery) => {
    const params = new URLSearchParams({ view: query.view });
    if (query.search) params.set("q", query.search);
    return request<BoardResponse>(`/api/board?${params}`);
  },

  card: (id: CardId) => request<CardDetail>(`/api/cards/${id}`),

  patchCard: (id: CardId, patch: Record<string, unknown>) =>
    request<{ card: Card; changed: string[]; seq: number }>(
      `/api/cards/${id}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  health: () => request<{ health: HealthItem[]; seq: number }>("/api/health"),

  aiConfig: () => request<{ config: AiConfig; seq: number }>("/api/ai/config"),

  putAiConfig: (config: AiConfig) =>
    request<{ config: AiConfig; seq: number }>("/api/ai/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  chat: (cardId: CardId) =>
    request<{ thread?: ChatThread; messages?: ChatMessage[]; cardId: string; seq: number }>(
      `/api/cards/${cardId}/chat`,
    ),

  sendChat: (cardId: CardId, message: string) =>
    request<{ thread?: ChatThread; streaming?: boolean; seq: number }>(
      `/api/cards/${cardId}/chat`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
      },
    ),

  patchProject: (patch: {
    name?: string;
    unityProjectPath?: string | null;
    blenderSourcePath?: string | null;
    engineIntegration?: EngineIntegrationConfig | null;
  }) =>
    request<{ project: Project; changed: string[]; workspace: WorkspaceStatus; seq: number }>(
      "/api/project",
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  workspace: () => request<{ workspace: WorkspaceStatus; seq: number }>("/api/workspace"),

  scanWorkspace: () =>
    request<{
      results: Record<string, { count: number; durationMs: number; warnings: string[] } | { error: string }>;
      workspace: WorkspaceStatus;
      seq: number;
    }>("/api/workspace/scan", { method: "POST" }),

  searchAssets: (query: { q?: string; kind?: string; source?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.kind) params.set("kind", query.kind);
    if (query.source) params.set("source", query.source);
    if (query.limit) params.set("limit", String(query.limit));
    return request<{ assets: WorkspaceAsset[]; seq: number }>(`/api/workspace/assets?${params}`);
  },

  registry: () =>
    request<{ project?: { id: string; name: string; root: string }; projects: RegistryEntry[] }>(
      "/api/registry",
    ),

  startRegistryProject: (id: string) =>
    request<{ started: boolean; reachable: boolean; url?: string }>(`/api/registry/${id}/start`, {
      method: "POST",
    }),

  docs: () => request<{ docs: DocSummary[]; seq: number }>("/api/docs"),

  doc: (path: string) =>
    request<{ path: string; title: string; content: string; updatedAt: number; isPlan: boolean; seq: number }>(
      `/api/docs/${encodeURIComponent(path)}`,
    ),

  saveDoc: (path: string, content: string) =>
    request<{ path: string; title: string; seq: number }>(
      `/api/docs/${encodeURIComponent(path)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),

  docChat: (path: string) =>
    request<{ thread?: DocThread; messages?: ChatMessage[]; docPath: string; seq: number }>(
      `/api/docs/${encodeURIComponent(path)}/chat`,
    ),

  sendDocChat: (path: string, message: string) =>
    request<{ thread?: DocThread; streaming?: boolean; seq: number }>(
      `/api/docs/${encodeURIComponent(path)}/chat`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  milestones: () =>
    request<{ milestones: MilestoneWithProgress[]; seq: number }>("/api/milestones"),

  importPlan: (path: string, dryRun: boolean) =>
    request<ImportResult & { fileName: string; seq: number }>("/api/plans/import", {
      method: "POST",
      body: JSON.stringify({ path, dryRun }),
    }),

  adapters: () => request<{ adapters: string[] }>("/api/adapters"),

  cardJobs: (cardId: CardId) => request<{ jobs: Job[]; seq: number }>(`/api/cards/${cardId}/jobs`),

  dispatch: (
    cardId: CardId,
    body: { agentId: string; maxCostUsd?: number; maxDurationMs?: number; maxAttempts?: number; objectiveOverride?: string },
  ) =>
    request<{ job: Job; seq: number }>(`/api/cards/${cardId}/dispatch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  job: (jobId: string) => request<{ job: Job; seq: number }>(`/api/jobs/${jobId}`),

  jobDiff: (jobId: string) => request<JobDiffResponse>(`/api/jobs/${jobId}/diff`),

  acceptJob: (jobId: string, commitMessage?: string) =>
    request<{ job: Job; seq: number }>(`/api/jobs/${jobId}/accept`, {
      method: "POST",
      body: JSON.stringify({ commitMessage }),
    }),

  rejectJob: (jobId: string) =>
    request<{ job: Job; seq: number }>(`/api/jobs/${jobId}/reject`, { method: "POST" }),

  ledger: () => request<LedgerResponse>("/api/ledger"),

  suggestions: (status?: SuggestionStatus) =>
    request<{ suggestions: Suggestion[]; seq: number }>(
      `/api/suggestions${status ? `?status=${status}` : ""}`,
    ),

  acceptSuggestion: (id: string) =>
    request<{ suggestion: Suggestion; seq: number }>(`/api/suggestions/${id}/accept`, { method: "POST" }),

  rejectSuggestion: (id: string) =>
    request<{ suggestion: Suggestion; seq: number }>(`/api/suggestions/${id}/reject`, { method: "POST" }),

  holdSuggestion: (id: string) =>
    request<{ suggestion: Suggestion; seq: number }>(`/api/suggestions/${id}/hold`, { method: "POST" }),

  assetSummary: () => request<{ summary: AssetSummary; seq: number }>("/api/assets/summary"),

  assets: (queryString?: string) =>
    request<AssetListResponse>(`/api/assets${queryString ? `?${queryString}` : ""}`),

  assetDetail: (key: string) => request<AssetDetail>(`/api/assets/${encodeURIComponent(key)}`),
};

/** Map a picked catalog entry to the Anchor variant it best represents —
 *  used by the card detail panel's anchor picker. See
 *  design/workspace-spec.md Part IV. */
export function anchorForAsset(asset: WorkspaceAsset): Anchor {
  switch (asset.kind) {
    case "script":
      return { kind: "script", path: asset.path };
    case "prefab":
      return { kind: "unityPrefab", path: asset.path };
    case "scene":
      return { kind: "scene", path: asset.path };
    case "blend":
      return { kind: "asset", path: asset.path };
    default:
      return asset.source === "unity"
        ? { kind: "unityAsset", path: asset.path }
        : { kind: "asset", path: asset.path };
  }
}

export { ApiError };
