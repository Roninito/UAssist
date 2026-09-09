# Plan-to-Kanban Tool Specification

**RastaCamp Studio · draft v0.2 (Bun) · September 2026**

**Purpose.** A project coordination tool that ingests build plans and turns them into a structured, AI-aware kanban system. It connects human planning, AI assistance, and agent dispatch in one surface.

**Context.** Built to support the Unity colony escape project, but designed generically enough for any game or software plan following the Toolwright project-agent vocabulary.

**Relation to UAssist.** This is the **UI layer** of UAssist. `uassist-spec.md` defines the system; this document defines what the board looks like and how it behaves. Where the two disagree, the master spec wins.

---

# Part I — What this is

## Core promise

Drop a build plan in. Get a living project board. Talk to the AI about any card. Dispatch agents to work on any card. Watch the board update itself as validators, agents, and humans move work forward.

## Three connected surfaces

1. **Plan importer** — parse a build plan into milestones, phases, systems, and tasks.
2. **Kanban command center** — complex board with category lanes, assignment lanes, priority swimlanes, and AI presence.
3. **AI coordination panel** — chat with the plan, ask for breakdowns, dispatch agents, review returned work.

---

# Part II — Inputs

## Supported plan formats

- Markdown build plans with headings and phase sections.
- YAML/JSON structured plans.
- Plain text task lists.
- Toolwright-style `build-plan.md` documents.

## Ingest rules

| Source structure | Becomes |
|---|---|
| `## Phase N — Name` | Milestone |
| `### System / Subsystem` | Category tag + component group |
| `- [ ] Task` or bullet list item | Task card |
| `**Exit gate.**` | Milestone gate condition |
| `**Exit demo.**` | Deliverable / acceptance criteria |
| Estimated weeks like `*3–4 weeks*` | Timebox + confidence range |
| Tables | Data rows (dependencies, stack choices) |

## Ingest example

From `unity-colony-build-plan.md`:

```markdown
## Phase 1 — Survival and items

*3–4 weeks.*

The player is a body with needs and a cargo hold.

- Data model: `Item`, `Weapon`, `Ammo`, `Tool`, `Consumable`, `Wearable`.
- Cargo window UI (toggleable, grid, drag/drop optional in v1).
- Equipment slots: weapon, tool, wearable.
```

Produces:
- **Milestone:** Phase 1 — Survival and items
- **Timebox:** 3–4 weeks
- **Category:** Systems / Player / Inventory
- **Cards:**
  - Define item data model
  - Build cargo window UI
  - Implement equipment slots

## Card identity across re-imports

Each imported card carries a `sourceKey`: a hash of `(milestone slug, subsystem slug, normalized title)`, where normalization lowercases, strips punctuation, and collapses whitespace. This is what makes the plan editable — fixing a typo in a bullet keeps its card, its history, and its jobs.

When a `sourceKey` no longer matches, the importer tries a fuzzy title match within the same milestone before concluding the card was deleted, and presents the result as a **rename** rather than an add plus a delete.

The plan source is copied verbatim into `.uassist/plans/` on every import, so a re-import diffs against a known previous text.

---

# Part III — Data model

The full definitions live in `@uassist/core` and are imported by the UI. What follows is the shape the board depends on.

## Card

The atom of work.

```ts
interface Card {
  id: CardId;
  title: string;
  description?: string;
  milestoneId?: MilestoneId;

  category: string;             // "Systems", "AI", "UI", "Audio", ...
  subsystem?: string;           // "Inventory", "Security AI"
  kind: "task" | "deliverable" | "gate" | "decision" | "risk";

  status: Status;               // open | active | blocked | review | done
  priority: "blocker" | "high" | "normal" | "low";

  assignee: Assignee;
  owner?: string;

  estimate?: Estimate;          // { minWeeks, maxWeeks, confidence }
  timeSpentHours: number;

  anchor?: Anchor;
  source?: SourceRange;         // where in the plan this came from
  sourceKey?: string;           // stable identity across re-import

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
```

`jobs`, `comments`, and `history` are relations joined on read, not inline arrays. The board never needs them; the detail panel fetches them.

## Milestone

```ts
interface Milestone {
  id: MilestoneId;
  title: string;
  phaseNumber?: number;
  description: string;
  timebox: Estimate;
  status: "planned" | "active" | "done" | "at-risk" | "slipped";

  gateCondition?: string;
  demoCondition?: string;

  startDate?: number;
  targetDate?: number;
  completedDate?: number;
}
```

Milestone membership is a foreign key on the card, not an array on the milestone. `cards`, `deliverables`, and `risks` are queries.

## Board view model

