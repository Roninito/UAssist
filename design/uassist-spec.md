# UAssist Specification

**RastaCamp Studio · draft v0.2 (Bun) · September 2026**

**Purpose.** A Bun-built project coordination and asset-development tracker that works alongside **Unity** and **Blender**. It turns build plans into living kanbans, anchors work to real objects, coordinates with AI, and dispatches agents — without replacing the engines that actually make the game.

**Why Bun.** The core needs to be fast to change, git-native, headless-friendly, and one language end to end. Bun gives us a single runtime for the server, the CLI, the web UI, and the tests; `bun:sqlite` and `Bun.$` in the standard library instead of a dependency tree; and `bun build --compile` for a single-file binary when we want one. The whole tool is TypeScript, so a type defined in the domain model is the same type the board renders. Unity and Blender remain the authoring engines; UAssist is the assistant layer around them.

**What changed from v0.1.** v0.1 specified a Rust workspace with a Tauri shell. This revision moves the backend to Bun and makes the **web app the first-class target**, with Tauri deferred until the web UI is done. See `rust-to-bun-migration.md` for the decision record.

---

# Part I — Positioning

## What UAssist is

- A **living project map** for a game made in Unity + Blender.
- A **plan importer** that turns `unity-colony-build-plan.md`-style documents into milestones and cards.
- A **complex kanban** with status, category, milestone, assignee, and risk axes.
- An **AI coordination surface** where you discuss, dispatch, and review agent work.
- An **asset tracker** that follows every model, texture, animation, and sound from concept to shipped.
- A **validator runner** that turns project state into a self-writing backlog.

## What UAssist is not

- A game engine.
- A replacement for Unity, Blender, Git, or an IDE.
- A runtime component of the shipped game.
- A hosted service. It binds to localhost and reads your project directory.

## Core doctrine

Carried forward unchanged. The runtime changed; the rules did not.

1. **Tasks anchor to objects.** A card about a weapon is anchored to the Blender file, the Unity prefab, and the C# script.
2. **The backlog writes itself.** Validators emit health items; agents emit review items.
3. **Split work by verifiability.** Agents write code; humans run it and look at the result.
4. **Agents never touch the working tree.** Results arrive as reviewable diffs in isolated worktrees.
5. **Ship the game.** Every tool feature must name the thing in the game it unblocks.

A sixth rule earns its place in the Bun version:

6. **The database is a cache; the JSON is the source.** SQLite makes the board fast. The git-tracked JSON mirror is what survives. See Part IV.

---

# Part II — System architecture

```
┌─ Web UI (vanilla TS, served by Bun) ──────────────┐
│  Kanban board · Roadmap · Assistant chat          │
│  Dispatch panel · Asset browser · Review diffs    │
│  → later wrapped by Tauri, same build output      │
└──────────────┬────────────────────────────────────┘
               │ fetch (REST) + WebSocket (live events)
┌─ @uassist/server — one Bun.serve process ─────────┐
│  routes{} REST · websocket{} event bus            │
│  static/HTML routes with dev-mode HMR             │
└──────────────┬────────────────────────────────────┘
               │ direct import (same process)
┌─ @uassist/core ───────────────────────────────────┐
│  project · cards · milestones · assets · jobs     │
│  bun:sqlite store + JSON mirror writer            │
│  git worktree manager (Bun.$) · validator runner  │
│  agent adapters (Bun.spawn) · ledger · plan parser│
└──────────────┬────────────────────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
  ┌─ Unity Editor ─┐  ┌─ Blender ──────┐
  │  C# extension  │  │  Python add-on │
  │  context menu  │  │  context menu  │
  │  asset reporter│  │  asset reporter│
  └────────────────┘  └────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
   Git repo       File system
   (worktrees)    (watched)
```

The important structural difference from v0.1: **core and server are one process, not two**. In the Rust design, `uassist_core` was a library the server linked and the CLI linked separately. In Bun it still is — `@uassist/core` is imported by both — but there is no FFI boundary, no separate build step, and the CLI can start an in-process server without spawning a sidecar.

## Package layout

| Package | Responsibility | Ships where |
|---|---|---|
| `@uassist/core` | Domain model, SQLite store, JSON mirror, git ops, validators, agent dispatch, plan parsing | imported by server + CLI |
| `@uassist/server` | `Bun.serve` REST + WebSocket, event bus, static web UI | `bun run` daemon |
| `@uassist/cli` | Command-line control, CI hooks, batch dispatch | `bun build --compile` binary |
| `packages/server/web` | The web UI (vanilla TS, no framework) | served by the server; later loaded by Tauri |
| `integrations/unity` | C# Unity Editor extension | `Assets/Plugins/UAssist/` |
| `integrations/blender` | Python Blender add-on | `scripts/addons/uassist/` |

Bun workspaces (`"workspaces": ["packages/*"]`) resolve `@uassist/core` from source. There is no build step in development — Bun runs TypeScript directly.

## Why vanilla TS for the UI, and what that costs

The board is a dense grid with drag-and-drop, live updates, and a lot of cells. A framework is not doing much for us here: the state is one project snapshot, the updates arrive as discrete WebSocket events, and the expensive part is laying out the matrix, which we would be hand-tuning under any framework.

What we get:
- One process, zero build config. `Bun.serve` imports `web/index.html` directly; Bun bundles and hot-reloads it.
- No dependency churn in the layer most likely to outlive the tool.
- Tauri later loads exactly the same built page.

