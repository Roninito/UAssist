# UAssist

Project coordination and asset-development tracking for a game built in **Unity + Blender**.

It turns build plans into living kanbans, anchors work to real objects, coordinates with AI, and dispatches agents to isolated git worktrees — without replacing the engines that actually make the game.

**Status:** Web-first coordination tool is usable now. Phases 0–4 and the web UI are implemented. The Unity Editor extension, Blender add-on, and deeper asset dashboards are Phase 5+ and not started yet.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun 1.3+ |
| Server | `Bun.serve` — REST routes + WebSocket, one process |
| Store | `bun:sqlite` live store + deterministic JSON mirror in `.uassist/` |
| Web UI | Vanilla TypeScript, bundled by Bun's native HTML import. No framework. |
| CLI | `util.parseArgs`, shipped via `bun build --compile` |
| Git | `Bun.$` tagged templates (escaped by construction) |
| Agents | `Bun.spawn` with streaming stdout |
| Desktop | Tauri, wrapping the same web build — **Phase 7, not yet** |

The web app ships before the desktop shell. Tauri is a packaging step at the end, not an architecture constraint at the start.

---

## Layout

```
UAssist/
  design/                 # the specs — start here
  packages/
    core/                 # @uassist/core — domain model, store, git, validators, adapters
    server/
      src/                # @uassist/server — Bun.serve REST + WebSocket
      web/                # the web UI (vanilla TS)
    cli/                  # @uassist/cli — uassist command
  integrations/
    unity/                # C# Editor extension  (Phase 5 — not started)
    blender/              # Python add-on        (Phase 5 — not started)
```

Per-project state lives in the *target* project's `.uassist/` directory, not here.

---

## Getting started

```bash
bun install

bun run dev          # start the server with --watch on :7373
bun run start        # start the server
bun test             # run tests
bun run typecheck    # tsc --noEmit
```

Initialize a project and import a plan:

```bash
bun run uassist init
bun run uassist plan import design/unity-colony-build-plan.md
bun run uassist board   # prints the local URL
```

Build standalone binaries:

```bash
bun run build:cli      # → dist/uassist
bun run build:server   # → dist/uassist-server
bun run build          # both
```

Or install directly to `~/.uassist/bin`:

```bash
./scripts/install.sh
uassist --help
```

---

## Doctrine

1. **Tasks anchor to objects.** A card about a weapon anchors to the `.blend`, the prefab, and the C# script.
2. **The backlog writes itself.** Validators emit health items; agents emit review items.
3. **Split work by verifiability.** Agents write code; humans run it and look at the result.
4. **Agents never touch the working tree.** Results arrive as reviewable diffs in isolated worktrees.
5. **Ship the game.** Every tool feature must name the thing in the game it unblocks.
6. **The database is a cache; the JSON is the source.** `uassist db rebuild` restores everything from git-tracked text.

---

## Phase order

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Core model, SQLite + JSON mirror, plan importer, CLI | **Done** |
| 1 | Bun server + web kanban board, live over WebSocket | **Done** |
| 2 | Plan re-ingest with reviewable diff, preset views, roadmap | **Done** |
| 3 | Agent dispatch — worktrees, adapters, diff review, cost ledger | **Done** |
| 4 | Validators and the health lane | **Done** |
| 5 | Unity Editor extension and Blender add-on | **Not started** |
| 6 | Asset tracker and dashboards | **Not started** |
| 7 | Tauri shell | **Not started** |
| 8 | Assistant intelligence (ongoing) | Ongoing |

Phase 0's exit gate is objective: import `design/unity-colony-build-plan.md`, produce **7 milestones and 54 cards**, delete the database, rebuild it from the JSON mirror, and get byte-identical output.

The v0.1 Rust implementation produced 10 milestones and 17 cards from the same input, and that output is wrong — 3 milestones were prose sections, one card came from the Cut list, all 12 exit conditions were dropped, and 24 of 42 real bullets were skipped. The port fixes those; see the header comment in `packages/core/src/plan/parse.ts`.

---

## What works today

