# Rust → Bun Migration Notes

**RastaCamp Studio · September 2026**

**Purpose.** Record what changed between UAssist v0.1 (Rust workspace, Tauri shell) and v0.2 (Bun backend, web-first UI), and why. The v0.1 documents live in `/Users/ronin/rusty-apps/UAssist/design/` and the Rust implementation is retained there as reference.

---

## The decision

The v0.1 spec argued for Rust on four grounds: speed, determinism, git-nativeness, and headless friendliness. Three of those turned out not to be Rust-specific for this workload.

**What UAssist actually does:** read text files, run `git`, spawn CLI agents, keep a few thousand records in a local database, and serve a dashboard on loopback. None of it is CPU-bound. The costs that matter are edit-to-run latency and the number of moving parts between an idea and a working board.

**What Rust was costing:** a compile cycle in the inner loop, a separate TypeScript build for the Tauri UI with a type boundary in the middle (Rust structs on one side, hand-maintained TS interfaces on the other), and a crate for each thing Bun has in its standard library — router, HTTP server, SQLite driver, process spawning, shell escaping.

**What Bun buys:**

| Concern | v0.1 (Rust) | v0.2 (Bun) |
|---|---|---|
| HTTP + WS server | `axum` + `tower` + `tower-http` | `Bun.serve` |
| SQLite | `rusqlite` (was: JSON only) | `bun:sqlite` |
| Process spawn | `std::process` + `tokio::process` | `Bun.spawn` |
| Shell / git | manual arg escaping | `Bun.$` tagged templates, escaped by construction |
| CLI args | `clap` | `util.parseArgs` |
| UUID | `uuid` crate | `Bun.randomUUIDv7()` |
| Web UI build | `vite` + separate toolchain | `Bun.serve` imports `index.html` directly |
| Test runner | `cargo test` | `bun test` |
| Single binary | `cargo build --release` | `bun build --compile` |
| Type sharing UI ↔ server | manual duplication | one `.ts` file imported by both |

The last row is the one that decided it. The board renders the domain model; when the domain model is the same TypeScript file the server writes and the browser reads, a schema change is one edit and a type error, not two edits and a runtime surprise.

**What we give up, honestly:**

- Raw throughput. Irrelevant at this scale, and if a validator ever becomes CPU-bound we can shell out to a compiled helper for that one thing.
- Compile-time exhaustiveness on par with Rust enums. TypeScript discriminated unions plus `strict` and `noUncheckedIndexedAccess` get most of the way; the gap is closed by parsing at the edges (Part III of the spec).
- Memory determinism. Not a property this tool needed.

---

## Structural changes

### 1. Crates became packages, and two of them merged