What it costs, stated honestly:
- **We hand-roll rendering.** The mitigation is a strict discipline: state lives in one store, every event produces a new snapshot, and render functions are pure `(state) => DocumentFragment`. Cells are keyed and diffed by id, not re-created wholesale.
- **No component ecosystem.** Drag-and-drop is native HTML5 DnD. Virtual scrolling, if the board gets big enough to need it, we write.
- If the hand-rolled renderer becomes the bottleneck for shipping, that is the trigger to reconsider — not before.

## Why the web app before Tauri

Tauri is a shell around a web page. Building the web page first means:
- Every feature is testable in a browser with devtools, no native toolchain.
- The server is exercised over real HTTP from day one, which is what Unity and Blender will also use.
- Tauri becomes a packaging task at the end, not an architecture constraint at the start.

The web UI must therefore assume nothing about being in Tauri. File-system access goes through the server API, never through a native bridge.

---

# Part III — Data model

All types are TypeScript, defined once in `@uassist/core` and imported by the server, the CLI, and the web UI. Branded id types keep a `CardId` from being passed where a `JobId` belongs.

## Ids

```ts
declare const brand: unique symbol;
type Id<T extends string> = string & { readonly [brand]: T };

export type ProjectId    = Id<"project">;
export type CardId       = Id<"card">;
export type MilestoneId  = Id<"milestone">;
export type AssetId      = Id<"asset">;
export type JobId        = Id<"job">;
export type HealthItemId = Id<"health">;

export const newId = <T extends string>(kind: T): Id<T> =>
  `${kind}_${Bun.randomUUIDv7()}` as Id<T>;
```

UUIDv7 is monotonic by time, so ids sort chronologically — which makes the append-only event log and the JSON mirror diff cleanly, and gives us a free creation-order sort without an extra column.

## Project

```ts
interface Project {
  id: ProjectId;
  name: string;
  rootPath: string;
  unityProjectPath?: string;
  blenderSourcePath?: string;
  conventions: string[];
  costLedger: CostLedger;
  createdAt: number;
  updatedAt: number;
}
```

Note what is *absent* versus v0.1: the Rust `Project` carried `Vec<CardId>`, `Vec<MilestoneId>`, and so on. With SQLite those are queries, not stored arrays, and storing them invited the two copies to disagree. Membership is a foreign key on the child row.

## Card

```ts
interface Card {
  id: CardId;
  title: string;
  description?: string;
  milestoneId?: MilestoneId;

  category: Category;          // "Systems" | "Gameplay" | "AI" | "UI" | "Audio" | "Art" | "Narrative" | "Infra"
  subsystem?: string;
  kind: CardKind;              // "task" | "deliverable" | "gate" | "decision" | "risk"

  status: Status;              // "open" | "active" | "blocked" | "review" | "done"
  priority: Priority;          // "blocker" | "high" | "normal" | "low"

  assignee: Assignee;
  owner?: string;

  estimate?: Estimate;         // { minWeeks, maxWeeks, confidence }
  timeSpentHours: number;

  anchor?: Anchor;
  source?: SourceRange;        // where in the imported plan this came from

  dependencies: CardId[];
  blockedBy: CardId[];
  related: CardId[];

  acceptance: AcceptanceCriterion[];
  tags: string[];

  version: number;
  createdAt: number;
  updatedAt: number;
}

type Assignee =
  | { kind: "human"; id: string; name: string }
  | { kind: "agent"; id: string; adapter: string }
  | { kind: "ai"; id: "assistant" }
  | { kind: "unassigned" };

interface AcceptanceCriterion {
  text: string;
  met: boolean;
  verifiedBy?: "human" | "validator" | "agent";
}
```

`jobs`, `comments`, and `history` are relations, not inline arrays — they live in their own tables and are joined on read. A card with fifty history events should not make the card row fifty events long.

## Anchor

A card anchors to a real object in either tool. Discriminated union, exhaustively switchable.

```ts
type Anchor =
  | { kind: "asset";           path: string }
  | { kind: "blenderObject";   blendFile: string; objectName: string }
  | { kind: "unityAsset";      path: string; guid?: string }
  | { kind: "unityGameObject"; scene: string; path: string; instanceId?: number }
  | { kind: "unityPrefab";     path: string }
  | { kind: "script";          path: string; range?: [number, number] }
  | { kind: "scene";           path: string }
  | { kind: "dataTable";       path: string; sheet?: string }
  | { kind: "commit";          sha: string }
  | { kind: "worktree";        path: string };
```

Anchors are stored as a JSON column and indexed on `kind` plus a computed `anchor_path` column, so "what work is open on this prefab?" is one indexed query rather than a scan.

## Asset

Every piece of authored content gets a row.

```ts
interface Asset {
  id: AssetId;
  name: string;
  kind: AssetKind;       // "mesh" | "texture" | "material" | "animation" | "audio" | "vfx" | "prefab" | "scene"
  stage: AssetStage;     // "concept" | "inProgress" | "inEngine" | "review" | "shippable" | "cut"

  sourceFile?: string;   // .blend, .psd, .wav
  engineFile?: string;   // .fbx, .prefab, .unity

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
```

## Milestone

```ts
interface Milestone {
  id: MilestoneId;
  title: string;
  phaseNumber?: number;
  description: string;
  timebox: Estimate;
  gateCondition?: string;
  demoCondition?: string;
  status: "planned" | "active" | "done" | "at-risk" | "slipped";
  startDate?: number;
  targetDate?: number;
  completedDate?: number;
}
```

## Job

