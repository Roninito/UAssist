# UAssist

Project coordination and asset-development tracking for a game built in **Unity + Blender**.

It turns build plans into living kanbans, anchors work to real objects, coordinates with AI, and dispatches agents to isolated git worktrees — without replacing the engines that actually make the game.

**Status:** Phase 0 complete — core model, store, plan importer, and CLI. Read [`design/README.md`](./design/README.md) first.

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
    unity/                # C# Editor extension  (Phase 5)
    blender/              # Python add-on        (Phase 5)
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

Once the CLI exists:

```bash
bun run uassist init
bun run uassist plan import design/unity-colony-build-plan.md
bun run uassist board
```

Build a standalone binary:

```bash
bun run build:cli    # → dist/uassist
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

| Phase | Deliverable |
|---|---|
| 0 | Core model, SQLite + JSON mirror, plan importer, CLI — **done** |
| 1 | Bun server + web kanban board, live over WebSocket |
| 2 | Plan re-ingest with reviewable diff, preset views, roadmap |
| 3 | Agent dispatch — worktrees, adapters, diff review, cost ledger |
| 4 | Validators and the health lane |
| 5 | Unity Editor extension and Blender add-on |
| 6 | Asset tracker and dashboards |
| 7 | Tauri shell |
| 8 | Assistant intelligence (ongoing) |

Phase 0's exit gate is objective: import `design/unity-colony-build-plan.md`, produce **7 milestones and 54 cards**, delete the database, rebuild it from the JSON mirror, and get byte-identical output.

The v0.1 Rust implementation produced 10 milestones and 17 cards from the same input, and that output is wrong — 3 milestones were prose sections, one card came from the Cut list, all 12 exit conditions were dropped, and 24 of 42 real bullets were skipped. The port fixes those; see the header comment in `packages/core/src/plan/parse.ts`.

---

## Prior version

A working Rust implementation of v0.1 lives at `/Users/ronin/rusty-apps/UAssist/`. Its plan parser was ported rather than copied — it had four bugs, catalogued in [`design/rust-to-bun-migration.md`](./design/rust-to-bun-migration.md) along with everything else that changed and why.