| v0.1 crate | v0.2 |
|---|---|
| `uassist_core` | `@uassist/core` |
| `uassist_server` | `@uassist/server` |
| `uassist_cli` | `@uassist/cli` |
| `uassist_desktop` (Tauri + React) | `packages/server/web` (vanilla TS), Tauri deferred to Phase 7 |
| `uassist_unity` | `integrations/unity` (unchanged C#) |
| `uassist_blender` | `integrations/blender` (unchanged Python) |

Core and server run in one process. The CLI imports core directly and can start the server in-process rather than spawning a sidecar.

### 2. Persistence gained a database

v0.1 chose JSON-only persistence and listed "SQLite vs JSON" as an open decision. v0.2 resolves it as **both**: `bun:sqlite` as a rebuildable live store, a deterministic JSON mirror as the git-tracked source.

The doctrine point — "everything is a text file, no opaque blobs" — is preserved exactly, because the JSON is still the thing that survives. What changes is that the board no longer answers a matrix query by loading every file and scanning. `uassist db rebuild` replays the mirror into a fresh database, which is also the recovery path after `git pull`.

### 3. The Project record stopped holding id arrays

v0.1's `Project` struct carried `Vec<CardId>`, `Vec<MilestoneId>`, `Vec<AssetId>`, `Vec<JobId>`, `Vec<HealthItemId>`. With a database those are queries, and keeping both invited them to disagree — a card deleted from `cards/` but still listed in `project.json` is a class of bug that simply cannot happen now. Membership is a foreign key on the child row.

Likewise `Card.jobs`, `Card.comments`, and `Card.history` are relations rather than inline arrays.

### 4. Agent adapters push instead of being polled

The Rust `AgentAdapter` trait had `poll(handle) -> Vec<AgentEvent>`, which needs an interval, which is either too slow to feel live or too fast to be free. Bun's async iteration over a child's stdout inverts it:

```ts
events(handle: JobHandle): AsyncIterable<AgentEvent>
```

Agent output streams onto the card as it happens. `jobOutput` is a first-class WebSocket event.

### 5. The event stream became resumable

v0.1's WebSocket had no sequencing. v0.2 gives every event a monotonic `seq`; a reconnecting client sends its last `seq` and gets the gap replayed from `events.log`. A closed laptop lid no longer silently desynchronizes the board.

### 6. Health items gained fingerprints

v0.1's `HealthItem` had an `auto_close` flag with no defined mechanism. v0.2 adds a stable `fingerprint`: a validator run produces a set, and open auto-close items absent from that set resolve. This is what makes "the backlog writes itself" also mean "the backlog cleans itself up."

### 7. Plan cards gained a stable `sourceKey`

Re-ingest was specified in v0.1 but its identity mechanism was not. v0.2 hashes `(milestone slug, subsystem slug, normalized title)` so an edited task keeps its card, and falls back to fuzzy match within a milestone to present renames rather than an add plus a delete.

---

## Phasing changes

v0.1 shipped the Tauri desktop kanban in Phase 1 and the Unity/Blender plugins in Phase 2. v0.2 reorders around the stated goal — **webapp first, Tauri later**:

| Phase | v0.1 | v0.2 |
|---|---|---|
| 0 | Core model + plan import | Core model + store + plan import |
| 1 | Server **and Tauri desktop** kanban | Server and **web** kanban |
| 2 | Unity/Blender plugins | Plan re-ingest and views |
| 3 | Agent dispatch | Agent dispatch |
| 4 | Validators and health | Validators and health |
| 5 | Asset tracker and dashboards | Unity/Blender plugins |
| 6 | Assistant intelligence | Asset tracker and dashboards |
| 7 | — | **Tauri shell** |
| 8 | — | Assistant intelligence |

Two reasons for the reorder beyond the stated preference:

- The web UI is debuggable in a browser with devtools and no native toolchain, which makes Phase 1 much cheaper.
- Plan re-ingest (now Phase 2) is what makes the tool usable day-to-day on a plan that is still being edited. It was buried in v0.1 and it is the difference between a one-shot importer and a living board.

The plugins moved later because the file-watching fallback covers the same ground with no C# or Python, and because the server API they target should be settled before two more clients depend on it.

---

## What did not change

- The five doctrine rules.
- The domain vocabulary: Card, Milestone, Asset, Job, Health Item, Anchor, Context Packet.
- The five-word status vocabulary: `open` · `active` · `blocked` · `review` · `done`.
- Worktree isolation and propose-then-apply.
- The Unity C# extension and the Blender Python add-on — both always spoke HTTP to a local port and are indifferent to what answers.
- `unity-colony-build-plan.md`, which describes the game and is carried over verbatim.

---

## Fate of the Rust implementation

`/Users/ronin/rusty-apps/UAssist/` keeps ~2,300 lines of working Rust across core, server, and CLI, plus an imported project state in `.uassist/`.

**The Rust parser was ported, not copied — it had four bugs.** Run against `unity-colony-build-plan.md` it produced 10 milestones and 17 cards. The correct output is 7 milestones and 54 cards. What went wrong:

| Bug | Effect |
|---|---|
| Every `## ` heading became a milestone | "What Unity provides", "What we build in C#", "What the assistant builds" — prose sections under Part V — became phases |
| Bullets were not gated on being inside a phase | `Open world / streaming world (use discrete sectors)` was imported as a task **from the Cut list**, i.e. a thing explicitly decided against |
| Exit lines matched `*Exit gate.*` but the document writes `**Exit gate.**` | All 12 gate and demo conditions silently dropped; no gate or deliverable cards; every card had an empty acceptance list |
| A `looks_like_task` heuristic filtered bullets by an imperative-verb allowlist | 24 of 42 real phase bullets skipped, including "Cargo window UI…", "Health, medkits, food.", "Reload logic per ammo type." |

A fifth, less severe issue: category was always `Unknown`, because the heuristic only read `###` subsection headings and the colony plan has none inside its phase sections.

The port keeps the parser's good idea — a line scanner rather than a Markdown AST, so source line numbers come for free — and fixes the rules. The v0.2 parser gates on `## Phase N`, treats every bullet inside a phase as a task, matches both bold and italic exit lines, splits exit conditions into one acceptance criterion per sentence, and scores category hints against the bullet text rather than first-match against a heading. See the header comment in `packages/core/src/plan/parse.ts`.

**The `.uassist/` state in the Rust repo is therefore not a fixture to reproduce.** It is a record of what the old parser did. The Phase 0 exit gate is the round-trip property instead: import the plan, delete the database, rebuild from the JSON mirror, and get byte-identical output.