```ts
interface Job {
  id: JobId;
  cardId: CardId;
  agent: string;              // adapter id
  state: JobState;
  packet: ContextPacket;
  worktree: string;
  acceptance: string[];
  budget: { maxCostUsd: number; maxDurationMs: number; maxAttempts: number };
  attempts: Attempt[];
  costUsd: number;
  logPath: string;
  createdAt: number;
  updatedAt: number;
}

type JobState =
  | "drafted" | "dispatched" | "running" | "awaiting_answer"
  | "returned" | "review" | "accepted" | "rejected" | "refined";
```

## WorkspaceAsset, Document, RegisteredProject

Three more records, specified in full in `workspace-spec.md` rather than here, because each carries a storage decision worth explaining in context rather than restating: `WorkspaceAsset` is a filesystem cache with deliberately no JSON mirror (Part III of that doc), `Document` is a plain file in `.uassist/docs/` with no database row at all (Part V), and `RegisteredProject` lives outside any single project's `.uassist/` entirely, in `~/.uassist/registry.json` (Part II). All three exist to make `Anchor` and `ContextPacket` reference real project artifacts instead of typed strings — see Part IV of `workspace-spec.md`.

## Runtime validation at the edges

TypeScript types vanish at runtime, and three of our inputs are untrusted: HTTP request bodies, Unity/Blender event posts, and agent adapter output. Each of those gets a parser at the boundary. We use hand-written narrow validators in `core/schema.ts` rather than pulling in a validation library — the shapes are small, closed, and change with the spec.

Interior code trusts its types. Only the edges parse.

---

# Part IV — Persistence

## The two-layer store

`bun:sqlite` is the live store. A deterministic JSON mirror in `.uassist/` is the git-tracked source of truth.

```
project/
  .uassist/
    uassist.db             # bun:sqlite — live store, gitignored
    project.json           # project config
    cards/                 # one JSON per card, mirrored on write
    milestones/
    assets/
    jobs/
    health/
    plans/                 # imported plan sources, verbatim
    ledger.json
    conventions.json
    events.log             # append-only JSONL
    worktrees/             # active job worktrees, gitignored
```

**Why both.** The v0.1 doctrine — "everything is a text file, no opaque blobs" — is what makes the project reviewable, mergeable, and recoverable. But the board is a matrix query (status × category × milestone, filtered, with join counts for jobs and health items), and answering that by loading every JSON file into memory and scanning gets slower with every card. SQLite answers it in one statement.

So: **SQLite is a cache you can delete.** The JSON mirror is what git tracks, what a human reads, and what a teammate merges.

### Write path

Every mutation is a transaction that does both:

```ts
const write = db.transaction((card: Card) => {
  upsertCardRow(card);            // 1. SQLite row
  appendEvent({ kind: "CardChanged", id: card.id, fields });  // 2. events.log
  mirrorQueue.enqueue(card);      // 3. JSON mirror, debounced
});
```

The JSON mirror write is debounced (default 250ms) and coalesced per record, so dragging a card across four columns produces one file write, not four. On process exit the queue flushes synchronously.

### Deterministic JSON

Clean git diffs require byte-stable output. The mirror writer:
- Emits keys in a fixed order declared per record type, never `Object.keys` order.
- Writes two-space indent, trailing newline, `\n` line endings.
- Omits `undefined` fields entirely rather than writing `null`.
- Sorts every id array before writing.

```ts
function serializeCard(card: Card): string {
  return JSON.stringify(pick(card, CARD_KEY_ORDER), null, 2) + "\n";
}
```

### Rebuild path

```bash
uassist db rebuild     # drop uassist.db, replay .uassist/**/*.json into a fresh db
```

This runs automatically when the db is missing, when its `schema_version` is behind the binary, or when a `.json` file's mtime is newer than the row it mirrors (which is what happens after `git pull` or a manual edit). Rebuild is the recovery story for every corruption case, and it is fast because the JSON is already the whole dataset.

### Schema sketch

```sql
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  milestone_id  TEXT REFERENCES milestones(id),
  category      TEXT NOT NULL,
  subsystem     TEXT,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      TEXT NOT NULL,
  assignee      TEXT NOT NULL,   -- JSON
  owner         TEXT,
  estimate      TEXT,            -- JSON
  time_spent    REAL NOT NULL DEFAULT 0,
  anchor        TEXT,            -- JSON
  anchor_kind   TEXT,            -- extracted for indexing
  anchor_path   TEXT,            -- extracted for indexing
  acceptance    TEXT NOT NULL,   -- JSON array
  tags          TEXT NOT NULL,   -- JSON array
  version       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX cards_board  ON cards(milestone_id, category, status);
CREATE INDEX cards_anchor ON cards(anchor_kind, anchor_path);

CREATE TABLE card_links (        -- dependencies / blockedBy / related
  from_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rel     TEXT NOT NULL CHECK (rel IN ('depends','blocked_by','related')),
  PRIMARY KEY (from_id, to_id, rel)
);

CREATE TABLE history (
  id       TEXT PRIMARY KEY,
  card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at       INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  event    TEXT NOT NULL          -- JSON
);
```

