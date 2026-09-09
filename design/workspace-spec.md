# Workspace, Asset Catalog, and Project Registry Specification

**RastaCamp Studio · draft v0.1 · September 2026**

**Purpose.** Close the gap between UAssist's cards and the real project. As built through Phase 1, a card's `anchor` is a typed union a human types by hand — nothing checks that `Assets/Scripts/Inventory/ItemDatabase.cs` exists, is a script, or is the file a human meant. An agent dispatched on that card would get a title and a guessed path, not grounded context. This document specifies the layer that fixes that: a **Workspace** link from a UAssist project to its real Unity/Blender directories, an **Asset Catalog** that indexes what is actually there, and a **Project Registry** so a machine with more than one UAssist project has a place to see and switch between them.

**Status.** Formal design, implementation in progress alongside it. This document is normative for the pieces it covers; `uassist-spec.md` remains authoritative wherever the two overlap.

---

# Part I — Why this is load-bearing, not decorative

The doctrine in `uassist-spec.md` opens with **"Tasks anchor to objects."** Through Phase 1 that doctrine is aspirational: `Anchor` is a well-typed union, but nothing populates it from reality, validates it against reality, or lets a human pick a real target instead of typing a guessed path. Three consequences follow directly from that gap, and all three are the actual problem this document solves:

1. **Cards describe the plan, not the project.** A card imported from `unity-colony-build-plan.md` says "Data model: `Item`, `Weapon`, `Ammo`…" — a sentence from a document, not a pointer to `Assets/Scripts/Inventory/`. That is correct for Phase 0 (the plan importer's job is exactly to turn prose into cards) but wrong as an end state.
2. **A dispatched agent would get the same guess a human would have to make.** `ContextPacket.files` (Part VIII, `uassist-spec.md`) is specified as `{ path: string; reason: string }[]` — assembled from the card's anchor. An anchor nobody has ever checked against the filesystem is not a reliable source for that assembly. "Agents will be tasked with performing real work" is the requirement that makes this non-optional.
3. **A stale anchor is invisible.** If `ItemDatabase.cs` gets renamed, nothing about the card changes. The validator doctrine ("the backlog writes itself") has no way to notice, because there is no indexed ground truth to check the anchor against.

This document specifies the ground truth (the Asset Catalog), the link that makes it possible (the Workspace), and the registry that lets a person find their way to the right project in the first place (the Project Registry) — because a "select a project" page has to select among *something*, and today nothing durable enumerates what a person has.

---

# Part II — Project Registry

## Positioning

UAssist today is one server process bound to one project root, discovered by that project's own `.uassist/port` file (Part XIII, `uassist-spec.md`). That per-project isolation is a genuine strength — a crash or a runaway agent in one project cannot touch another — and this design keeps it. **The registry does not merge servers.** It is a small, machine-local index of *which projects exist*, so a person (and the UI) can enumerate and reach them, while each project continues to run as its own isolated process on its own port exactly as before.

This is the "if it makes more sense to design it this way now" call: building the registry now costs a JSON file and a handful of functions, and it is the entire dependency multi-project needs later. Building one server that hosts many projects concurrently — a shared process, namespaced routes, one `Store` per tenant — is a materially bigger change or scope, is not required by anything asked for today, and is *harder to justify* given the isolation property above is worth keeping. If a real need for concurrent multi-project hosting appears later (a dashboard that must stay live across many projects without any of them running their own server), it is a layer that can be added on top of the registry without revisiting this decision — see Part VI.

## Storage

Unlike everything else in UAssist, the registry is not project-scoped — it has to exist before any single project's `.uassist/` is relevant, and it has to be readable by every project's server. It lives at the user level:

```
~/.uassist/
  registry.json     # known projects on this machine
```

This is **local machine state, not git-tracked, and not part of any project's own `.uassist/`.** It answers "what UAssist projects does *this machine* know about," which is meaningless to commit and meaningless to share.

```ts
interface RegisteredProject {
  id: ProjectId;          // the project's own id, from its project.json
  name: string;
  root: string;            // absolute path
  addedAt: number;
  lastOpenedAt: number;
}

interface Registry {
  version: 1;
  projects: RegisteredProject[];
}
```

## Lifecycle

- `uassist init` registers the new project (add-or-update by `root`).
- Starting the server (`startServer`, Part XIII) touches `lastOpenedAt` for its own root.
- There is deliberately no automatic un-registration. A moved or deleted project shows up in the registry as unreachable (Part IV) rather than silently vanishing — a person deletes the entry themselves, the same way a person cleans up a bookmark.

## Reachability, not a live connection

The registry does not track a project's *current* port — ports move (Part XX, decision #2; and now the reclaim logic in `packages/server/src/reclaim.ts`). Instead, reachability is computed on demand, reusing machinery that already exists for exactly this purpose:

1. Read `<root>/.uassist/port` off disk. Its absence means "not currently running."
2. `probeInstance(port)` (`instance.ts`) — the same authoritative HTTP identity check port-reclamation uses. A confirmed answer means the project's server is live right now and names the right root; anything else means it is not.

This is a direct reuse of Part XIII's instance-identity design: "is this the same UAssist project" was already solved for port reclamation, and a registry entry asking "is this project currently open" is the identical question.

## Project Meta page

The registry's UI surface is the **Project Meta page**, reachable at `/project` on any running project's server (Part IV, `uassist-spec.md`'s server-per-project model is unchanged — you still open *a* project's own UI to see this). It shows:

- This project's identity, workspace links, and Asset Catalog summary (Part III below).
- Every other registered project, each with a reachability badge (probed live, per above) and — when reachable — a link straight to its board at `http://127.0.0.1:<port>/board`.

## Future: an all-projects dashboard

Deferred, but not blocked. Because every project's authored state is git-tracked JSON in its own `.uassist/` (Part IV, `uassist-spec.md`), a dashboard aggregating card counts, health, and milestone progress across every registered project can be built by reading each project's JSON mirror directly off disk — it needs neither that project's server to be running nor a shared multi-tenant process. When it is worth building, it is a read-only aggregation layer over the registry, not a rearchitecture of anything specified here.

---

# Part III — Workspace and the Asset Catalog

## Workspace

A **Workspace** is the validated link from a UAssist project to the real directories it coordinates. The fields already exist on `Project` (`unityProjectPath`, `blenderSourcePath`, Part III of `uassist-spec.md`) — this section is what makes them load-bearing instead of inert strings.

```ts
interface WorkspaceStatus {
  unity?: { path: string; valid: boolean; reason?: string };
  blender?: { path: string; valid: boolean; reason?: string };
  lastScannedAt?: number;
  assetCounts: Record<AssetKind, number>;
  totalAssets: number;
}
```

### Validation

- **Unity**: `path` must exist, and must contain both an `Assets/` directory and a `ProjectSettings/` directory — the two things every real Unity project has and a random folder does not.
- **Blender**: looser by nature (there is no fixed Blender "project" structure). `path` must exist and be a directory; a workspace is considered meaningfully linked once at least one `.blend` file is found under it.

A path that fails validation is stored anyway (so the field reflects what the user typed) but is flagged, and the catalog scan for that half of the workspace does not run until it is fixed. This mirrors the plan importer's stance on bad input: report clearly, do not silently discard what the user entered.

### Setting the link

`PATCH /api/project` accepts `unityProjectPath` and `blenderSourcePath`. There is no folder picker — this is a browser page with no native bridge — so the Project Meta page takes a typed or pasted absolute path and calls this endpoint, which validates and reports back inline. The Tauri shell (Part VII, `uassist-spec.md`) is the natural place for a real folder-picker dialog later; nothing here blocks that.

## Asset Catalog

The index of what is actually in the workspace. Every entry describes one real file.

```ts
type AssetKindGuess =
  | "script" | "prefab" | "scene" | "material" | "scriptableObject"
  | "mesh" | "texture" | "audio" | "animation" | "blend" | "other";

interface WorkspaceAsset {
  /** Relative to the workspace root (Unity project root, or Blender source root). */
  path: string;
  source: "unity" | "blender";
  kind: AssetKindGuess;
  sizeBytes: number;
  mtimeMs: number;
  /** For .cs files: class/struct names found by a light regex scan — enough
   *  to resolve "the AmmoDatabase script" to a real path without a C# parser. */
  classNames?: string[];
  /** Content hash, for change detection between scans. */
  hash: string;
}
```

### Scanning

`scanWorkspace(project)` walks `Assets/` (Unity) and the Blender source root, classifying by extension and, for `.cs` files, extracting class names with `/\b(?:class|struct)\s+(\w+)/g` — a heuristic, not a compiler, which is exactly proportionate to what the catalog needs it for (search and anchor resolution, not correctness-checking).

It reuses the ignore rules already specified for the file-watching fallback (Part VII, `uassist-spec.md`): always skip `Library/`, `Temp/`, `obj/`, `.git/`, and anything a project's `.uassistignore` excludes. For a Unity workspace, `.uassistignore` is read from the **Unity project root** (next to `ProjectSettings/`) rather than from inside `Assets/` — where a person actually expects project-level config to live — but its patterns are still written relative to `Assets/`, since that is the whole of what gets scanned.

Triggers:
- **Manual** — a "Rescan" button on the Project Meta page, and `uassist workspace scan` in the CLI.
- **Automatic (later)** — once the Unity/Blender plugins exist (Phase 5, `uassist-spec.md`), their save/export events update the catalog incrementally instead of requiring a full rescan. The scanner specified here is the fallback that makes the catalog useful *before* those plugins exist, not a placeholder for them.

### Storage: a cache with no source to mirror

Part IV of `uassist-spec.md` establishes "the database is a cache; the JSON is the source" — every authored record gets a deterministic JSON mirror because that mirror is what git tracks and what survives. The Asset Catalog is the deliberate exception, and the reason sharpens the rule rather than breaking it: **a `WorkspaceAsset` has no authored content of its own to mirror.** The source of truth for "does this script exist and what is it called" is the `.cs` file itself, sitting in the Unity project, already tracked by *that* project's own git repository. Mirroring it into `.uassist/` would be a second, redundant, driftable copy of a fact that already has a canonical location. The catalog is a cache of the filesystem; rebuilding it means rescanning, not replaying `.uassist/` — so it lives in `bun:sqlite` only:

```sql
CREATE TABLE workspace_assets (
  path        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('unity','blender')),
  kind        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  class_names TEXT,             -- JSON array, present for scripts
  hash        TEXT NOT NULL,
  PRIMARY KEY (source, path)
);
CREATE INDEX workspace_assets_kind ON workspace_assets(kind);
```

A full rescan replaces the table's contents in one transaction. There is no `events.log` entry per asset — a scan is one event (`workspaceScanned`, with counts), not one event per file, matching the same "don't drown the log" instinct that made the JSON mirror debounce card writes (`mirror.ts`).

---

# Part IV — Anchors become checkable facts

With a catalog in place, three things that were previously impossible become straightforward:

## Anchor resolution

```ts
function resolveAnchor(anchor: Anchor, catalog: Store): WorkspaceAsset | undefined
```

Given a card's anchor, look up whether it names a real, currently-indexed asset. This is a lookup, not a validator pass — cheap enough to call every time a card is rendered in the detail panel, so a broken anchor shows a "not found — rescan or fix" badge immediately rather than waiting for a scheduled health sweep.

## The anchor picker

Before this design, attaching an anchor meant typing a path into a card and hoping it was right. The card detail panel now gets a search-backed picker: type a few characters, get real matches from the catalog (`GET /api/workspace/assets?q=`), pick one, `PATCH` the card's `anchor`. Selecting `ItemDatabase.cs` from a list of things that actually exist is categorically different from typing a guess — this is the concrete fix for "not just referencing the high-level concept."

## Grounded context packets

Part VIII of `uassist-spec.md` specifies `ContextPacket.files: { path: string; reason: string }[]`, assembled from "anchor state (components, recent errors, asset metadata)." This document makes that assembly concrete for the static (pre-plugin) case: resolve the card's anchor through the catalog, include the file itself plus (for a script) its detected class names, and — for a prefab or scene, where we cannot yet parse Unity YAML meaningfully — include what the catalog knows (size, last modified) rather than nothing. **Agent dispatch itself is still Phase 3 and is not built by this document** — but the packet it will assemble is specified here so it is grounded from the day it exists, rather than shipping ungrounded and needing a second pass.

## Anchor health (deferred)

A `workspace_anchor_missing` validator — emitting a health item when a card's anchor no longer resolves — is a natural fit for the validator runner specified in Part X of `uassist-spec.md`. That runner does not exist yet (it is Phase 4 in the current phasing). This document does not pull the runner forward; it notes the validator as a one-line addition once the runner exists, and in the meantime the detail-panel badge above covers the same need for a human looking at one card.

---

# Part V — Documentation and AI collaboration

## Positioning

The plan importer treats `unity-colony-build-plan.md` as a privileged input: it is parsed into milestones and cards. Every other design document — this one included — has, until now, been a file in a folder outside the tool's view. That is a second instance of the same underlying gap this document opens with: the *project's own documentation* was itself an artifact UAssist did not reference. This section makes documents a first-class, browsable, AI-collaborable concept, with the build plan as the special case that also parses into cards, not the only thing that counts as a document.

## Documents are files, not database rows

Consistent with the doctrine that authored content is text a human (or git) can read directly:

```
project/
  .uassist/
    docs/
      uassist-spec.md
      meeting-notes-2026-09.md
      ...
    plans/
      unity-colony-build-plan.md   # already existed — the imported plan
```

A document *is* its file. There is no database row, no separate mirror, and therefore no "cache vs. source" question to resolve — the same reasoning that keeps the Asset Catalog out of the JSON mirror applies here in the opposite direction: a markdown file already *is* the durable, git-tracked, human-readable form, so indexing it into SQLite would be adding a copy with nothing to justify it at this corpus size (a handful to dozens of files). `GET /api/docs` lists `.uassist/docs/*.md` by directory scan; the title is the first `#`-heading line, falling back to the filename.

The imported plan is visible in the same listing, distinguished by a badge, with its existing re-ingest action (Part V, `uassist-spec.md`) surfaced from the doc view rather than requiring the CLI.

## Docs page

A third top-level page alongside the board (`/board`) and the project meta page (`/project`): **`/docs`**. Sidebar list of documents; a viewer/editor pane for the selected one; view mode by default, an edit mode that is a plain textarea with a Save button — not a rich editor, matching the project's stated preference for small, legible surfaces over framework machinery (Part II, `uassist-spec.md`).

## AI collaboration on a document

Card chat already exists (built alongside this design, ahead of it): a per-card thread, an OpenAI-compatible streaming client (`llm.ts`), configurable local or hosted providers (`AiConfig`). Document chat is the same capability pointed at a document instead of a card — a `ChatSubject` generalizes what a thread is about:

```ts
type ChatSubject =
  | { kind: "card"; id: CardId }
  | { kind: "doc"; path: string };
```

**v1 (implemented alongside this document):** a chat panel on the doc view, backed by its own thread, with the document's current content as system context. This supports "ask about it, ask for a draft of a section, ask it to critique the doc" — genuinely useful, and it is where drafting a first cut of a new design doc collaboratively becomes possible without leaving UAssist. The reply is read, not applied; copying a suggested passage back into the edit pane is a manual, deliberate act.

**v2 (specified, not yet built):** propose-then-apply for documents, mirroring the exact discipline Part IX of `unity-assistant-spec.md` insists on for agent-authored code — "never auto-apply." The assistant proposes a diff against the current document text; the diff is shown, not applied; a human accepts or rejects it, the same review posture as an agent's returned code. This is deferred because it needs a real diff-review UI, which the codebase does not have yet for *any* content type (cards' acceptance criteria are the closest analog and are far simpler). Building it once, for documents first, is plausible future groundwork for the same UI code path notes as "Job lifecycle" diff review will eventually need — but that is a decision for whichever phase gets there, not this one.