A board is a query over cards with axis assignments.

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
  | { kind: "status" }
  | { kind: "assignee" }
  | { kind: "milestone" }
  | { kind: "priority" }
  | { kind: "category" }
  | { kind: "subsystem" }
  | { kind: "week" }
  | { kind: "confidence" }
  | { kind: "assetStage" }
  | { kind: "assetKind" }
  | { kind: "agent" };
```

**The server does the pivot.** `GET /api/board?view=plan` returns cells already bucketed:

```ts
interface BoardResponse {
  view: BoardView;
  axes: { columns: AxisValue[]; rows: AxisValue[]; swimlanes: AxisValue[] };
  cells: { swimlane: string; row: string; column: string; cards: CardSummary[] }[];
  health: HealthItem[];         // the pinned lane, always present
  seq: number;                  // WebSocket sequence this snapshot reflects
}
```

Grouping lives in one place, is expressed in SQL, and is tested without a browser. The client renders; it does not group. `CardSummary` is a trimmed card — enough to draw the rectangle, not the whole record.

---

# Part IV — Kanban layout

## Default complex view

**Columns:** Status (`open` → `active` → `blocked` → `review` → `done`)

**Rows:** Category (`Systems`, `Gameplay`, `AI`, `UI`, `Audio`, `Art`, `Narrative`, `Infra`)

**Swimlanes:** Milestone (Phase 0 at top, Phase 6 at bottom)

This gives a matrix: every card has a phase lane, a category row, and a status column.

## Alternative presets

| Preset | Columns | Rows | Swimlanes |
|---|---|---|---|
| **Assignments** | Status | Assignee | Milestone |
| **Sprint board** | Status | Subsystem | Priority |
| **Risk radar** | Priority | Category | Confidence |
| **Timeline** | Week | Category | Assignee |
| **Agent workload** | Status | Agent adapter | Milestone |
| **Asset tracker** | Asset stage | Asset kind | Milestone |

## Card appearance

```
┌────────────────────────────┐
│ P1 · Systems               │  ← milestone + category
│                            │
│ Define item data model     │  ← title
│ ━━━━━━━━━━━━━━━━━━         │  ← acceptance progress bar
│ 2 of 3 criteria met        │
│                            │
│ [blocked] by #cargo-ui     │  ← status chip + blocker
│ est. 3–4 days              │
│                            │
│ 👤 ronin  🤖 available      │  ← assignee + agent availability
│ 2 jobs · 1 question        │
└────────────────────────────┘
```

Color coding:
- Human-owned cards: cyan
- Agent-owned cards: amber
- AI-coordinated cards: amber outline
- Blocker cards: red
- Gate/deliverable cards: distinct shape

## Implementation notes

The UI is vanilla TypeScript served by `Bun.serve`, which imports `web/index.html` directly and bundles it — no separate build tool in development, and HMR when `development: true`. The reasoning, and what it costs, is in Part II of `uassist-spec.md`.

Three rules keep a framework-free board from becoming a pile of DOM mutations:

1. **One store, one snapshot.** State is a single immutable object. WebSocket events produce a new snapshot; nothing mutates in place.
2. **Render is a pure function of state.** `renderBoard(state) => DocumentFragment` for the initial paint; incremental updates diff by `data-card-id` and touch only the cells that changed. Moving a card moves its node.
3. **The DOM is not the state.** Nothing is ever read back out of the DOM to decide what to do next.

Drag-and-drop is native HTML5 DnD with the card id in `dataTransfer`. Dropping issues an optimistic local move, `PATCH`es the card, and reconciles against the WebSocket echo — reverting the node and showing the error if the write failed.

Cards are `<article>` elements inside `<section>` cells in a CSS grid. If a real project ever makes the grid slow, the fix is virtual scrolling over swimlanes — built when a frame drop is measured, not before.

---

# Part V — AI coordination

## The assistant panel

Docked to the right of the board. Three modes:

1. **Discuss** — ask questions about the plan, get breakdowns, clarify scope.
2. **Dispatch** — turn a card into an agent job.
3. **Review** — inspect returned diffs, accept/reject.

The panel posts to `POST /api/assistant/message` and receives the reply as `assistantToken` events on the existing WebSocket, so chat tokens, job output, and board updates arrive in order over one connection.

## Typed chips

Drag any card, milestone, anchor, or validator output into the chat composer as a chip.

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

Chips resolve server-side at send time, so a chip dragged five minutes ago carries current state, not a stale copy.

## AI capabilities in the tool

| Command | What the AI does |
|---|---|
| "Break this milestone into cards" | Suggest missing tasks, acceptance criteria, dependencies |
| "What is blocking Phase 2?" | Trace dependencies and blocked cards |
| "Estimate this" | Cross-reference similar cards, suggest timebox |
| "Who should own this?" | Recommend human/agent split based on verifiability |
| "Dispatch this to an agent" | Assemble context packet, choose adapter, create job |
| "Why is this card at risk?" | Analyze estimate vs. elapsed time, blockers, failed jobs |
| "Summarize this week" | Digest completed, active, blocked, agent activity |

Every one of these is a query against the store before it is a prompt. The assistant is given retrieved state, not asked to remember it.

## Agent dispatch from a card

Clicking the robot icon on a card opens the dispatch flow:

1. **Context packet preview** — auto-assembled from the card, its anchor, related files, conventions, and acceptance criteria.
2. **Choose agent** — opencode, Claude Code, or another adapter.
3. **Edit objective** — confirm or refine what the agent should do.
4. **Set budget** — max cost, max duration, max attempts.
5. **Dispatch** — create worktree, spawn agent.
6. **Monitor** — job state and streamed output update on the card in real time.
7. **Review** — returned diff appears in card detail; accept/reject.

The card status auto-updates to `active` when dispatched and `review` when returned.

---

# Part VI — Synchronization with agents

## Job lifecycle on the board

| Job state | Card status | UI signal |
|---|---|---|
| drafted | open | pending dispatch icon |
| dispatched | active | spinner on card |
| running | active | live cost timer + streamed output line |
| awaiting_answer | blocked | question badge |
| returned | review | diff ready badge |
| review | review | assigned to human |
| accepted | done | closed, linked commit |
| rejected | open | retry button, failure reason |

## Bidirectional updates

- When an agent finishes a job, acceptance criteria are checked off where they can be verified mechanically.
- When a validator emits a health item, it appears in the health lane; if it anchors to something a card already covers, it links to that card instead of creating a duplicate.
- When a human moves a card to done, the assistant can suggest follow-up cards.
- When a milestone's gate condition is met, the milestone auto-advances to `done`.

## Live update contract

Every server event carries a monotonic `seq`. The board holds the `seq` of its last applied event; on reconnect it sends that value and receives either the gap replayed from `events.log` or an instruction to re-fetch the board.

Without this, closing a laptop lid leaves a board that looks correct and is wrong — the worst failure mode a dashboard has.

---

# Part VII — Views and dashboards

## Milestone roadmap

Horizontal timeline. Each milestone as a bar with phase number, timebox, and completion percentage.

```
Phase 0 ████████████░░░░ 80%
Phase 1 ░░░░░░░░░░░░░░░░ 0%   ← starts after Phase 0 gate
Phase 2 ░░░░░░░░░░░░░░░░ 0%
```

Click a bar to zoom into its kanban slice.

## Burndown / risk dashboard

- Total cards by status.
- Blockers by category.
- Agent spend per milestone.
- Cards at risk (estimate exceeded, failed jobs, unanswered questions).
- Health items over time.

All of these are SQL aggregates served from `GET /api/dashboard/{name}`. Nothing is precomputed and nothing is cached — at this data size the query is cheaper than the cache invalidation would be.

## Agent workload view

Columns: agent adapter. Rows: status. Cards show cost, duration, queue depth. Prevents over-dispatch.

## Health lane

A fixed horizontal lane at the bottom of every board showing validator-generated items. Cannot be hidden. Keeps broken things visible.

Items dedupe and auto-close by fingerprint, so the lane reflects what is broken now rather than everything that was ever broken.

---

# Part VIII — Plan mutation

## Re-ingest

When the build plan changes, the tool re-ingests it and proposes a diff:

- New cards added.
- Removed cards flagged — never auto-deleted if they have jobs, history, or manual edits.
- Renamed cards matched by `sourceKey`, then by fuzzy title within the milestone.
- Acceptance criteria updated.

The diff is reviewable before application, in the UI or as `uassist plan import --dry-run` in the terminal.

## Manual overrides

Humans can add, delete, move, split, and merge cards, change categories and assignments, and mark criteria manually.

An overridden field is marked as such, so a re-import does not silently undo a human decision — if the plan text and a manual override disagree, that is a conflict shown in the diff, not a silent overwrite.

---

# Part IX — Integration architecture

```
┌─ Web UI (vanilla TS, no framework) ───────────────┐
│  ├─ Kanban board (CSS grid + native DnD)          │
│  ├─ Milestone roadmap                             │
│  ├─ Assistant chat panel                          │
│  └─ Dispatch / review flows                       │
│  → later: same build loaded by Tauri              │
└──────────────┬────────────────────────────────────┘
               │ fetch + WebSocket, 127.0.0.1:7373