Pragmas set at open: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`.

### Migrations

A `schema_version` table plus an ordered list of migration functions in `core/db/migrations.ts`. Because the JSON mirror is authoritative, a migration that goes wrong is recoverable by `uassist db rebuild` against the new schema — we are never migrating irreplaceable data.

## Storage principles

- The git-tracked layer is text. No opaque blobs in source control.
- Deterministic key ordering for clean diffs.
- Append-only `events.log` (JSONL) for audit, replay, and debugging.
- Records carry an explicit `version` that bumps on edit.
- The database can always be thrown away and rebuilt.

---

# Part V — Plan importer

## Supported inputs

- Markdown build plans with phase headings and bullet tasks.
- YAML/JSON structured plans.
- The format used in `unity-colony-build-plan.md`.

## Extraction rules

| Markdown pattern | Creates |
|---|---|
| `## Phase N — Title` | Milestone |
| `*N–M weeks.*` | Milestone timebox |
| `### System / Subsystem` | Category tag + subsystem |
| `- [ ] Task text` or `- Task text` | Card |
| `**Exit gate.** ...` | Gate card + acceptance criteria |
| `**Exit demo.** ...` | Deliverable card + acceptance criteria |
| Tables | Stack/dependency data, not cards |

## Implementation

A hand-written line scanner in `core/plan/parse.ts`, not a general Markdown AST. The grammar we care about is a dozen line shapes, and a scanner gives us exact source line numbers for free — which is what `SourceRange` needs to make re-ingest work.

```ts
interface SourceRange { file: string; startLine: number; endLine: number; }

function parsePlan(markdown: string, file: string): ParsedPlan;
```

## Stable identity across re-ingest

The whole re-ingest feature depends on recognizing "this is the same card as last time" after the text has been edited. Identity is a content hash of `(milestone slug, subsystem slug, normalized title)`, stored on the card as `sourceKey`. Normalization lowercases, strips punctuation, and collapses whitespace, so fixing a typo in a task does not orphan its card.

When the hash misses, we fall back to fuzzy title match within the same milestone above a similarity threshold, and present those as **renames** in the diff rather than as an add plus a delete.

## Re-ingest workflow

1. User edits the markdown plan.
2. `uassist plan import` re-parses and computes a structural diff against current state.
3. Diff shows: added cards, removed cards, renamed cards, changed acceptance, moved milestones.
4. User reviews and applies.
5. Cards with job history or manual edits are **never** silently deleted — they are marked `orphaned` and surfaced for a decision.

The plan source is copied verbatim into `.uassist/plans/` on every import, so the diff is against a known previous text, not a guess.

---

# Part VI — Kanban board

## Default complex view

- **Columns:** `Status` (open → active → blocked → review → done)
- **Rows:** `Category`
- **Swimlanes:** `Milestone`
- **Fixed lane at bottom:** `Health`

## Preset views

| View | Columns | Rows | Swimlanes |
|---|---|---|---|
| Plan | Status | Category | Milestone |
| Assignments | Status | Assignee | Milestone |
| Risk | Priority | Category | Confidence |
| Timeline | Week | Category | Assignee |
| Asset tracker | Asset stage | Asset kind | Milestone |
| Agent workload | Status | Agent | Milestone |

## The board is a query

A view is an axis assignment plus filters, compiled to SQL:

```ts
interface BoardView {
  id: string;
  name: string;
  columns: AxisConfig;
  rows?: AxisConfig;
  swimlanes?: AxisConfig;
  filters: FilterConfig;
  sort: SortConfig;
}

type AxisConfig =
  | { kind: "status" } | { kind: "assignee" } | { kind: "milestone" }
  | { kind: "priority" } | { kind: "category" } | { kind: "subsystem" }
  | { kind: "week" } | { kind: "confidence" }
  | { kind: "assetStage" } | { kind: "assetKind" } | { kind: "agent" };
```

`GET /board?view=plan` returns cells already bucketed by the server — `{ swimlane, row, column, cards[] }` — so the client renders rather than groups. This keeps the pivot logic in one place, tested against SQL, and keeps the payload small when filters are narrow.

## Card signals

- Human-owned: cyan left border.
- Agent-owned: amber left border.
- AI-coordinated: amber outline.
- Blocker: red tint, blocked badge.
- Gate/deliverable: distinct shape, progress bar.
- Health item: fixed health lane, cannot hide.

## Rendering approach

State is one immutable snapshot. WebSocket events produce a new snapshot; the renderer diffs by card id and touches only changed cells. Cards are `<article data-card-id>` elements; moving one between columns moves the node, it does not rebuild the column.

Drag-and-drop uses native HTML5 DnD with `dataTransfer` carrying the card id. The drop handler issues an optimistic local move, `PATCH`es the card, and reconciles on the WebSocket echo — reverting the node on failure.

## Interactions

- Drag a card to change status/assignment/category.
- Right-click → **Discuss** or **Dispatch**.
- Click → detail panel with acceptance, jobs, history, anchor, related files.
- Drop a file, GameObject, or asset onto a card to add an anchor.

---

# Part VII — Asset development tracking

## Lifecycle stages

```
Concept → In Progress → In Engine → Review → Shippable → Cut
```

## Per-asset detail view

Source file, engine file, export/version history, provenance and licence, dependents and dependencies, attached cards and jobs, previews, validation status.

## Blender integration

The Blender add-on reports: new `.blend` saved, object renamed/deleted, export to `.fbx`/`.gltf`, render preview. Events go to `POST /events`. UAssist creates or updates the asset record and checks for broken dependents.

## Unity integration

The C# Editor extension reports asset import/move/delete, prefab saved, scene saved, selection changed — and adds context menus for **Create UAssist card**, **Send to UAssist → Discuss / Dispatch**, and **View open work**.

## File watching fallback

When no plugin is active, the server watches `Assets/`, `Blender/`, and other configured directories with `fs.watch` (recursive, which is native on macOS and Windows). Events are debounced per path at 300ms because editors write-then-rename and would otherwise fire three times per save.