### Why a second table instead of generalizing the existing one

`chat_threads` (schema migration 1→2) is keyed by `card_id TEXT PRIMARY KEY` and is not part of the JSON mirror — chat history today does not survive `uassist db rebuild`. Generalizing that table's key to a `ChatSubject` is the *correct* eventual shape (recorded above) and costs nothing in data durability to defer, since there is nothing durable to migrate. This document's implementation adds a second, identically-shaped `doc_chat_threads` table rather than altering the first, so the working card-chat feature is not put at risk by a schema change in the same change that ships document chat. Unifying the two into one `chat_threads` table keyed by `ChatSubject` is flagged as follow-up work, not committed to a phase here.

---

# Part VI — Server and API surface

All additions. Nothing in Part XIII of `uassist-spec.md` is removed or renamed.

| Method | Path | Purpose |
|---|---|---|
| PATCH | `/api/project` | Set `unityProjectPath` / `blenderSourcePath` (validated) |
| GET | `/api/workspace` | Workspace status: paths, validity, catalog counts, last scan |
| POST | `/api/workspace/scan` | Run a scan now; returns counts and duration |
| GET | `/api/workspace/assets` | Search the catalog — `?q=&kind=&source=` — backs the anchor picker |
| GET | `/api/registry` | Registered projects, each with a live-probed reachability flag |
| GET | `/api/docs` | List documents (path, title, updated) |
| GET | `/api/docs/:path` | One document's content |
| PUT | `/api/docs/:path` | Save a document |
| GET | `/api/docs/:path/chat` | That document's chat thread |
| POST | `/api/docs/:path/chat` | Send a message; streams the reply over the existing WebSocket |