┌─ Coordination server (Bun) ───────────────────────┐
│  Bun.serve routes{} + websocket{}                 │
│  plan parser                                      │
│  card store — bun:sqlite + JSON mirror            │
│  board view engine (axes → SQL)                   │
│  job orchestrator (Bun.spawn, streaming)          │
│  validator runner                                 │
│  agent adapters (opencode, Claude Code)           │
│  assistant provider                               │
└──────────────┬────────────────────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
   Unity project    Git repo
   (anchors)        (worktrees, diffs)
```

## Storage

- Live store: `bun:sqlite` at `.uassist/uassist.db`, gitignored and rebuildable.
- Source of truth: deterministic JSON in `.uassist/cards/`, `milestones/`, `assets/`, `jobs/` — one file per record, fixed key order, git-tracked.
- Plan source retained verbatim in `.uassist/plans/` for re-ingest.
- `events.log` append-only JSONL for audit, replay, and WebSocket gap-fill.

`uassist db rebuild` drops the database and replays the JSON. That is the recovery path after a `git pull`, a schema migration, or a corrupted file.

## Export

- Markdown todo list.
- CSV for spreadsheets.
- JSON for external tools.
- GitHub/GitLab issue import format.

---

# Part X — UI mock concepts

### Board matrix

```
                    OPEN        ACTIVE      BLOCKED     REVIEW      DONE