New or changed files create `unverified` asset records that the user links to the correct source later. The watcher honors a `.uassistignore` and always skips `Library/`, `Temp/`, `obj/`, and `.git/` — watching Unity's `Library/` is the classic way to melt a file watcher.

---

# Part VIII — AI coordination

## Assistant chat panel

Docked or floating panel in the web UI. Three modes:

1. **Discuss** — ask questions, get breakdowns, clarify scope.
2. **Dispatch** — turn a card into an agent job.
3. **Review** — inspect returned diffs.

## Typed chips

Drag anything into the composer:

```ts
type Chip =
  | { kind: "card";      id: CardId }
  | { kind: "milestone"; id: MilestoneId }
  | { kind: "asset";     id: AssetId }
  | { kind: "anchor";    anchor: Anchor }
  | { kind: "health";    id: HealthItemId }
  | { kind: "file";      path: string; range?: [number, number] }
  | { kind: "text";      value: string };
```

## Example commands

| Command | Assistant action |
|---|---|
| "Break Phase 2 into tasks" | Propose cards with dependencies and acceptance criteria. |
| "What depends on the item data model?" | Trace asset and card dependency graph. |
| "Dispatch this to opencode" | Assemble context packet, choose adapter, create job. |
| "Why is this card blocked?" | Report `blockedBy`, failed jobs, unanswered questions. |
| "Show this week's digest" | Summarize done/active/blocked/agent spend. |

## Where the model runs

The assistant is a server-side concern. The web UI posts to `POST /assistant/message` and streams the reply back over the existing WebSocket. Streaming through the WebSocket rather than SSE means one connection carries chat tokens, job progress, and board events in order — the client already has the plumbing.

Provider configuration lives in `.uassist/conventions.json` alongside the project conventions, and the API key is read from the environment, never from a tracked file.

## Dispatch flow

1. Select card.
2. Click dispatch icon.
3. UAssist auto-assembles a `ContextPacket` — objective, anchor state, related files, acceptance criteria, project conventions, prior jobs on this card.
4. User edits the packet.
5. Choose agent adapter.
6. Set budget (cost, duration, max attempts).
7. UAssist creates a git worktree and dispatches.
8. Job appears on the card with live status.

---

# Part IX — Agent dispatch

## Job lifecycle

| State | Meaning | Card status |
|---|---|---|
| `drafted` | Packet prepared, not sent | `open` |
| `dispatched` | Agent started in worktree | `active` |
| `running` | Agent is executing | `active` |
| `awaiting_answer` | Agent needs human input | `blocked` |
| `returned` | Diff/files ready | `review` |
| `review` | Human reviewing | `review` |
| `accepted` | Merged to working tree | `done` |
| `rejected` | Returned for retry | `open` |
| `refined` | Retrying with corrections | `active` |

## Agent adapters

Thin TypeScript modules that wrap CLI agents via `Bun.spawn`.

```ts
interface AgentAdapter {
  readonly id: string;
  capabilities(): Capability[];
  dispatch(packet: ContextPacket, worktree: string, budget: Budget): Promise<JobHandle>;
  events(handle: JobHandle): AsyncIterable<AgentEvent>;
  cancel(handle: JobHandle): Promise<void>;
}
```

The v0.1 Rust trait had a `poll()` returning a batch of events. Bun gives us async iterators over the child's stdout, so the adapter **pushes** events instead of being polled:

```ts
async *events(handle: JobHandle): AsyncIterable<AgentEvent> {
  for await (const line of handle.proc.stdout as ReadableStream) {
    const evt = this.parseLine(line);
    if (evt) yield evt;
  }
}
```

Each yielded event updates the job row, appends to `events.log`, and broadcasts on the WebSocket. The board shows agent progress as it happens, with no polling interval to tune.

### Built-in adapters

- `opencode` — local opencode CLI.
- `claude-code` — Claude Code CLI, `--print --output-format stream-json` for parseable events.
- `copilot-cli` — optional.

### Process discipline

- Every child gets an `AbortSignal` wired to the budget timeout and to `cancel()`.
- Children are spawned in the worktree with `cwd`, an explicit `env` allowlist, and `stdio: ["ignore", "pipe", "pipe"]`.
- stdout and stderr are tee'd to `.uassist/jobs/{id}.log` as they stream, so a crashed server still leaves a readable log.
- On server shutdown, running jobs are sent SIGTERM, given a grace period, then SIGKILL; their state is written as `dispatched` with a `resumable` flag rather than silently lost.

## Worktree isolation

- Each job gets `project/.uassist/worktrees/job-{id}/`.
- Worktree is branched from current HEAD.
- Git operations use `Bun.$` with tagged-template interpolation, which escapes arguments — paths with spaces and branch names from user input do not become shell injection:

```ts
await $`git worktree add ${dir} -b ${branch} ${baseSha}`.cwd(root).quiet();
```

- The agent runs inside the worktree with environment variables pointing back at UAssist for progress and questions.
- On completion UAssist computes a diff stat and presents it for review.
- On accept, UAssist applies the diff to the main working tree as a reviewed commit.
- Worktrees are reaped on accept/reject; orphans are cleaned by `uassist worktree prune`.

---

# Part X — Validators and health

## Validator interface

```ts
interface Validator {
  readonly id: string;
  readonly triggers: ("save" | "build" | "demand" | "interval")[];
  run(project: ProjectContext): Promise<HealthItem[]>;
}
```

Validators run concurrently with `Promise.allSettled` — one throwing validator must not take down a health sweep — and each is given a deadline.

## MVP validators

