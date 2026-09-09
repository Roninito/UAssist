/**
 * The store: bun:sqlite live layer + git-tracked JSON mirror + event log.
 *
 * Every mutation is one transaction that writes the row, appends an event, and
 * queues the mirror write. The database can always be thrown away and rebuilt
 * from the mirror — see rebuild().
 *
 * See design/uassist-spec.md Part IV.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { newId } from "./ids.ts";
import type { CardId, JobId, MilestoneId, ProjectId } from "./ids.ts";
import { Mirror } from "./mirror.ts";
import {
  serializeCard,
  serializeHealthItem,
  serializeMilestone,
  serializeProject,
  serializeSuggestion,
} from "./serialize.ts";
import type {
  AiConfig,
  Card,
  ChatMessage,
  ChatThread,
  DocThread,
  HealthItem,
  Job,
  JobState,
  LedgerEntry,
  Milestone,
  Project,
  Status,
  Suggestion,
  SuggestionKind,
  SuggestionSource,
  SuggestionStatus,
} from "./types.ts";
import { defaultAiConfig } from "./types.ts";
import { applyPragmas, migrate, SCHEMA_VERSION } from "./db/schema.ts";
import {
  cardToRow,
  chatMessageToRow,
  chatThreadToRow,
  docThreadToRow,
  healthToRow,
  jobToRow,
  ledgerEntryToRow,
  milestoneToRow,
  projectToRow,
  rowToCard,
  rowToDocThread,
  rowToHealth,
  rowToJob,
  rowToLedgerEntry,
  rowToMilestone,
  rowToProject,
  rowToSuggestion,
  rowToThread,
  rowToWorkspaceAsset,
  suggestionToRow,
  workspaceAssetToRow,
  type CardRow,
  type ChatThreadRow,
  type DocThreadRow,
  type HealthRow,
  type JobRow,
  type LedgerRow,
  type MilestoneRow,
  type ProjectRow,
  type SuggestionRow,
  type WorkspaceAssetLike,
  type WorkspaceAssetRow,
} from "./db/rows.ts";

export const UASSIST_DIR = ".uassist";
export const DB_FILE = "uassist.db";

export interface StoreEvent {
  seq: number;
  at: number;
  kind: string;
  [key: string]: unknown;
}

export interface StoreOptions {
  /** 0 disables debouncing — used by the CLI and by tests. */
  mirrorDebounceMs?: number;
  /** Open without creating anything. Throws if the project is missing. */
  readOnly?: boolean;
}

export class Store {
  readonly root: string;
  readonly dir: string;
  readonly db: Database;
  readonly mirror: Mirror;
  private seq: number;

  constructor(projectRoot: string, options: StoreOptions = {}) {
    this.root = projectRoot;
    this.dir = join(projectRoot, UASSIST_DIR);

    if (!existsSync(this.dir)) {
      if (options.readOnly) {
        throw new Error(
          `no UAssist project at ${projectRoot} — run \`uassist init\` first`,
        );
      }
      mkdirSync(this.dir, { recursive: true });
    }

    this.db = new Database(join(this.dir, DB_FILE), { create: true });
    applyPragmas(this.db);
    migrate(this.db);

    this.mirror = new Mirror(this.dir, {
      debounceMs: options.mirrorDebounceMs,
    });
    this.seq = this.readLastSeq();
  }

