# Changelog

All notable changes to UAssist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Phase 0

Initial release of UAssist. Phase 0 establishes the core model, the store, the plan importer, and the command-line interface.

### Added

#### Core
- Domain model for projects, cards, milestones, jobs, health items, and workspace assets.
- SQLite-backed store with a deterministic JSON mirror in `.uassist/`.
- Rebuild command (`uassist db rebuild`) that regenerates the database from the JSON mirror.
- Append-only event log for auditability.

#### Plan import
- Markdown plan grammar: phases become milestones, bullets become cards, exit gates/demos become acceptance criteria.
- `uassist plan import` command with `--dry-run` preview.
- Re-import with reviewable diff: added, renamed, and orphaned cards.

#### Web UI
- Bun.serve-based server hosting REST API, WebSocket event stream, and web interface on `http://127.0.0.1:7373`.
- Kanban board with status columns, category rows, and milestone swimlanes.
- Multiple board views: Plan, Assignments, Risk radar, Sprint board, and Flat.
- Milestone roadmap view with progress bars.
- Card detail panel with status, assignee, anchors, acceptance criteria, linked cards, chat, and agent dispatch.
- Project page with Unity/Blender workspace linking, scanning, and asset catalog.
- Docs page with Markdown editor and project-aware assistant chat.
- AI configuration panel for local and remote providers.
- Help panel accessible with `?` key.
- ToolwrightTheme applied to the entire web UI with light and dark mode support.

#### Agents
- Adapter system for CLI agents, initially supporting Claude Code and opencode.
- Git worktree isolation: every job runs in a fresh worktree.
- Context packet assembled from card description, anchors, conventions, and chat.
- Diff review, accept/reject, and cost/duration caps.

#### Health
- Validators that emit health items for compile errors, missing references, licence gaps, and budget overruns.
- Health lane on the board showing open items.
- Auto-close when the underlying issue disappears.

#### CLI
- `uassist init` — initialize a project.
- `uassist plan import` — import a Markdown plan.
- `uassist serve` — start the web server.
- `uassist health` — run validators.
- `uassist status` — show project status.

#### Workspace
- Scan Unity and Blender projects for assets, scripts, scenes, and models.
- Anchor validation: found / not-in-catalog badges.

#### Installation
- `scripts/install.sh` for macOS and Linux.
- `scripts/install.ps1` for Windows.

### Changed
- Ported plan parser from the earlier Rust prototype, fixing milestone detection, cut-list handling, and exit-gate extraction.

### Fixed
- Corrected plan importer so prose sections do not become milestones and cut-list bullets do not become cards.

## [Unreleased]

Planned for upcoming phases:
- Unity Editor extension and Blender add-on integration.
- Plan re-import merge resolution UI.
- Expanded agent adapter registry.
- Desktop packaging with Tauri.