| Validator | Emits when |
|---|---|
| `compile_errors` | Unity or C# compile fails |
| `missing_licence` | Imported asset has no licence entry |
| `missing_reference` | Prefab/script field is unassigned |
| `navmesh_bake` | Scene has NavMesh agents but no baked data |
| `scene_lint` | Duplicate IDs, unreachable interactables |
| `asset_stage` | Asset stuck in `inProgress` without an active card |
| `budget` | Scene exceeds tri/draw-call target |
| `save_smoke` | Save/load round-trip fails |
| `stale_branch` | Worktree base drift exceeds threshold |
| `plan_gate` | Milestone gate condition not met by target date |

## Health item model

```ts
interface HealthItem {
  id: HealthItemId;
  severity: "blocker" | "high" | "normal" | "low";
  source: string;          // validator id
  fingerprint: string;     // stable across runs — dedupes and enables auto-close
  message: string;
  anchor?: Anchor;
  cardId?: CardId;         // auto-linked if one exists
  autoClose: boolean;      // closes when the validator stops emitting this fingerprint
  firstSeenAt: number;
  lastSeenAt: number;
}
```

`fingerprint` is the addition that makes auto-close honest: a validator run produces a set of fingerprints, and any open auto-close item from that validator whose fingerprint is absent gets resolved. Without it, re-running a validator either duplicates items or never closes them.

Health items live in the fixed health lane and cannot be hidden.

---

# Part XI — Cost ledger

```ts
interface LedgerEntry {
  id: string;
  jobId: JobId;
  cardId: CardId;
  agent: string;
  amountUsd: number;
  durationMs: number;
  at: number;
}

interface CostLedger {
  dailyCapUsd: number;
  totalCapUsd: number;
}
```

- Entries are rows; caps are project config.
- Hard stop at cap: dispatch is refused, not throttled, and the refusal says which cap and what the current total is.
- The cap is checked at dispatch **and** on every cost event during a run, so a runaway job is killed mid-flight rather than discovered afterward.
- Per-card and per-milestone totals are aggregate queries.
- `uassist ledger --format csv` exports for accounting.

---

# Part XII — Roadmap and dashboards

## Milestone roadmap

Horizontal timeline. Milestones as bars, colored by status: `planned` grey, `active` cyan, `done` green, `at-risk` amber, `slipped` red.

## Dashboards

- **Work progress:** cards by status per milestone.
- **Risk radar:** blockers, at-risk cards, unanswered questions.
- **Asset pipeline:** assets by stage and kind.
- **Agent activity:** jobs per adapter, cost, success rate.
- **Health trends:** new health items per day by validator.

All five are SQL aggregates over the live store, served from `GET /dashboard/{name}`. Nothing is precomputed.

---

# Part XIII — Communication protocol

## Local server

`@uassist/server` binds `127.0.0.1:7373` by default. One `Bun.serve` call carries REST routes, the WebSocket upgrade, and the web UI.

```ts
Bun.serve({
  port: 7373,
  hostname: "127.0.0.1",
  development: process.env.NODE_ENV !== "production",   // HMR + detailed errors

  routes: {
    "/":               indexHtml,                       // imported HTML, bundled by Bun
    "/api/project":    { GET: getProject },
    "/api/cards":      { GET: listCards, POST: createCard },
    "/api/cards/:id":  { GET: getCard, PATCH: patchCard, DELETE: deleteCard },
    "/api/board":      { GET: getBoard },
    "/api/plans/import": { POST: importPlan },
    "/api/jobs":       { GET: listJobs, POST: dispatchJob },
    "/api/jobs/:id":   { GET: getJob },
    "/api/jobs/:id/accept": { POST: acceptJob },
    "/api/jobs/:id/reject": { POST: rejectJob },
    "/api/health":     { GET: listHealth },
    "/api/health/run": { POST: runValidators },
    "/api/assets":     { GET: listAssets },
    "/api/events":     { POST: ingestToolEvent },        // Unity / Blender reporters
    "/api/assistant/message": { POST: assistantMessage },
  },

  websocket: {
    open(ws)    { ws.subscribe("project"); },
    message(ws, msg) { handleClientMessage(ws, msg); },
    close(ws)   { /* subscriptions drop automatically */ },
  },

  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Not found", { status: 404 });
  },
});
```

Two Bun specifics worth naming:

- **`routes` with path params** replaces the hand-rolled router the Rust version needed a crate for.
- **`server.publish("project", payload)`** broadcasts to every subscribed client in one call. The event bus is the WebSocket pub/sub, not a separate structure.

## Binding and safety

The server binds loopback only. It is not authenticated, because it is not reachable — that is the entire security model, and it is why `hostname` is not configurable to `0.0.0.0` without an explicit `--unsafe-bind` flag that logs a warning. Unity and Blender talk to it over loopback from the same machine.

CORS is permissive for `127.0.0.1` and `localhost` origins only, so a Vite-style dev server or the Tauri shell can reach it, and a random web page cannot.

## Event schema

```ts
type ServerEvent =
  | { kind: "cardChanged";        id: CardId; fields: string[] }
  | { kind: "cardCreated";        id: CardId }
  | { kind: "cardDeleted";        id: CardId }
  | { kind: "jobUpdated";         id: JobId; state: JobState }
  | { kind: "jobOutput";          id: JobId; chunk: string }
  | { kind: "assetUpdated";       id: AssetId; stage: AssetStage }
  | { kind: "healthItemCreated";  id: HealthItemId }
  | { kind: "healthItemResolved"; id: HealthItemId }
  | { kind: "questionAsked";      jobId: JobId; question: AgentQuestion }
  | { kind: "assistantToken";     messageId: string; text: string }
  | { kind: "planImported";       added: number; removed: number; renamed: number };
```