- **Plans**: import a Markdown build plan, re-import with a reviewable diff, see milestones and cards.
- **Board**: kanban columns, category rows, multiple preset views, search, roadmap mode.
- **Cards**: detail panel, acceptance criteria, anchors to project files, chat, agent dispatch.
- **Agents**: dispatch Claude Code or opencode into isolated git worktrees; review diffs; accept or reject.
- **Workspace scan**: scan linked Unity/Blender paths, build an Asset Catalog, validate anchors.
- **Health lane**: broken anchors, Unity compile errors, and other validators surface as cards you can act on.
- **Docs**: Markdown documents scoped to the project, with AI chat.
- **Decisions queue**: suggestions from validators/scans that you can accept, reject, or hold.
- **AI config**: choose providers (Ollama, LM Studio, OpenAI-compatible), model, keys, system prompt.
- **CLI**: `init`, `plan import`, `board`, `workspace scan`, `validate`, `suggestions`, `start/stop/status`, `db rebuild`.

## What is not here yet

- **Unity Editor extension** — a panel inside Unity that shows your cards, anchors, and health items.
- **Blender add-on** — a panel inside Blender that does the same for models and scenes.
- **Asset tracker dashboards** — deeper views of asset relationships, coverage, and ownership beyond the catalog list.
- **Tauri shell** — a desktop wrapper around the web UI.

See the discussion below for what each of those means and what it would take.

---

## Discussion: Phase 5+ features

### Unity Editor Extension

The point of the Unity Editor extension is to bring UAssist into the engine so artists and engineers do not have to switch windows to see what is next.

What it would do:
- Add a **UAssist window/panel** inside the Unity Editor (dockable, like Inspector or Project).
- Show the **cards assigned to the current scene or selected GameObject**.
- Let you **create a card from a selected object** (prefab, script, model) and pre-fill its anchors.
- Show **health items** related to the current project (compile errors, missing references).
- Add a **right-click menu** on assets: *“Open UAssist card for this”* or *“Mark as complete in UAssist”*.
- Run a **local scan** from inside Unity and push the asset list to the UAssist server.

What it would not do:
- Replace the web UI. The web UI is still where you plan, review diffs, and chat.
- Run agents inside Unity. Agents still run in worktrees; Unity just gets a view.

Technical shape:
- C# EditorWindow using `UnityEditor` APIs.
- REST/WebSocket client talking to `http://localhost:7373`.
- Package under `integrations/unity/`.
- Likely needs a small Unity package manifest and assembly definition.

Open questions:
- Should it connect to the server running in the project root, or should the server tell it where to look?
- How much of the board UI should it show? A slimmed-down list is probably right.
- Should it support creating worktrees or launching agents? Probably not in the first version.

### Blender Add-on

Same idea as the Unity extension, but for Blender.

What it would do:
- Add a **UAssist panel** in Blender’s sidebar (N-panel).
- List **cards linked to the current .blend file, collection, or selected object**.
- Let you **create a card from the current file/object** with anchors.
- Show **health items** (missing textures, unlinked libraries, etc.).
- Let you **publish a current render or model** back to UAssist as a media attachment.

Technical shape:
- Python add-on using `bpy` and `bl_ui`.
- REST/WebSocket client talking to `http://localhost:7373`.
- Package under `integrations/blender/`.

Open questions:
- Blender’s add-on API changes more often than Unity’s. How strict do we want version support to be?
- Should the add-on auto-register the .blend path with UAssist when opened, or require manual linking?

### Asset Tracker Dashboards

Today the workspace scan produces an Asset Catalog — a list of files with metadata. The Asset Tracker is the next layer: turning that list into views that help you manage the project.

What it would do:
- **Coverage view**: which planned features have no anchored assets yet? Which assets have no cards?
- **Ownership view**: who is responsible for each asset or each area of the game?
- **Dependencies view**: which Blender models are referenced by which Unity prefabs or scenes?
- **Validation view**: aggregate health items by asset, type, or milestone.
- **Recent changes view**: what changed in the project since the last scan?

Where it fits:
- The data already exists in the Asset Catalog and the card anchors.
- The work is mostly aggregation and new web UI pages.
- It could happen before the Unity/Blender integrations, since it only reads data.

---

## Prior version

A working Rust implementation of v0.1 lives at `/Users/ronin/rusty-apps/UAssist/`. Its plan parser was ported rather than copied — it had four bugs, catalogued in [`design/rust-to-bun-migration.md`](./design/rust-to-bun-migration.md) along with everything else that changed and why.