  close(): void {
    this.mirror.flush();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  private get eventLogPath(): string {
    return join(this.dir, "events.log");
  }

  private readLastSeq(): number {
    const path = this.eventLogPath;
    if (!existsSync(path)) return 0;
    const text = readFileSync(path, "utf8").trimEnd();
    if (text.length === 0) return 0;
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    try {
      return (JSON.parse(lastLine) as StoreEvent).seq ?? 0;
    } catch {
      return 0;
    }
  }

  /** Append to the JSONL event log. Returns the assigned sequence number. */
  appendEvent(kind: string, fields: Record<string, unknown> = {}): number {
    const event: StoreEvent = {
      seq: ++this.seq,
      at: Date.now(),
      kind,
      ...fields,
    };
    appendFileSync(this.eventLogPath, JSON.stringify(event) + "\n", "utf8");
    return event.seq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Replay events after `afterSeq`, for a reconnecting client. */
  eventsSince(afterSeq: number): StoreEvent[] {
    const path = this.eventLogPath;
    if (!existsSync(path)) return [];
    const out: StoreEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const e = JSON.parse(line) as StoreEvent;
        if (e.seq > afterSeq) out.push(e);
      } catch {
        // A truncated final line is possible after a hard kill; skip it.
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------

  getProject(): Project | undefined {
    const row = this.db
      .query<ProjectRow, []>("SELECT * FROM project LIMIT 1")
      .get();
    return row ? rowToProject(row) : undefined;
  }

  putProject(project: Project): void {
    const r = projectToRow(project);
    this.db.run(
      `INSERT INTO project (id, name, root_path, unity_project_path, blender_source_path,
                            workspace_scanned_at, plan_source_path, conventions,
                            daily_cap_usd, total_cap_usd, ai_config, engine_integration,
                            scan_schedule, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         root_path = excluded.root_path,
         unity_project_path = excluded.unity_project_path,
         blender_source_path = excluded.blender_source_path,
         workspace_scanned_at = excluded.workspace_scanned_at,
         plan_source_path = excluded.plan_source_path,
         conventions = excluded.conventions,
         daily_cap_usd = excluded.daily_cap_usd,
         total_cap_usd = excluded.total_cap_usd,
         ai_config = excluded.ai_config,
         engine_integration = excluded.engine_integration,
         scan_schedule = excluded.scan_schedule,
         updated_at = excluded.updated_at`,
      [
        r.id, r.name, r.root_path, r.unity_project_path, r.blender_source_path,
        r.workspace_scanned_at, r.plan_source_path, r.conventions, r.daily_cap_usd,
        r.total_cap_usd, r.ai_config, r.engine_integration, r.scan_schedule,
        r.created_at, r.updated_at,
      ],
    );
    this.mirror.writeFile("project.json", serializeProject(project));
  }

  // -------------------------------------------------------------------------
  // Milestones
  // -------------------------------------------------------------------------

  putMilestone(m: Milestone, opts: { event?: boolean } = {}): void {
    const r = milestoneToRow(m);
    this.db.run(
      `INSERT INTO milestones (id, title, phase_number, description, timebox,
                               gate_condition, demo_condition, status, source, source_key,
                               start_date, target_date, completed_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, phase_number = excluded.phase_number,
         description = excluded.description, timebox = excluded.timebox,
         gate_condition = excluded.gate_condition, demo_condition = excluded.demo_condition,
         status = excluded.status, source = excluded.source, source_key = excluded.source_key,
         start_date = excluded.start_date, target_date = excluded.target_date,
         completed_date = excluded.completed_date, updated_at = excluded.updated_at`,
      [
        r.id, r.title, r.phase_number, r.description, r.timebox,
        r.gate_condition, r.demo_condition, r.status, r.source, r.source_key,
        r.start_date, r.target_date, r.completed_date, r.created_at, r.updated_at,
      ],
    );
    this.mirror.enqueue({
      kind: "milestones",
      id: m.id,
      content: serializeMilestone(m),
    });
    if (opts.event !== false) {
      this.appendEvent("milestoneChanged", { id: m.id });
    }
  }

  getMilestone(id: MilestoneId): Milestone | undefined {
    const row = this.db
      .query<MilestoneRow, [string]>("SELECT * FROM milestones WHERE id = ?")
      .get(id);
    return row ? rowToMilestone(row) : undefined;
  }

  listMilestones(): Milestone[] {
    return this.db
      .query<MilestoneRow, []>(
        `SELECT * FROM milestones
         ORDER BY phase_number IS NULL, phase_number, created_at`,
      )
      .all()
      .map(rowToMilestone);
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  putCard(c: Card, opts: { event?: boolean } = {}): void {
    const r = cardToRow(c);
    const write = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO cards (id, title, description, milestone_id, category, subsystem,
                            kind, status, priority, assignee, owner, estimate, time_spent,
                            anchor, anchor_kind, anchor_path, source, source_key,
                            acceptance, tags, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, description = excluded.description,
           milestone_id = excluded.milestone_id, category = excluded.category,
           subsystem = excluded.subsystem, kind = excluded.kind,
           status = excluded.status, priority = excluded.priority,
           assignee = excluded.assignee, owner = excluded.owner,
           estimate = excluded.estimate, time_spent = excluded.time_spent,
           anchor = excluded.anchor, anchor_kind = excluded.anchor_kind,
           anchor_path = excluded.anchor_path, source = excluded.source,
           source_key = excluded.source_key, acceptance = excluded.acceptance,
           tags = excluded.tags, version = excluded.version,
           updated_at = excluded.updated_at`,
        [
          r.id, r.title, r.description, r.milestone_id, r.category, r.subsystem,
          r.kind, r.status, r.priority, r.assignee, r.owner, r.estimate, r.time_spent,
          r.anchor, r.anchor_kind, r.anchor_path, r.source, r.source_key,
          r.acceptance, r.tags, r.version, r.created_at, r.updated_at,
        ],
      );

      this.db.run("DELETE FROM card_links WHERE from_id = ?", [c.id]);
      const link = this.db.prepare(
        "INSERT OR IGNORE INTO card_links (from_id, to_id, rel) VALUES (?, ?, ?)",
      );
      for (const to of c.dependencies) link.run(c.id, to, "depends");
      for (const to of c.blockedBy) link.run(c.id, to, "blocked_by");
      for (const to of c.related) link.run(c.id, to, "related");
    });
    write();

    this.mirror.enqueue({ kind: "cards", id: c.id, content: serializeCard(c) });
    if (opts.event !== false) {
      this.appendEvent("cardChanged", { id: c.id });
    }
  }

  private linksFor(ids: string[]): Map<
    string,
    { dependencies: CardId[]; blockedBy: CardId[]; related: CardId[] }
  > {
    const out = new Map<
      string,
      { dependencies: CardId[]; blockedBy: CardId[]; related: CardId[] }
    >();
    for (const id of ids) {
      out.set(id, { dependencies: [], blockedBy: [], related: [] });
    }
    if (ids.length === 0) return out;

    // One query for the whole set, not one per card.
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query<{ from_id: string; to_id: string; rel: string }, string[]>(
        `SELECT from_id, to_id, rel FROM card_links
         WHERE from_id IN (${placeholders}) ORDER BY to_id`,
      )
      .all(...ids);

    for (const row of rows) {
      const bucket = out.get(row.from_id);
      if (!bucket) continue;
      const target = row.to_id as CardId;
      if (row.rel === "depends") bucket.dependencies.push(target);
      else if (row.rel === "blocked_by") bucket.blockedBy.push(target);
      else bucket.related.push(target);
    }
    return out;
  }

  private hydrate(rows: CardRow[]): Card[] {
    const links = this.linksFor(rows.map((r) => r.id));
    return rows.map((r) =>
      rowToCard(
        r,
        links.get(r.id) ?? { dependencies: [], blockedBy: [], related: [] },
      ),
    );
  }

  getCard(id: CardId): Card | undefined {
    const row = this.db
      .query<CardRow, [string]>("SELECT * FROM cards WHERE id = ?")
      .get(id);
    return row ? this.hydrate([row])[0] : undefined;
  }

  listCards(filter: {
    status?: Status;
    milestoneId?: MilestoneId;
    category?: string;
    limit?: number;
  } = {}): Card[] {
    // Columns are qualified because the milestone join also has `status`.
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status) {
      where.push("c.status = ?");
      args.push(filter.status);
    }
    if (filter.milestoneId) {
      where.push("c.milestone_id = ?");
      args.push(filter.milestoneId);
    }
    if (filter.category) {
      where.push("c.category = ?");
      args.push(filter.category);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ? `LIMIT ${Number(filter.limit)}` : "";

    const rows = this.db
      .query<CardRow, (string | number)[]>(
        `SELECT c.* FROM cards c
         LEFT JOIN milestones m ON m.id = c.milestone_id
         ${clause}
         ORDER BY m.phase_number IS NULL, m.phase_number, c.created_at
         ${limit}`,
      )
      .all(...args);
    return this.hydrate(rows);
  }

  findCardBySourceKey(sourceKey: string): Card | undefined {
    const row = this.db
      .query<CardRow, [string]>("SELECT * FROM cards WHERE source_key = ? LIMIT 1")
      .get(sourceKey);
    return row ? this.hydrate([row])[0] : undefined;
  }

  findMilestoneBySourceKey(sourceKey: string): Milestone | undefined {
    const row = this.db
      .query<MilestoneRow, [string]>(
        "SELECT * FROM milestones WHERE source_key = ? LIMIT 1",
      )
      .get(sourceKey);
    return row ? rowToMilestone(row) : undefined;
  }

  deleteCard(id: CardId): void {
    this.db.run("DELETE FROM cards WHERE id = ?", [id]);
    this.mirror.enqueue({ kind: "cards", id, content: null });
    this.appendEvent("cardDeleted", { id });
  }

  countCards(): number {
    return (
      this.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards")
        .get()?.n ?? 0
    );
  }

  /** Card counts by status, for the CLI summary and the dashboards. */
  cardCountsByStatus(): Record<string, number> {
    const rows = this.db
      .query<{ status: string; n: number }, []>(
        "SELECT status, COUNT(*) AS n FROM cards GROUP BY status",
      )
      .all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // -------------------------------------------------------------------------
  // Chat threads
  // -------------------------------------------------------------------------

  getChatThread(cardId: CardId): ChatThread | undefined {
    const row = this.db
      .query<ChatThreadRow, [string]>("SELECT * FROM chat_threads WHERE card_id = ?")
      .get(cardId);
    return row ? rowToThread(row) : undefined;
  }

  putChatThread(thread: ChatThread): void {
    const r = chatThreadToRow(thread);
    this.db.run(
      `INSERT INTO chat_threads (card_id, provider_id, model, messages, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         model = excluded.model,
         messages = excluded.messages,
         updated_at = excluded.updated_at`,
      [r.card_id, r.provider_id, r.model, r.messages, r.updated_at],
    );
    this.appendEvent("chatThreadChanged", { cardId: thread.cardId });
  }

  appendChatMessage(cardId: CardId, message: ChatMessage): ChatThread {
    const existing = this.getChatThread(cardId);
    const now = Date.now();
    const messages = existing ? [...existing.messages, message] : [message];
    const project = this.getProject();
    const config = project?.aiConfig;
    const maxContext = config?.maxContextMessages ?? 50;
    const trimmed = messages.length > maxContext + 1
      ? [messages[0]!, ...messages.slice(-maxContext)]
      : messages;
    const thread: ChatThread = {
      cardId,
      providerId: existing?.providerId,
      model: existing?.model,
      messages: trimmed,
      updatedAt: now,
    };
    this.putChatThread(thread);
    return thread;
  }

  // -------------------------------------------------------------------------
  // Document chat threads — see design/workspace-spec.md Part V
  // -------------------------------------------------------------------------

  getDocThread(docPath: string): DocThread | undefined {
    const row = this.db
      .query<DocThreadRow, [string]>("SELECT * FROM doc_chat_threads WHERE doc_path = ?")
      .get(docPath);
    return row ? rowToDocThread(row) : undefined;
  }

  putDocThread(thread: DocThread): void {
    const r = docThreadToRow(thread);
    this.db.run(
      `INSERT INTO doc_chat_threads (doc_path, provider_id, model, messages, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_path) DO UPDATE SET
         provider_id = excluded.provider_id,
         model = excluded.model,
         messages = excluded.messages,
         updated_at = excluded.updated_at`,
      [r.doc_path, r.provider_id, r.model, r.messages, r.updated_at],
    );
    this.appendEvent("docThreadChanged", { docPath: thread.docPath });
  }

  appendDocChatMessage(docPath: string, message: ChatMessage): DocThread {
    const existing = this.getDocThread(docPath);
    const messages = existing ? [...existing.messages, message] : [message];
    const project = this.getProject();
    const maxContext = project?.aiConfig.maxContextMessages ?? 50;
    const trimmed = messages.length > maxContext + 1
      ? [messages[0]!, ...messages.slice(-maxContext)]
      : messages;
    const thread: DocThread = {
      docPath,
      providerId: existing?.providerId,
      model: existing?.model,
      messages: trimmed,
      updatedAt: Date.now(),
    };
    this.putDocThread(thread);
    return thread;
  }

  // -------------------------------------------------------------------------
  // Workspace asset catalog — a cache of the filesystem, not authored
  // content, so there is no JSON mirror to write here. See
  // design/workspace-spec.md Part III.
  // -------------------------------------------------------------------------

  /**
   * Replace one source's slice of the catalog (Unity or Blender) in one
   * transaction. A full rescan supersedes whatever that source held before —
   * a deleted file must disappear from the catalog, not just fail to update.
   */
  replaceWorkspaceAssets(source: "unity" | "blender", assets: WorkspaceAssetLike[]): void {
    const replace = this.db.transaction((items: WorkspaceAssetLike[]) => {
      this.db.run("DELETE FROM workspace_assets WHERE source = ?", [source]);
      const insert = this.db.prepare(
        `INSERT INTO workspace_assets (path, source, kind, size_bytes, mtime_ms, class_names, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const asset of items) {
        const r: WorkspaceAssetRow = workspaceAssetToRow(asset);
        insert.run(r.path, r.source, r.kind, r.size_bytes, r.mtime_ms, r.class_names, r.hash);
      }
    });
    replace(assets);
    this.appendEvent("workspaceScanned", { source, count: assets.length });
  }

  findWorkspaceAsset(source: "unity" | "blender", path: string): WorkspaceAssetLike | undefined {
    const row = this.db
      .query<WorkspaceAssetRow, [string, string]>(
        "SELECT * FROM workspace_assets WHERE source = ? AND path = ?",
      )
      .get(source, path);
    return row ? rowToWorkspaceAsset(row) : undefined;
  }

  /** The full catalog for one source — the "before" snapshot reconcile.ts diffs a fresh scan against. */
  listWorkspaceAssets(source: "unity" | "blender"): WorkspaceAssetLike[] {
    return this.db
      .query<WorkspaceAssetRow, [string]>("SELECT * FROM workspace_assets WHERE source = ?")
      .all(source)
      .map(rowToWorkspaceAsset);
  }

  /**
   * Fuzzy-ish search for the anchor picker: a substring match against the
   * path and against detected class names, ranked shortest-path-first so an
   * exact or near-exact filename surfaces before a long, loosely-matching one.
   */
  searchWorkspaceAssets(query: string, opts: { kind?: string; source?: string; limit?: number } = {}): WorkspaceAssetLike[] {
    const where: string[] = [];
    const args: (string | number)[] = [];

    const q = query.trim();
    if (q.length > 0) {
      where.push("(path LIKE ? OR IFNULL(class_names, '') LIKE ?)");
      const like = `%${q}%`;
      args.push(like, like);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.source) {
      where.push("source = ?");
      args.push(opts.source);
    }

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 50, 200);

    const rows = this.db
      .query<WorkspaceAssetRow, (string | number)[]>(
        `SELECT * FROM workspace_assets ${clause} ORDER BY LENGTH(path) ASC LIMIT ${limit}`,
      )
      .all(...args);
    return rows.map(rowToWorkspaceAsset);
  }

  workspaceAssetCounts(): { total: number; byKind: Record<string, number> } {
    const rows = this.db
      .query<{ kind: string; n: number }, []>(
        "SELECT kind, COUNT(*) AS n FROM workspace_assets GROUP BY kind",
      )
      .all();
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    return { total, byKind };
  }

  // -------------------------------------------------------------------------
  // Jobs — see design/uassist-spec.md Part IX
  // -------------------------------------------------------------------------

  putJob(job: Job, opts: { event?: boolean } = {}): void {
    const r = jobToRow(job);
    this.db.run(
      `INSERT INTO jobs (id, card_id, agent, state, packet, worktree, acceptance,
                        budget, attempts, cost_usd, log_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         packet = excluded.packet,
         acceptance = excluded.acceptance,
         attempts = excluded.attempts,
         cost_usd = excluded.cost_usd,
         updated_at = excluded.updated_at`,
      [
        r.id, r.card_id, r.agent, r.state, r.packet, r.worktree, r.acceptance,
        r.budget, r.attempts, r.cost_usd, r.log_path, r.created_at, r.updated_at,
      ],
    );
    if (opts.event !== false) {
      this.appendEvent("jobUpdated", { id: job.id, cardId: job.cardId, state: job.state });
    }
  }

  getJob(id: JobId): Job | undefined {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? rowToJob(row) : undefined;
  }

  listJobsForCard(cardId: CardId): Job[] {
    return this.db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE card_id = ? ORDER BY created_at")
      .all(cardId)
      .map(rowToJob);
  }

  listJobs(filter: { state?: JobState } = {}): Job[] {
    if (filter.state) {
      return this.db
        .query<JobRow, [string]>("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC")
        .all(filter.state)
        .map(rowToJob);
    }
    return this.db
      .query<JobRow, []>("SELECT * FROM jobs ORDER BY created_at DESC")
      .all()
      .map(rowToJob);
  }

  // -------------------------------------------------------------------------
  // Cost ledger — see design/uassist-spec.md Part XI
  // -------------------------------------------------------------------------

  putLedgerEntry(entry: LedgerEntry): void {
    const r = ledgerEntryToRow(entry);
    this.db.run(
      `INSERT INTO ledger (id, job_id, card_id, agent, amount_usd, duration_ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.job_id, r.card_id, r.agent, r.amount_usd, r.duration_ms, r.at],
    );
    this.appendEvent("ledgerEntryAdded", { id: entry.id, jobId: entry.jobId, amountUsd: entry.amountUsd });
  }

  listLedgerEntries(opts: { sinceMs?: number } = {}): LedgerEntry[] {
    if (opts.sinceMs !== undefined) {
      return this.db
        .query<LedgerRow, [number]>("SELECT * FROM ledger WHERE at >= ? ORDER BY at DESC")
        .all(opts.sinceMs)
        .map(rowToLedgerEntry);
    }
    return this.db
      .query<LedgerRow, []>("SELECT * FROM ledger ORDER BY at DESC")
      .all()
      .map(rowToLedgerEntry);
  }

  /** Total spend today (since local midnight) — what the daily cap checks against. */
  ledgerTotalToday(): number {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const row = this.db
      .query<{ total: number | null }, [number]>(
        "SELECT SUM(amount_usd) AS total FROM ledger WHERE at >= ?",
      )
      .get(midnight.getTime());
    return row?.total ?? 0;
  }

  ledgerTotalAllTime(): number {
    const row = this.db.query<{ total: number | null }, []>("SELECT SUM(amount_usd) AS total FROM ledger").get();
    return row?.total ?? 0;
  }

  // -------------------------------------------------------------------------
  // Health items
  // -------------------------------------------------------------------------

  putHealthItem(h: HealthItem): void {
    const r = healthToRow(h);
    this.db.run(
      `INSERT INTO health_items (id, severity, source, fingerprint, message, anchor,
                                 anchor_kind, anchor_path, card_id, auto_close, resolved,
                                 first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, fingerprint) DO UPDATE SET
         severity = excluded.severity, message = excluded.message,
         anchor = excluded.anchor, anchor_kind = excluded.anchor_kind,
         anchor_path = excluded.anchor_path, card_id = excluded.card_id,
         resolved = excluded.resolved, last_seen_at = excluded.last_seen_at`,
      [
        r.id, r.severity, r.source, r.fingerprint, r.message, r.anchor,
        r.anchor_kind, r.anchor_path, r.card_id, r.auto_close, r.resolved,
        r.first_seen_at, r.last_seen_at,
      ],
    );
    this.mirror.enqueue({
      kind: "health",
      id: h.id,
      content: serializeHealthItem(h),
    });
  }

  listHealthItems(opts: { includeResolved?: boolean } = {}): HealthItem[] {
    const clause = opts.includeResolved ? "" : "WHERE resolved = 0";
    return this.db
      .query<HealthRow, []>(
        `SELECT * FROM health_items ${clause} ORDER BY severity, last_seen_at DESC`,
      )
      .all()
      .map(rowToHealth);
  }

  /**
   * Auto-close: after a validator run for `source` produces `currentFingerprints`,
   * resolve every open, `autoClose` item for that same source whose fingerprint
   * is *not* in that set — the condition it flagged no longer reproduces. See
   * HealthItem.fingerprint's own doc comment in types.ts. Items with
   * `autoClose: false` are left for a human to resolve regardless.
   *
   * Returns the number of items closed.
   */
  closeStaleHealthItems(source: string, currentFingerprints: ReadonlySet<string>): number {
    const open = this.db
      .query<HealthRow, [string]>(
        "SELECT * FROM health_items WHERE source = ? AND resolved = 0 AND auto_close = 1",
      )
      .all(source);
    let closed = 0;
    for (const row of open) {
      if (currentFingerprints.has(row.fingerprint)) continue;
      this.db.run("UPDATE health_items SET resolved = 1 WHERE id = ?", [row.id]);
      const item = rowToHealth(row);
      this.mirror.enqueue({
        kind: "health",
        id: item.id,
        content: serializeHealthItem({ ...item, resolved: true }),
      });
      closed++;
    }
    return closed;
  }

  // -------------------------------------------------------------------------
  // Suggestions — the Decisions queue. See design/automation-spec.md Part IV.
  // -------------------------------------------------------------------------

  /**
   * Propose a suggestion, deduped by fingerprint.
   *
   * A pending or rejected row with the same fingerprint blocks the insert
   * outright — that is the whole point of the fingerprint (never duplicate
   * an open decision, never resurrect one the human already said no to).
   * Accepted and held rows are both allowed to be superseded, reopening as
   * a fresh pending suggestion: for accepted, the same fact recurring is a
   * genuinely new situation; for held — automation-spec.md Part IV's own
   * words, "not now, ask me again later" — that is precisely what a held
   * suggestion resurfacing on the next reconciliation pass means. See
   * db/schema.ts's v4→v5 migration comment for why this can't be a plain
   * SQL constraint.
   *
   * Returns the resulting row, or undefined if the propose was a no-op
   * (something already pending or already rejected under this fingerprint).
   */
  proposeSuggestion(input: {
    kind: SuggestionKind;
    source: SuggestionSource;
    rationale: string;
    payload: Record<string, unknown>;
    fingerprint: string;
    relatedCardId?: CardId;
  }): Suggestion | undefined {
    const draft: Suggestion = {
      id: newId("suggestion"),
      kind: input.kind,
      source: input.source,
      rationale: input.rationale,
      payload: input.payload,
      fingerprint: input.fingerprint,
      relatedCardId: input.relatedCardId,
      status: "pending",
      createdAt: Date.now(),
    };
    const r = suggestionToRow(draft);
    const result = this.db.run(
      `INSERT INTO suggestions (id, kind, source, rationale, payload, fingerprint,
                                related_card_id, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT(fingerprint) DO UPDATE SET
         kind = excluded.kind,
         source = excluded.source,
         rationale = excluded.rationale,
         payload = excluded.payload,
         related_card_id = excluded.related_card_id,
         status = 'pending',
         created_at = excluded.created_at,
         decided_at = NULL
       WHERE suggestions.status IN ('accepted', 'held')`,
      [
        r.id, r.kind, r.source, r.rationale, r.payload, r.fingerprint,
        r.related_card_id, r.created_at,
      ],
    );
    if (result.changes === 0) return undefined;

    const row = this.db
      .query<SuggestionRow, [string]>("SELECT * FROM suggestions WHERE fingerprint = ?")
      .get(r.fingerprint);
    if (!row) return undefined;
    const suggestion = rowToSuggestion(row);
    this.mirror.enqueue({
      kind: "suggestions",
      id: suggestion.id,
      content: serializeSuggestion(suggestion),
    });
    this.appendEvent("suggestionProposed", {
      id: suggestion.id,
      kind: suggestion.kind,
      fingerprint: suggestion.fingerprint,
    });
    return suggestion;
  }

  getSuggestion(id: string): Suggestion | undefined {
    const row = this.db
      .query<SuggestionRow, [string]>("SELECT * FROM suggestions WHERE id = ?")
      .get(id);
    return row ? rowToSuggestion(row) : undefined;
  }

  listSuggestions(opts: { status?: SuggestionStatus } = {}): Suggestion[] {
    const rows = opts.status
      ? this.db
          .query<SuggestionRow, [string]>(
            "SELECT * FROM suggestions WHERE status = ? ORDER BY created_at DESC",
          )
          .all(opts.status)
      : this.db
          .query<SuggestionRow, []>("SELECT * FROM suggestions ORDER BY created_at DESC")
          .all();
    return rows.map(rowToSuggestion);
  }

  /** Apply a human decision: accepted, rejected, or held. */
  decideSuggestion(id: string, status: Exclude<SuggestionStatus, "pending">): Suggestion | undefined {
    const existing = this.getSuggestion(id);
    if (!existing) return undefined;
    const decided: Suggestion = { ...existing, status, decidedAt: Date.now() };
    const r = suggestionToRow(decided);
    this.db.run(
      `UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ?`,
      [r.status, r.decided_at, r.id],
    );
    this.mirror.enqueue({
      kind: "suggestions",
      id: decided.id,
      content: serializeSuggestion(decided),
    });
    this.appendEvent("suggestionDecided", { id: decided.id, status: decided.status });
    return decided;
  }

  /**
   * Erase a suggestion outright — distinct from `decideSuggestion(id, "rejected")`,
   * which keeps a permanent record (correctly so for a real decision).
   * For bulk artifacts of a since-fixed bug (a flooded scan against the
   * wrong path — see reconcile.ts's suspicious-scan circuit breaker) a
   * "rejected" record for each one is not a decision worth keeping forever
   * in the git-tracked mirror; this removes it entirely.
   */
  deleteSuggestion(id: string): void {
    this.db.run("DELETE FROM suggestions WHERE id = ?", [id]);
    this.mirror.enqueue({ kind: "suggestions", id, content: null });
    this.appendEvent("suggestionDeleted", { id });
  }

  // -------------------------------------------------------------------------
  // Rebuild
  // -------------------------------------------------------------------------

  /**
   * Drop the database and replay the JSON mirror into a fresh one.
   *
   * This is the recovery path after a `git pull`, a schema migration, or a
   * corrupted file — and the reason the mirror, not the database, is the
   * source of truth.
   */
  static rebuild(projectRoot: string): { milestones: number; cards: number; health: number; suggestions: number } {
    const dir = join(projectRoot, UASSIST_DIR);
    if (!existsSync(dir)) {
      throw new Error(`no UAssist project at ${projectRoot}`);
    }

    const dbPath = join(dir, DB_FILE);
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(dbPath + suffix, { force: true });
    }

    const store = new Store(projectRoot, { mirrorDebounceMs: 0 });
    const counts = { milestones: 0, cards: 0, health: 0, suggestions: 0 };

    const projectJson = join(dir, "project.json");
    if (existsSync(projectJson)) {
      store.putProject(JSON.parse(readFileSync(projectJson, "utf8")) as Project);
    }

    // Milestones first: cards carry a foreign key to them.
    for (const m of readMirror<Milestone>(dir, "milestones")) {
      store.putMilestone(m, { event: false });
      counts.milestones++;
    }
    for (const c of readMirror<Card>(dir, "cards")) {
      store.putCard(c, { event: false });
      counts.cards++;
    }
    for (const h of readMirror<HealthItem>(dir, "health")) {
      store.putHealthItem(h);
      counts.health++;
    }
    for (const s of readMirror<Suggestion>(dir, "suggestions")) {
      store.restoreSuggestion(s);
      counts.suggestions++;
    }

    store.appendEvent("dbRebuilt", { ...counts, schemaVersion: SCHEMA_VERSION });
    store.close();
    return counts;
  }

  /**
   * Reinsert a suggestion exactly as mirrored, keyed by id — used only by
   * rebuild(). A fingerprint that was ever superseded (Part IV: an accepted
   * suggestion reopened by a later recurrence) still maps to a single id and
   * a single mirror file across its lifetime (see proposeSuggestion), so
   * restoring by id can never collide with the fingerprint UNIQUE constraint.
   * proposeSuggestion's dedup gate does not apply here: this is replaying
   * already-decided history, not proposing anything new.
   */
  private restoreSuggestion(s: Suggestion): void {
    const r = suggestionToRow(s);
    this.db.run(
      `INSERT INTO suggestions (id, kind, source, rationale, payload, fingerprint,
                                related_card_id, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, source = excluded.source, rationale = excluded.rationale,
         payload = excluded.payload, fingerprint = excluded.fingerprint,
         related_card_id = excluded.related_card_id, status = excluded.status,
         created_at = excluded.created_at, decided_at = excluded.decided_at`,
      [
        r.id, r.kind, r.source, r.rationale, r.payload, r.fingerprint,
        r.related_card_id, r.status, r.created_at, r.decided_at,
      ],
    );
  }
}

function readMirror<T>(dir: string, kind: string): T[] {
  const path = join(dir, kind);
  if (!existsSync(path)) return [];
  const out: T[] = [];
  // Sorted so a rebuild is deterministic regardless of readdir order.
  for (const name of readdirSync(path).sort()) {
    if (!name.endsWith(".json")) continue;
    out.push(JSON.parse(readFileSync(join(path, name), "utf8")) as T);
  }
  return out;
}

/** Create a fresh project record and .uassist/ layout. */
export function initProject(
  projectRoot: string,
  name: string,
): { store: Store; project: Project } {
  const store = new Store(projectRoot, { mirrorDebounceMs: 0 });
  const existing = store.getProject();
  if (existing) return { store, project: existing };

  const now = Date.now();
  const project: Project = {
    id: newId("project") as ProjectId,
    name,
    rootPath: projectRoot,
    conventions: [],
    dailyCapUsd: 10,
    totalCapUsd: 200,
    aiConfig: defaultAiConfig(),
    createdAt: now,
    updatedAt: now,
  };
  for (const sub of ["cards", "milestones", "assets", "jobs", "health", "plans", "suggestions"]) {
    mkdirSync(join(store.dir, sub), { recursive: true });
  }
  store.putProject(project);
  store.appendEvent("projectInitialized", { id: project.id, name });
  return { store, project };
}