`PATCH /api/cards/:id` gains one more accepted field: `anchor` (any `Anchor` variant, validated against the discriminated union at the parsing boundary per the existing edge-parsing discipline in `api.ts`).

## CLI additions

```bash
uassist workspace scan              # scan Unity/Blender paths, report counts
uassist workspace status            # show link validity + catalog summary
```

`uassist init` additionally registers the project in `~/.uassist/registry.json`.

---

# Part VII — Phasing

This slots into the existing plan (Part XVII, `uassist-spec.md`) rather than replacing it. The Asset Catalog specifically **moves earlier** than the original phasing implied — v0.1/v0.2 filed all Unity/Blender awareness under Phase 5 ("Unity and Blender plugins"), which bundled the *live, in-editor* integration with the much more basic ability to *look at the files that already exist*. Those are different problems with very different costs, and the second one does not need to wait for the first:

## Phase 1.5 — Workspace and Asset Catalog *(new — inserted after the board, before agent dispatch)*

- Project Registry (`~/.uassist/registry.json`), reachability probing.
- Workspace linking and validation.
- Asset Catalog scanner (Unity `Assets/`, Blender `.blend` discovery).
- Project Meta page (`/project`).
- Anchor picker wired into the card detail panel; anchor resolution badge.
- Docs listing, viewer, editor (`/docs`), v1 AI chat on a document.

