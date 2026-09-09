/**
 * REST handlers.
 *
 * Request bodies are untrusted, so every one is parsed at this boundary
 * (see design/uassist-spec.md Part III, "Runtime validation at the edges").
 * Interior code trusts its types.
 */

import {
  buildBoard,
  resolveView,
  PRESET_VIEWS,
  STATUSES,
  PRIORITIES,
  CATEGORIES,
  AI_PROVIDER_KINDS,
  ASSET_KIND_GUESSES,
  isWorkspaceComplete,
  runValidators,
  type AiConfig,
  type AiProviderConfig,
  type AiProviderKind,
  type Anchor,
  type BoardFilters,
  type CardId,
  type Card,
  type Category,
  type ChatMessage,
  type MilestoneId,
  type Priority,
  type Project,
  type Status,
  type Store,
} from "@uassist/core";
import type { EventBus } from "./bus.ts";

export interface Ctx {
  store: Store;
  bus: EventBus;
}

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

export const fail = (status: number, message: string): Response =>
  Response.json({ error: message }, { status });

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out = list.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function filtersFromQuery(url: URL): BoardFilters | undefined {
  const params = url.searchParams;
  const pick = <T extends string>(name: string, allowed: readonly T[]): T[] | undefined => {
    const raw = params.getAll(name).flatMap((v) => v.split(","));
    const out = raw.filter((v): v is T => (allowed as readonly string[]).includes(v));
    return out.length > 0 ? out : undefined;
  };

  const filters: BoardFilters = {};
  const status = pick("status", STATUSES);
  if (status) filters.status = status;
  const priority = pick("priority", PRIORITIES);
  if (priority) filters.priority = priority;
  const category = asStringArray(params.getAll("category").flatMap((v) => v.split(",")));
  if (category) filters.category = category;
  const milestone = asStringArray(params.getAll("milestone").flatMap((v) => v.split(",")));
  if (milestone) filters.milestoneId = milestone as MilestoneId[];
  const search = params.get("q");
  if (search && search.trim().length > 0) filters.search = search;

  return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Fields a client is allowed to PATCH onto a card, and how each is validated.
 * Anything not listed here is ignored rather than written.
 */
interface CardPatch {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  category?: Category;
  subsystem?: string;
  owner?: string;
  milestoneId?: MilestoneId;
  acceptanceMet?: { index: number; met: boolean };
  anchor?: Anchor;
}

const ANCHOR_KINDS = [
  "asset", "blenderObject", "unityAsset", "unityGameObject",
  "unityPrefab", "script", "scene", "dataTable", "commit", "worktree",
] as const;

/**
 * Parse a card's `anchor` field against the full Anchor discriminated union —
 * see design/workspace-spec.md Part IV, "The anchor picker." A malformed or
 * unrecognized variant is rejected rather than coerced, matching the edge-
 * parsing discipline this file already uses everywhere else.
 */
function parseAnchor(value: unknown): Anchor | { error: string } {
  if (typeof value !== "object" || value === null) {
    return { error: "anchor must be an object" };
  }
  const b = value as Record<string, unknown>;
  const kind = oneOf(b["kind"], ANCHOR_KINDS);
  if (!kind) return { error: `anchor.kind must be one of: ${ANCHOR_KINDS.join(", ")}` };

  const str = (key: string): string | { error: string } => {
    const v = b[key];
    return typeof v === "string" && v.length > 0 ? v : { error: `anchor.${key} must be a non-empty string` };
  };

  switch (kind) {
    case "asset":
    case "unityPrefab":
    case "script":
    case "scene":
    case "worktree": {
      const path = str("path");
      if (typeof path !== "string") return path;
      if (kind === "script") {
        return { kind, path } satisfies Anchor;
      }
      return { kind, path } as Anchor;
    }
    case "blenderObject": {
      const blendFile = str("blendFile");
      if (typeof blendFile !== "string") return blendFile;
      const objectName = str("objectName");
      if (typeof objectName !== "string") return objectName;
      return { kind, blendFile, objectName };
    }
    case "unityAsset": {
      const path = str("path");
      if (typeof path !== "string") return path;
      const guid = b["guid"];
      if (guid !== undefined && typeof guid !== "string") return { error: "anchor.guid must be a string" };
      return { kind, path, guid };
    }
    case "unityGameObject": {
      const scene = str("scene");
      if (typeof scene !== "string") return scene;
      const path = str("path");
      if (typeof path !== "string") return path;
      const instanceId = b["instanceId"];
      if (instanceId !== undefined && typeof instanceId !== "number") {
        return { error: "anchor.instanceId must be a number" };
      }
      return { kind, scene, path, instanceId };
    }
    case "dataTable": {
      const path = str("path");
      if (typeof path !== "string") return path;
      const sheet = b["sheet"];
      if (sheet !== undefined && typeof sheet !== "string") return { error: "anchor.sheet must be a string" };
      return { kind, path, sheet };
    }
    case "commit": {
      const sha = str("sha");
      if (typeof sha !== "string") return sha;
      return { kind, sha };
    }
  }
}

function parseCardPatch(body: unknown): CardPatch | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const patch: CardPatch = {};

  if (b["title"] !== undefined) {
    if (typeof b["title"] !== "string" || b["title"].trim().length === 0) {
      return { error: "title must be a non-empty string" };
    }
    patch.title = b["title"].trim();
  }
  if (b["description"] !== undefined) {
    if (typeof b["description"] !== "string") return { error: "description must be a string" };
    patch.description = b["description"];
  }
  if (b["status"] !== undefined) {
    const status = oneOf(b["status"], STATUSES);
    if (!status) return { error: `status must be one of: ${STATUSES.join(", ")}` };
    patch.status = status;
  }
  if (b["priority"] !== undefined) {
    const priority = oneOf(b["priority"], PRIORITIES);
    if (!priority) return { error: `priority must be one of: ${PRIORITIES.join(", ")}` };
    patch.priority = priority;
  }
  if (b["category"] !== undefined) {
    const category = oneOf(b["category"], CATEGORIES);
    if (!category) return { error: `category must be one of: ${CATEGORIES.join(", ")}` };
    patch.category = category;
  }
  if (b["subsystem"] !== undefined) {
    if (typeof b["subsystem"] !== "string") return { error: "subsystem must be a string" };
    patch.subsystem = b["subsystem"];
  }
  if (b["owner"] !== undefined) {
    if (typeof b["owner"] !== "string") return { error: "owner must be a string" };
    patch.owner = b["owner"];
  }
  if (b["milestoneId"] !== undefined) {
    if (typeof b["milestoneId"] !== "string") return { error: "milestoneId must be a string" };
    patch.milestoneId = b["milestoneId"] as MilestoneId;
  }
  if (b["acceptanceMet"] !== undefined) {
    const am = b["acceptanceMet"];
    if (
      typeof am !== "object" || am === null ||
      typeof (am as { index?: unknown }).index !== "number" ||
      typeof (am as { met?: unknown }).met !== "boolean"
    ) {
      return { error: "acceptanceMet must be { index: number, met: boolean }" };
    }
    patch.acceptanceMet = am as { index: number; met: boolean };
  }
  if (b["anchor"] !== undefined) {
    const anchor = parseAnchor(b["anchor"]);
    if ("error" in anchor) return anchor;
    patch.anchor = anchor;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function getProject(ctx: Ctx): Response {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");
  return json({
    project,
    // See design/automation-spec.md Part I — initialization is enforced, not
    // optional, so the board's own chrome can show this without a person
    // having to visit the Project page to find out.
    workspaceComplete: isWorkspaceComplete(project),
    milestones: ctx.store.listMilestones(),
    counts: ctx.store.cardCountsByStatus(),
    total: ctx.store.countCards(),
    seq: ctx.store.lastSeq,
  });
}

export function getBoard(ctx: Ctx, req: Request): Response {
  const url = new URL(req.url);
  const name = url.searchParams.get("view") ?? "plan";
  if (!(name in PRESET_VIEWS)) {
    return fail(400, `unknown view "${name}" — one of: ${Object.keys(PRESET_VIEWS).join(", ")}`);
  }
  return json(buildBoard(ctx.store, resolveView(name, filtersFromQuery(url))));
}

export function getViews(): Response {
  return json(
    Object.values(PRESET_VIEWS).map((v) => ({
      id: v.id,
      name: v.name,
      columns: v.columns,
      rows: v.rows,
      swimlanes: v.swimlanes,
    })),
  );
}

export function getCard(ctx: Ctx, id: string): Response {
  const card = ctx.store.getCard(id as CardId);
  if (!card) return fail(404, "no such card");

  const milestone = card.milestoneId
    ? ctx.store.getMilestone(card.milestoneId)
    : undefined;
  const resolve = (ids: CardId[]) =>
    ids
      .map((cid) => ctx.store.getCard(cid))
      .filter((c): c is Card => c !== undefined)
      .map((c) => ({ id: c.id, title: c.title, status: c.status }));

  return json({
    card,
    milestone,
    links: {
      dependencies: resolve(card.dependencies),
      blockedBy: resolve(card.blockedBy),
      related: resolve(card.related),
    },
  });
}

export async function patchCard(ctx: Ctx, id: string, req: Request): Promise<Response> {
  const existing = ctx.store.getCard(id as CardId);
  if (!existing) return fail(404, "no such card");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }

  const parsed = parseCardPatch(body);
  if ("error" in parsed) return fail(400, parsed.error);

  const changed: string[] = [];
  const next: Card = { ...existing };

  // Written out rather than looped: a generic loop over a key union cannot
  // prove `next[key] = value` is sound, and silencing that with a cast would
  // defeat the point of parsing at the edge.
  if (parsed.title !== undefined && parsed.title !== existing.title) {
    next.title = parsed.title;
    changed.push("title");
  }
  if (parsed.description !== undefined && parsed.description !== existing.description) {
    next.description = parsed.description;
    changed.push("description");
  }
  if (parsed.status !== undefined && parsed.status !== existing.status) {
    next.status = parsed.status;
    changed.push("status");
  }
  if (parsed.priority !== undefined && parsed.priority !== existing.priority) {
    next.priority = parsed.priority;
    changed.push("priority");
  }
  if (parsed.category !== undefined && parsed.category !== existing.category) {
    next.category = parsed.category;
    changed.push("category");
  }
  if (parsed.subsystem !== undefined && parsed.subsystem !== existing.subsystem) {
    next.subsystem = parsed.subsystem;
    changed.push("subsystem");
  }
  if (parsed.owner !== undefined && parsed.owner !== existing.owner) {
    next.owner = parsed.owner;
    changed.push("owner");
  }
  if (
    parsed.anchor !== undefined &&
    JSON.stringify(parsed.anchor) !== JSON.stringify(existing.anchor)
  ) {
    next.anchor = parsed.anchor;
    changed.push("anchor");
  }

  if (parsed.milestoneId !== undefined && parsed.milestoneId !== existing.milestoneId) {
    if (!ctx.store.getMilestone(parsed.milestoneId)) {
      return fail(400, "no such milestone");
    }
    next.milestoneId = parsed.milestoneId;
    changed.push("milestoneId");
  }

  if (parsed.acceptanceMet) {
    const { index, met } = parsed.acceptanceMet;
    const criterion = existing.acceptance[index];
    if (!criterion) return fail(400, `no acceptance criterion at index ${index}`);
    next.acceptance = existing.acceptance.map((a, i) =>
      i === index ? { ...a, met, verifiedBy: "human" as const } : a,
    );
    changed.push("acceptance");
  }

  if (changed.length === 0) {
    return json({ card: existing, changed: [], seq: ctx.store.lastSeq });
  }

  next.version = existing.version + 1;
  next.updatedAt = Date.now();
  ctx.store.putCard(next);

  ctx.bus.publish({
    kind: "cardChanged",
    seq: ctx.store.lastSeq,
    id: next.id,
    fields: changed,
  });

  return json({ card: next, changed, seq: ctx.store.lastSeq });
}

export function listCards(ctx: Ctx, req: Request): Response {
  const url = new URL(req.url);
  const status = oneOf(url.searchParams.get("status"), STATUSES);
  const milestone = url.searchParams.get("milestone") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : undefined;

  return json({
    cards: ctx.store.listCards({
      status,
      milestoneId: milestone as MilestoneId | undefined,
      category,
      limit,
    }),
    seq: ctx.store.lastSeq,
  });
}

export function listMilestones(ctx: Ctx): Response {
  const milestones = ctx.store.listMilestones().map((m) => {
    const cards = ctx.store.listCards({ milestoneId: m.id });
    const done = cards.filter((c) => c.status === "done").length;
    return {
      ...m,
      cardCount: cards.length,
      doneCount: done,
      percent: cards.length === 0 ? 0 : Math.round((done / cards.length) * 100),
    };
  });
  return json({ milestones, seq: ctx.store.lastSeq });
}

export function listHealth(ctx: Ctx): Response {
  return json({ health: ctx.store.listHealthItems(), seq: ctx.store.lastSeq });
}

/**
 * On-demand validator run — the periodic scheduler only ever runs the cheap
 * broken-anchor check (see index.ts's scheduler wiring); a real Unity
 * compile is heavy enough that a person should ask for it, not have it fire
 * silently on a timer. This is that ask.
 */
export async function postValidate(ctx: Ctx): Promise<Response> {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");
  const result = await runValidators(ctx.store);
  if (result.created.length > 0 || result.closed > 0) {
    ctx.bus.publish({ kind: "healthChanged", seq: ctx.store.lastSeq });
  }
  return json({ health: ctx.store.listHealthItems(), ...result, seq: ctx.store.lastSeq });
}

export function getEvents(ctx: Ctx, req: Request): Response {
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
  if (!Number.isFinite(since) || since < 0) return fail(400, "since must be a non-negative number");
  return json({ events: ctx.store.eventsSince(since), seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// AI config
// ---------------------------------------------------------------------------

function parseAiProvider(value: unknown): AiProviderConfig | { error: string } {
  if (typeof value !== "object" || value === null) {
    return { error: "provider must be an object" };
  }
  const b = value as Record<string, unknown>;
  const kind = oneOf(b["kind"], AI_PROVIDER_KINDS);
  if (!kind) return { error: `kind must be one of: ${AI_PROVIDER_KINDS.join(", ")}` };

  const id = typeof b["id"] === "string" && b["id"].trim().length > 0
    ? b["id"].trim()
    : undefined;
  if (!id) return { error: "id must be a non-empty string" };

  const name = typeof b["name"] === "string" && b["name"].trim().length > 0
    ? b["name"].trim()
    : undefined;
  if (!name) return { error: "name must be a non-empty string" };

  const baseUrl = typeof b["baseUrl"] === "string" && b["baseUrl"].trim().length > 0
    ? b["baseUrl"].trim()
    : undefined;
  if (!baseUrl) return { error: "baseUrl must be a non-empty string" };

  const model = typeof b["model"] === "string" && b["model"].trim().length > 0
    ? b["model"].trim()
    : undefined;
  if (!model) return { error: "model must be a non-empty string" };

  const apiKey = b["apiKey"] === undefined || typeof b["apiKey"] === "string"
    ? (b["apiKey"] as string | undefined)
    : undefined;
  if (apiKey === undefined && typeof b["apiKey"] !== "undefined") {
    return { error: "apiKey must be a string or undefined" };
  }

  const enabled = typeof b["enabled"] === "boolean" ? b["enabled"] : true;

  return {
    id,
    kind,
    name,
    baseUrl,
    apiKey,
    model,
    enabled,
  };
}

function parseAiConfig(body: unknown): AiConfig | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;

  const providersRaw = b["providers"];
  if (!Array.isArray(providersRaw)) return { error: "providers must be an array" };
  const providers: AiProviderConfig[] = [];
  for (const p of providersRaw) {
    const parsed = parseAiProvider(p);
    if ("error" in parsed) return parsed;
    providers.push(parsed);
  }

  const activeProviderId = b["activeProviderId"] === undefined || typeof b["activeProviderId"] === "string"
    ? (b["activeProviderId"] as string | undefined)
    : undefined;
  if (activeProviderId === undefined && typeof b["activeProviderId"] !== "undefined") {
    return { error: "activeProviderId must be a string or undefined" };
  }

  const systemPrompt = typeof b["systemPrompt"] === "string"
    ? b["systemPrompt"]
    : undefined;
  if (!systemPrompt) return { error: "systemPrompt must be a non-empty string" };

  const maxContextMessages = typeof b["maxContextMessages"] === "number" && Number.isFinite(b["maxContextMessages"])
    ? Math.max(1, Math.min(500, b["maxContextMessages"]))
    : undefined;

  const maxTokens = typeof b["maxTokens"] === "number" && Number.isFinite(b["maxTokens"])
    ? Math.max(1, b["maxTokens"])
    : undefined;

  const temperature = typeof b["temperature"] === "number" && Number.isFinite(b["temperature"])
    ? Math.max(0, Math.min(2, b["temperature"]))
    : undefined;

  return {
    activeProviderId,
    providers,
    systemPrompt,
    maxContextMessages: maxContextMessages ?? 50,
    maxTokens: maxTokens ?? 4096,
    temperature: temperature ?? 0.7,
  };
}

export function getAiConfig(ctx: Ctx): Response {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");
  return json({ config: project.aiConfig, seq: ctx.store.lastSeq });
}

export async function putAiConfig(ctx: Ctx, req: Request): Promise<Response> {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }

  const parsed = parseAiConfig(body);
  if ("error" in parsed) return fail(400, parsed.error);

  const next: Project = {
    ...project,
    aiConfig: parsed,
    updatedAt: Date.now(),
  };

  ctx.store.putProject(next);
  ctx.bus.publish({ kind: "projectChanged", seq: ctx.store.lastSeq, id: next.id });
  return json({ config: next.aiConfig, seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// Chat threads
// ---------------------------------------------------------------------------

export function getChat(ctx: Ctx, id: string): Response {
  const thread = ctx.store.getChatThread(id as CardId);
  if (!thread) return json({ cardId: id, messages: [], seq: ctx.store.lastSeq });
  return json({ thread, seq: ctx.store.lastSeq });
}

export interface ChatSendRequest {
  message: string;
}

export async function postChat(ctx: Ctx, id: string, req: Request, publish: (m: unknown) => void): Promise<Response> {
  const card = ctx.store.getCard(id as CardId);
  if (!card) return fail(404, "no such card");

  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");

  const config = project.aiConfig;
  const provider = config.providers.find((p) => p.id === config.activeProviderId && p.enabled)
    ?? config.providers.find((p) => p.enabled);
  if (!provider) return fail(400, "no AI provider configured or enabled");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const messageText = (body as { message?: unknown }).message;
  if (typeof messageText !== "string" || messageText.trim().length === 0) {
    return fail(400, "message must be a non-empty string");
  }

  const userMessage: ChatMessage = { role: "user", content: messageText.trim(), createdAt: Date.now() };
  let thread = ctx.store.appendChatMessage(card.id, userMessage);

  publish({
    kind: "chatMessageAdded",
    seq: ctx.store.lastSeq,
    cardId: card.id,
    message: userMessage,
  });

  // Build context and stream in the background.
  const { createLlmClient, describeEmptyReply, systemMessage } = await import("@uassist/core");
  const client = createLlmClient(provider);

  const systemMsg = systemMessage(config.systemPrompt, {
    title: card.title,
    description: card.description,
    category: card.category,
    kind: card.kind,
  });

  const messagesForModel: ChatMessage[] = [
    systemMsg,
    ...thread.messages.filter((m) => m.role !== "system"),
  ];

  const controller = new AbortController();
  const run = async () => {
    try {
      let assistantContent = "";
      let finishReason: string | undefined;
      for await (const chunk of client.chat({
        messages: messagesForModel,
        model: provider.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        signal: controller.signal,
      })) {
        if (chunk.content) assistantContent += chunk.content;
        if (chunk.finishReason) finishReason = chunk.finishReason;
        publish({
          kind: "chatToken",
          seq: ctx.store.lastSeq,
          cardId: card.id,
          token: chunk.content,
          done: chunk.done,
        });
        if (chunk.done) break;
      }
      if (assistantContent.length === 0) {
        assistantContent = describeEmptyReply(finishReason, config.maxTokens) ?? assistantContent;
      }
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: assistantContent,
        name: provider.name,
        createdAt: Date.now(),
      };
      thread = ctx.store.appendChatMessage(card.id, assistantMessage);
      publish({
        kind: "chatMessageAdded",
        seq: ctx.store.lastSeq,
        cardId: card.id,
        message: assistantMessage,
        done: true,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: `Error: ${errorMessage}`,
        name: provider.name,
        createdAt: Date.now(),
      };
      thread = ctx.store.appendChatMessage(card.id, assistantMessage);
      publish({
        kind: "chatMessageAdded",
        seq: ctx.store.lastSeq,
        cardId: card.id,
        message: assistantMessage,
        done: true,
        error: true,
      });
    }
  };

  void run();

  return json({ thread, streaming: true, seq: ctx.store.lastSeq });
}