Milestone: Phase 0
  Systems           [card]      [card]      [card]
  Gameplay          [card]                  [card]
  AI                [card]

Milestone: Phase 1
  Systems           [card]
  UI                [card]      [card]

HEALTH LANE (fixed)
  [missing attribution on crate-03]  [guard prefab missing navmesh]
```

### Dispatch panel

```
Dispatch: Define item data model
─────────────────────────────────
Agent:        [opencode ▼]
Objective:    Create ScriptableObject-based item data model
              covering Weapon, Ammo, Tool, Consumable, Wearable.

Files:        Assets/Scripts/Inventory/ (created)
              Assets/Data/Items/ (created)

Acceptance:   [✓] Compiles without errors
              [✓] Five item subtypes exist
              [ ] Unit tests for serialization
              [ ] Inventory manager can load one of each

Budget:       $2.00 · 10 min · 3 attempts
Worktree:     .uassist/worktrees/job-01J8F2… (from HEAD 4a91c02)
[Dispatch]
```

### Assistant chat

```
You:        Why is Phase 1 at risk?
Assistant:  Phase 1 has 14 cards. 3 are blocked:
            - Cargo UI (#23) blocked by data model (#21)
            - Oxygen zones (#31) blocked by status effect system (#29)
            - Equipment slots (#25) has an agent job awaiting answer
            Elapsed time is 1.2x the timebox.
```

---

# Part XI — Phasing

Aligned to the master spec's phases. The board is the first thing that ships.

## MVP — master Phases 0–1 (5 weeks)

- Markdown plan importer with stable `sourceKey`.
- Board-as-query endpoint; default complex view (status × category × milestone).
- Manual card CRUD, drag to change status.
- Live updates over WebSocket with `seq` resume.
- Detail panel: acceptance, anchor, history.

## v2 — master Phases 2–3 (4–5 weeks)

- Preset views, swimlanes, filters.
- Re-ingest with a reviewable diff.
- Milestone roadmap.
- Assistant chat with plan context.
- Agent dispatch to one adapter, with a diff review UI.

## v3 — master Phases 4–6 (5–8 weeks)

- Health lane fed by validators, deduped by fingerprint.
- Multiple agent adapters and the agent workload view.
- Cost ledger and spend dashboards.
- Asset tracker view.
- Export to issue trackers.

---

# Part XII — Relation to other docs

- `uassist-spec.md` — the system this is the UI for. Authoritative on data model, storage, and API.
- `unity-assistant-spec.md` — the assistant behaviour this panel surfaces.
- `unity-colony-build-plan.md` — the plan this board imports.
- `rust-to-bun-migration.md` — why the backend is Bun.

If Toolwright matures, this kanban layer can sit on top of it. If not, it is a standalone project-coordination product with a game-specific integration.

---

# Part XIII — Open decisions

1. **Auto-dispatch threshold.** How trivial must a task be before the AI suggests dispatch without human confirmation? Currently: never — every dispatch is confirmed.
2. **Where board view definitions live.** Presets are code today. User-defined views would need a `views` table and an editor; not built until someone wants a sixth preset.
3. **Card density at scale.** The colony plan produces ~17 cards from 10 milestones. At ten times that, the matrix needs virtual scrolling or collapsed swimlanes. Decide on measurement.
4. **Multi-user.** Single-user today. Two people on one project would make the JSON mirror the merge surface — which the storage design allows and nothing currently tests.
5. **Offline edit reconciliation.** If the plan markdown is edited on another machine and pulled, `db rebuild` handles it. If cards were edited on both sides, that is a JSON merge conflict a human resolves. Acceptable until it isn't.
