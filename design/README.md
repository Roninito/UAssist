# UAssist Design Documents

**RastaCamp Studio · v0.2 (Bun) · September 2026**

Read in this order.

| Document | What it covers | Authoritative on |
|---|---|---|
| [`uassist-spec.md`](./uassist-spec.md) | The master spec. Architecture, data model, persistence, API, phasing. | Data model, storage, API, phase order |
| [`plan-to-kanban-tool-spec.md`](./plan-to-kanban-tool-spec.md) | The UI layer — board layout, views, dispatch flow, chat panel. | Board behaviour and UI |
| [`workspace-spec.md`](./workspace-spec.md) | Workspace linking, the Asset Catalog, the Project Registry, and the Docs page — what grounds cards in real project artifacts instead of plan prose. | Anchors, catalog, registry, docs |
| [`automation-spec.md`](./automation-spec.md) | Project bootstrap (mandatory, not optional), Unity/Blender CLI and MCP integration, scheduled scan reconciliation, and the Decisions queue. | Bootstrap, engine integration, suggestions |
| [`unity-assistant-spec.md`](./unity-assistant-spec.md) | Assistant behaviour and the Unity Editor client. | Agent discipline, validators, capabilities |
| [`unity-colony-build-plan.md`](./unity-colony-build-plan.md) | The game plan UAssist imports. Carried over from v0.1 unchanged. | The game, not the tool |
| [`rust-to-bun-migration.md`](./rust-to-bun-migration.md) | What changed from the Rust v0.1 and why. | Decision record |

## Where the docs disagree

`uassist-spec.md` wins. The other two describe surfaces of the system it defines.

## Vocabulary

The same record is called a **Card** on the board and a **Task** in the Unity window. In code it is `Card`.

Status is five words, everywhere, and does not grow: `open` · `active` · `blocked` · `review` · `done`.

## The five doctrine rules

1. Tasks anchor to objects.
2. The backlog writes itself.
3. Split work by verifiability.
4. Agents never touch the working tree.
5. Ship the game.

And the one the Bun version adds:

6. The database is a cache; the JSON is the source.

## Version history

- **v0.1** — Rust workspace, Tauri shell, JSON-only persistence. Lives at `/Users/ronin/rusty-apps/UAssist/design/`, with ~2,300 lines of working Rust kept as reference. Its markdown plan parser was ported with four bugs fixed; see the migration notes.
- **v0.2** — Bun backend, web UI first, Tauri deferred to Phase 7, `bun:sqlite` live store with a deterministic JSON mirror. Phase 0 is implemented: core model, store, plan importer, CLI.