Every event carries a monotonic `seq`. A client that reconnects sends its last `seq` and gets the gap replayed from `events.log`, or a full-snapshot instruction if the gap is too large. Without this, a laptop lid closing silently desynchronizes the board.

---

# Part XIV — Unity Editor extension

## Features

- **UAssist window**, dockable in the Unity Editor.
- **Context menu on assets/GameObjects:** `Create UAssist card`, `Send to UAssist → Discuss`, `Send to UAssist → Dispatch`, `View open work`.
- **Auto-report:** asset import/move/delete, prefab/scene save, play-mode errors.
- **In-editor health lane:** small overlay showing open health items for the current scene.

## Implementation

- C# in `Assets/Plugins/UAssist/Editor/`.
- Talks to the server over HTTP on loopback; posts events to `/api/events`.
- Caches current selection and scene state locally.
- No runtime component in the game build.

The C# side is unchanged by the move to Bun — it was always speaking HTTP to a local port.

---

# Part XV — Blender add-on

## Features

- **UAssist panel** in the sidebar.
- **Context menu on objects/collections:** `Create UAssist card`, `Send to UAssist → Discuss / Dispatch`.
- **Auto-report:** `.blend` saved, object renamed/deleted, export operator invoked, render preview generated.
- **Export helpers:** one-click export to `.fbx`/`.gltf` with naming conventions, reported to UAssist.

## Implementation

- Python add-on in `scripts/addons/uassist/`.
- Talks to the server via `urllib` on loopback.
- Registers handlers on `save_post`, `depsgraph_update_post`, `render_complete`.

Also unchanged by the runtime move.

---

# Part XVI — CLI

```bash
uassist init                    # initialize .uassist in current project
uassist plan import plan.md     # import/update plan (--dry-run shows the diff)
uassist board                   # start server and open the web UI
uassist serve                   # start server only
uassist cards --status blocked  # list cards
uassist dispatch {card-id}      # dispatch a card to an agent
uassist jobs                    # list jobs
uassist health                  # run validators and show health
uassist ledger                  # show cost ledger
uassist db rebuild              # drop and replay SQLite from the JSON mirror
uassist worktree prune          # clean orphaned job worktrees
uassist export --format csv     # export cards or assets
```

Argument parsing uses `util.parseArgs` from Bun's Node compatibility layer — no dependency for what clap did in v0.1.

## Shipping the CLI

```bash
bun build packages/cli/src/uassist.ts --compile --outfile dist/uassist
```

produces a single executable with the runtime embedded. That is the distribution story: a binary, same as the Rust plan, without a cross-compilation matrix to maintain first.

## CI hooks

- `uassist health --fail-on blocker` blocks a merge on blocker-severity health items.
- `uassist plan check` verifies the plan has no orphan phases.

---

# Part XVII — Phasing

Reordered from v0.1: **the web app comes before the desktop shell**, and Tauri is the last packaging step rather than a Phase 1 architecture commitment.

## Phase 0 — Core model, store, plan import (2 weeks)

- `@uassist/core`: types, SQLite schema, JSON mirror writer, deterministic serialization.
- Markdown plan parser with `sourceKey` identity.
- `@uassist/cli`: `init`, `plan import`, `cards`, `db rebuild`.
- Tests: round-trip a card through SQLite and the mirror; rebuild produces byte-identical JSON.

**Exit gate:** import `unity-colony-build-plan.md`, produce a coherent card list, delete the db, rebuild it, and get identical output.

## Phase 1 — Server and web kanban (3 weeks)

- `Bun.serve` REST + WebSocket, event `seq` and replay.
- Web UI: default complex view (status × category × milestone), drag to change status, detail panel.
- Board-as-query endpoint.

**Exit gate:** open `localhost:7373`, see the colony plan as a kanban, drag a card, watch a second browser tab update live.

## Phase 2 — Plan re-ingest and views (1–2 weeks)

- Structural diff with adds/removes/renames, reviewable before apply.
- Preset views and swimlanes.
- Milestone roadmap.

**Exit gate:** edit the plan markdown, re-import, review the diff, apply it without losing a card that has history.

## Phase 1.5 — Workspace, Asset Catalog, and Registry (see `workspace-spec.md`)

Inserted here rather than left folded into Phase 5, because a card anchored to a real file — not a typed guess — has to exist before Phase 3 can assemble a context packet worth sending to an agent. Full spec in `workspace-spec.md`.

- Project Registry (`~/.uassist/registry.json`) and the Project Meta page.
- Workspace linking (Unity/Blender paths) and validation.
- Asset Catalog: on-demand filesystem scan, no JSON mirror (a cache of the filesystem, not authored content).
- Anchor picker in the card detail panel, backed by catalog search.
- Docs page: list/view/edit `.uassist/docs/*.md`, v1 AI chat scoped to a document.
- **Amendment, see `automation-spec.md` Part I:** `uassist init` gains headless-or-task Unity bootstrap and a `workspaceComplete` flag — initialization stops being something a project can silently skip.

**Exit gate:** link a real Unity project path, scan it, attach a card's anchor to a real script by searching the catalog rather than typing a path, and see it resolve.

## Phase 3 — Agent dispatch (3 weeks)

- Context packet assembly and editor, grounded via the Asset Catalog (Phase 1.5) rather than the anchor's raw string.
- Worktree manager over `Bun.$`.
- `opencode` and `claude-code` adapters with streaming events.
- Dispatch UI, live job status, diff review, accept/reject.
- Cost ledger with mid-flight cap enforcement.

