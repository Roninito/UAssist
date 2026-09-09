/**
 * SQLite schema and migrations.
 *
 * The database is a cache. The JSON mirror in .uassist/ is the source of truth,
 * so a migration that goes wrong is recoverable with `uassist db rebuild` —
 * we are never migrating irreplaceable data.
 *
 * See design/uassist-spec.md Part IV.
 */

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 5;

const MIGRATIONS: ((db: Database) => void)[] = [
  // 0 → 1: initial schema
  (db) => {
    db.run(`
      CREATE TABLE project (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        root_path           TEXT NOT NULL,
        unity_project_path  TEXT,
        blender_source_path TEXT,
        conventions         TEXT NOT NULL DEFAULT '[]',
        daily_cap_usd       REAL NOT NULL DEFAULT 10,
        total_cap_usd       REAL NOT NULL DEFAULT 200,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      CREATE TABLE milestones (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        phase_number   INTEGER,
        description    TEXT NOT NULL DEFAULT '',
        timebox        TEXT,
        gate_condition TEXT,
        demo_condition TEXT,
        status         TEXT NOT NULL,
        source         TEXT,
        source_key     TEXT,
        start_date     INTEGER,
        target_date    INTEGER,
        completed_date INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE cards (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        description    TEXT,
        milestone_id   TEXT REFERENCES milestones(id) ON DELETE SET NULL,
        category       TEXT NOT NULL,
        subsystem      TEXT,
        kind           TEXT NOT NULL,
        status         TEXT NOT NULL,
        priority       TEXT NOT NULL,
        assignee       TEXT NOT NULL,
        owner          TEXT,
        estimate       TEXT,
        time_spent     REAL NOT NULL DEFAULT 0,
        anchor         TEXT,
        anchor_kind    TEXT,
        anchor_path    TEXT,
        source         TEXT,
        source_key     TEXT,
        acceptance     TEXT NOT NULL DEFAULT '[]',
        tags           TEXT NOT NULL DEFAULT '[]',
        version        INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX cards_board      ON cards(milestone_id, category, status);
      CREATE INDEX cards_status     ON cards(status);
      CREATE INDEX cards_anchor     ON cards(anchor_kind, anchor_path);
      CREATE INDEX cards_source_key ON cards(source_key);

      CREATE TABLE card_links (
        from_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        to_id   TEXT NOT NULL,
        rel     TEXT NOT NULL CHECK (rel IN ('depends','blocked_by','related')),
        PRIMARY KEY (from_id, to_id, rel)
      );

      CREATE TABLE assets (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        stage          TEXT NOT NULL,
        source_file    TEXT,
        engine_file    TEXT,
        provenance     TEXT NOT NULL,
        licence        TEXT NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        variants       TEXT NOT NULL DEFAULT '[]',
        dependents     TEXT NOT NULL DEFAULT '[]',
        derived_from   TEXT NOT NULL DEFAULT '[]',
        previews       TEXT NOT NULL DEFAULT '[]',
        version        INTEGER NOT NULL DEFAULT 1,
        last_exported_at INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX assets_stage ON assets(stage, kind);

      CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        agent       TEXT NOT NULL,
        state       TEXT NOT NULL,
        packet      TEXT NOT NULL,
        worktree    TEXT NOT NULL,
        acceptance  TEXT NOT NULL DEFAULT '[]',
        budget      TEXT NOT NULL,
        attempts    TEXT NOT NULL DEFAULT '[]',
        cost_usd    REAL NOT NULL DEFAULT 0,
        log_path    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX jobs_card  ON jobs(card_id);
      CREATE INDEX jobs_state ON jobs(state);

      CREATE TABLE health_items (
        id            TEXT PRIMARY KEY,
        severity      TEXT NOT NULL,
        source        TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        message       TEXT NOT NULL,
        anchor        TEXT,
        anchor_kind   TEXT,
        anchor_path   TEXT,
        card_id       TEXT REFERENCES cards(id) ON DELETE SET NULL,
        auto_close    INTEGER NOT NULL DEFAULT 1,
        resolved      INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX health_fingerprint ON health_items(source, fingerprint);
      CREATE INDEX health_open ON health_items(resolved, severity);

      CREATE TABLE history (
        id      TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        at      INTEGER NOT NULL,
        actor   TEXT NOT NULL,
        event   TEXT NOT NULL
      );

      CREATE INDEX history_card ON history(card_id, at);

      CREATE TABLE ledger (
        id          TEXT PRIMARY KEY,
        job_id      TEXT NOT NULL,
        card_id     TEXT NOT NULL,
        agent       TEXT NOT NULL,
        amount_usd  REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        at          INTEGER NOT NULL
      );

      CREATE INDEX ledger_at ON ledger(at);
    `);
  },

  // 1 → 2: per-card chat and AI provider config
  (db) => {
    db.run(`
      ALTER TABLE project ADD COLUMN ai_config TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE chat_threads (
        card_id      TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        provider_id  TEXT,
        model        TEXT,
        messages     TEXT NOT NULL DEFAULT '[]',
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX chat_threads_updated ON chat_threads(updated_at);
    `);
  },

  // 2 → 3: Asset Catalog and document chat. See design/workspace-spec.md.
  (db) => {
    db.run(`
      -- O(1) status reads instead of scanning events.log for the last
      -- "workspaceScanned" entry, which only gets more expensive with age.
      ALTER TABLE project ADD COLUMN workspace_scanned_at INTEGER;
      -- Absolute path of the last-imported plan source, so a re-import from
      -- the web UI (Part II, uassist-spec.md re-ingest workflow) does not
      -- require re-typing the path every time.
      ALTER TABLE project ADD COLUMN plan_source_path TEXT;

      -- A cache of the filesystem, not authored content: no JSON mirror.
      -- Rebuilding means rescanning the workspace, not replaying .uassist/.
      -- See design/workspace-spec.md Part III.
      CREATE TABLE workspace_assets (
        path        TEXT NOT NULL,
        source      TEXT NOT NULL CHECK (source IN ('unity','blender')),
        kind        TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        class_names TEXT,
        hash        TEXT NOT NULL,
        PRIMARY KEY (source, path)
      );

      CREATE INDEX workspace_assets_kind ON workspace_assets(kind);

      -- Deliberately a separate table from chat_threads rather than a
      -- generalized (subject_kind, subject_id) key on it: chat_threads has no
      -- JSON mirror and does not survive db rebuild today, so there is
      -- nothing durable at risk in a later migration that unifies them. See
      -- design/workspace-spec.md Part V, "Why a second table."
      CREATE TABLE doc_chat_threads (
        doc_path     TEXT PRIMARY KEY,
        provider_id  TEXT,
        model        TEXT,
        messages     TEXT NOT NULL DEFAULT '[]',
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX doc_chat_threads_updated ON doc_chat_threads(updated_at);
    `);
  },

  // 3 → 4: engine integration config (CLI/MCP method per engine). See
  // design/automation-spec.md Part II.
  (db) => {
    db.run(`ALTER TABLE project ADD COLUMN engine_integration TEXT;`);
  },

  // 4 → 5: scheduled scanning + the Decisions queue. See
  // design/automation-spec.md Parts III–IV.
  (db) => {
    db.run(`
      ALTER TABLE project ADD COLUMN scan_schedule TEXT;

      -- Propose-then-apply, never a direct write — Part VIII's rule stated
      -- once for the whole document and enforced structurally here: nothing
      -- reads this table to decide what to render on the board, only what to
      -- show the human as a pending decision.
      --
      -- fingerprint is UNIQUE outright, not just among open rows: "a rejected
      -- suggestion must not resurface" and "a pending one must not duplicate"
      -- are the same constraint (at most one row per fingerprint), while
      -- "accepted" and "held" are both allowed to be superseded later —
      -- accepted, because a genuinely new recurrence of the same fingerprint
      -- is a real new situation; held, because "not now, ask me again
      -- later" (Part IV) is exactly what resurfacing on the next
      -- reconciliation pass means. Handled by application logic
      -- (Store.proposeSuggestion) as an UPSERT gated on the existing row's
      -- status, not expressible as a plain SQL constraint.
      CREATE TABLE suggestions (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('reconciliation','assistant')),
        rationale      TEXT NOT NULL,
        payload        TEXT NOT NULL,
        fingerprint    TEXT NOT NULL UNIQUE,
        related_card_id TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     INTEGER NOT NULL,
        decided_at     INTEGER
      );

      CREATE INDEX suggestions_status ON suggestions(status, created_at DESC);
    `);
  },
];

/** Open pragmas. WAL so a reader never blocks the writer. */
export function applyPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
}

export function currentVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

/** Bring the database up to SCHEMA_VERSION. Returns the version it started at. */
export function migrate(db: Database): number {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${from} is newer than this build (v${SCHEMA_VERSION}). Upgrade uassist.`,
    );
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`missing migration ${v} → ${v + 1}`);
    db.transaction(() => {
      step(db);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return from;
}