**Exit gate:** link a real (or fixture) Unity project's path, scan it, attach a card's anchor to a real script by searching the catalog, and see the anchor resolve — not just accept a typed string.

## Phase 3 (unchanged in substance, sharpened) — Agent dispatch

Context packet assembly (Part VIII/IX, `uassist-spec.md`) now has a concrete grounding step to call: resolve the card's anchor through the catalog built in Phase 1.5 before assembling `files`. No phase renumbering required — this is what Phase 3 was always going to need, now specified.

## Phase 4 (unchanged) — Validators and health

`workspace_anchor_missing` joins the MVP validator list once the runner exists.

## Phase 5 (unchanged in intent, now more precisely scoped) — Unity and Blender plugins

Explicitly the *live, in-editor* half: incremental catalog updates from save/export events, context menus, the in-editor health lane. The static scanner from Phase 1.5 is what these plugins upgrade, not what they replace.

---

# Part VIII — Relation to other documents

- `uassist-spec.md` — the master spec. This document is additive to it; Parts III, IV, VIII, XIII, and XVII there gain the cross-references above.
- `plan-to-kanban-tool-spec.md` — the board's nav gains `/project` and `/docs` alongside `/board`.
- `unity-assistant-spec.md` — Part II's `Anchor` union and Part II's `ContextPacket` are exactly what Part III/IV here make real; no changes needed there beyond noting where the grounding now comes from.

---

# Part IX — Open decisions

1. **Blender validity threshold.** "At least one `.blend` file exists" is a low bar. Revisit once a real Blender-sourced project exercises it.
2. **Class-name extraction fidelity.** The regex scan will over- and under-match on generics, nested classes, and preprocessor-guarded code. Acceptable for search and anchor resolution; not a substitute for a real Roslyn-backed index if one is ever justified.
3. **Unifying `chat_threads` and `doc_chat_threads`.** Recorded above as the correct eventual shape. Triggered by whichever comes first: chat history becoming durable enough to be worth migrating carefully, or a second document-chat-shaped feature making the duplication actually annoying.
4. **Multi-tenant hosting.** Explicitly not built (Part II). Revisit only if a concrete need appears that the read-only dashboard aggregation (Part II, "Future") cannot satisfy.
5. **Doc v2 propose-then-apply.** Needs a diff-review UI this codebase does not have for any content type yet. First real user of that UI code path is an open question across documents, jobs, and health — not decided here.