**Exit gate:** dispatch a C# script task, watch its output stream onto the card, review the diff, accept it.

## Phase 3.5 — Engine integration: CLI and MCP (see `automation-spec.md` Part II)

- Configurable per-engine integration method (`cli` | `mcp` | `both`).
- CLI: Unity/Blender batch-mode invocation, used by bootstrap (Phase 1.5 amendment) and by a real compile-check acceptance test on dispatch.
- MCP: client connection to a configured Unity-MCP/Blender-MCP server, available to assistant chat and to MCP-capable agent adapters via the context packet.

**Exit gate:** a dispatched job's acceptance check runs a real Unity batch-mode compile, not a guess from reading the diff.

## Phase 3.75 — Periodic scanning, reconciliation, and the Decisions queue (see `automation-spec.md` Parts III–IV)

- Scheduled Asset Catalog scans, diffed against the previous scan.
- Reconciliation proposes — never writes directly: `create_card`, `update_card_status`, `attach_anchor`, `dispatch` suggestions.
- A daily assistant digest pass proposes its own suggestions into the same queue.
- Decisions panel: yes / no / hold, with hold meaning "ask me again," not a third answer.

**Exit gate:** rename a script in Unity outside UAssist entirely; the next scheduled scan proposes updating the card that anchored to it; accepting updates the anchor without hand-editing.

## Phase 4 — Validators and health (2 weeks)

- Compile error parser, missing licence, missing reference.
- Fingerprint-based dedupe and auto-close.
- Health lane on the board.
- Sharpens Phase 3.75's "evidence a card is done" heuristic into a real mechanical check, and backs `close_health_item` suggestions.

**Exit gate:** a missing licence creates a blocker item; fixing the licence closes it on the next run without manual action.

## Phase 5 — Unity and Blender plugins (2–3 weeks)

The *live, in-editor* half of workspace awareness — Phase 1.5 already covers looking at files that exist; this is reacting the moment they change.

- C# Editor extension: context menu + asset reporter.
- Python Blender add-on: context menu + save/export reporter.
- File-watching fallback with ignore rules.
- Anchoring from selection to new cards.
- Incremental Asset Catalog updates from save/export events, replacing full rescans.

**Exit gate:** right-click a Unity GameObject, create a card, see it on the board without touching the browser.

## Phase 6 — Asset tracker and dashboards (2–3 weeks)

- Asset lifecycle tracking driven by export events.
- Asset detail view, dependents graph.
- Risk radar and the five dashboards.

**Exit gate:** export a `.blend` to `.fbx`; UAssist advances the asset to `In Engine`.

## Phase 7 — Tauri shell (1 week)

- Wrap the built web UI in Tauri.
- Bundle the server as a sidecar via `bun build --compile`, or run core in-process behind a Tauri command layer — decided when we get there, on measurement.
- Single-window app, system tray, deep links from Unity/Blender.

**Exit gate:** double-click an app icon, get the board, with no terminal open.

## Phase 8 — Assistant intelligence (ongoing)

Auto-breakdown suggestions, dependency risk prediction, PM-agent digest, conventions propagation, more adapters.

---

# Part XVIII — Relation to other docs

- `unity-colony-build-plan.md` — the plan UAssist imports. Unchanged by this revision; it describes the game, not the tool.
- `unity-assistant-spec.md` — the assistant/agent layer UAssist hosts.
- `plan-to-kanban-tool-spec.md` — the kanban concept UAssist renders.
- `workspace-spec.md` — the Workspace, Asset Catalog, and Project Registry that ground cards, anchors, and context packets in the real project instead of the plan's prose. Read this alongside Part III (data model) and Part VIII/IX (context packets, agent dispatch).
- `automation-spec.md` — project bootstrap as mandatory infrastructure, Unity/Blender CLI and MCP integration, scheduled scanning and reconciliation, and the Decisions queue (yes/no/hold) that both reconciliation and the assistant's own proactive suggestions feed into.
- `rust-to-bun-migration.md` — what changed from v0.1 and why.

Unity and Blender remain the engines. UAssist is the coordination layer around them.

---

# Part XIX — Cut list

- No runtime component in the shipped game.
- No custom game engine.
- No multiplayer coordination.
- No marketplace or external customer features.
- No authentication — loopback binding is the security model.
- No sandboxing beyond worktree isolation (internal-first).
- No full code editor (we delegate to the user's IDE).
- No framework in the web UI until a measured reason appears.

---

# Part XX — Open decisions

1. **Tauri sidecar vs in-process core.** Deferred to Phase 7 deliberately. Sidecar keeps one code path with the browser build; in-process is a smaller bundle. Decide on measurement.
2. **Default port.** `7373` retained. The server probes and increments on conflict, writing the live port to `.uassist/port` for Unity and Blender to read.
3. **Assistant provider.** Configurable. Claude Code CLI is both an agent adapter and a plausible assistant backend; whether to use one path for both is unresolved.
4. **How agents handle Blender scripts.** Blender runs headlessly; the agent writes a Python script and we run it in a worktree Blender instance for verification.
5. **Unity compilation feedback loop.** `dotnet build` is fast and approximate; Unity batch-mode is slow and truthful. Probably dotnet on dispatch, batch-mode on accept.
6. **Multi-user.** Currently single-user, single-machine. Two people on one project would need the JSON mirror to be the merge surface and the db to be strictly local — which the design already allows, but nothing tests.
7. **Virtual scrolling.** Not built until a real project makes the board slow. The trigger to build it is a measured frame drop, not a hunch.
