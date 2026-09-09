# Unity Assistant Specification

**RastaCamp Studio · draft v0.2 (Bun) · September 2026**

**Purpose.** Bring the Toolwright project-agent layer inside a Unity project. The engine stays Unity; the assistant handles planning, code generation, validation, and review.

**Status.** Internal-first. No marketplace, no external customer, no sandboxing beyond "we trust ourselves."

**Relation to UAssist.** This document describes the *assistant behaviour*. `uassist-spec.md` describes the system that implements it. In v0.1 those were separate proposals — a Bun sidecar for Unity, and a Rust tool alongside it. They are now one thing: **the assistant is UAssist, and the Unity Editor window is one of its clients.** The web UI is the other, and it ships first.

---

# Part I — Positioning

The assistant is not a code completion tool. It is a **project-management surface** that turns friction into trackable work and dispatches verifiable work to CLI agents.

It borrows five ideas directly from the Toolwright specs:

1. **Nouns:** `Task`, `Job`, `Decision`, `Health Item`.
2. **Verb:** `Discuss`.
3. **Queue:** `Attention` — one surface, everything else is a view.
4. **Tasks anchor to objects** in the Unity project.
5. **Split work by verifiability:** agents write code, humans run it and look at the result.

## One vocabulary note

This document says **Task**; `uassist-spec.md` says **Card**. They are the same record. "Task" is the word inside the Unity window, where the thing in front of you is a piece of work; "Card" is the word on the board, where the thing in front of you is a rectangle in a matrix. The type is `Card` in code, and the Unity window labels it Task.

---

# Part II — Model

## 1. Attention queue

All work lives in one list:

- User-created tasks.
- Validator-generated health items.
- Agent results awaiting review.
- Agent questions awaiting answer.
- Pending decisions.

**Status vocabulary (fixed, five words):**

`open` · `active` · `blocked` · `review` · `done`

Two sub-views split the queue intentionally:

- **Intentional work:** things you chose to do.
- **Health:** things the project says are broken.

The full Attention queue merges both.

In UAssist terms, the Attention queue is a board view: columns = status, no rows, no swimlanes, health lane pinned. The Unity window renders it as a list; the web UI renders the same query as a board.

---

## 2. Tasks anchor to objects

A task is attached to something real, not free text.

```ts
interface Task {
  id: TaskId;                    // = CardId
  title: string;
  anchor?: Anchor;
  status: Status;
  origin: "user" | "validator" | "agent" | "pm-agent";
  severity?: "blocker" | "high" | "normal" | "low";
  blockedBy?: TaskId[];
  jobs: JobId[];
  createdAt: number;
  updatedAt: number;
}

type Anchor =
  | { kind: "asset";           path: string }          // any file in Assets/
  | { kind: "unityGameObject"; scene: string; path: string; instanceId?: number }
  | { kind: "unityPrefab";     path: string }
  | { kind: "script";          path: string; range?: [number, number] }
  | { kind: "scene";           path: string }
  | { kind: "dataTable";       path: string; sheet?: string }
  | { kind: "commit";          sha: string }
  | { kind: "build";           target: string }
  | { kind: "budget";          scope: string };
```

The `Anchor` union here is the Unity-facing subset of the full union in `uassist-spec.md`, which also carries `blenderObject` and `worktree` variants. One union, defined once in `@uassist/core`, imported by the web UI and mirrored by the C# client.

Anchoring buys three things:

- **Context derivation is mechanical.** A task on the `SecurityGuard` prefab already knows its controller script, animator, navmesh agent settings, and recent errors.
- **Status derives from state.** "Fix guard corner-stuck" closes when the validator stops flagging the prefab.
- **Navigation is bidirectional.** Click a task, land on the object. Select an object, see its open work.

Bidirectional navigation is an indexed query, not a scan: anchors are stored with `anchor_kind` and `anchor_path` extracted into their own columns.

---

## 3. The backlog writes itself

Validators emit health items as a byproduct. The assistant runs them on demand, on save, and on build.

| Source | Emits |
|---|---|
| Compile | errors with script path and line |
| Naming convention | scripts/classes violating project rules |
| Missing attribution | imported assets with no licence entry |
| NavMesh | agents not on NavMesh, missing baked data |
| Prefab validator | missing required components, unassigned references |
| Draw call / tri budget | scene over budget with offending objects attached |
| Save/load smoke | migration failures, missing fields |
| Scene lint | unreachable interactables, duplicate IDs |
| Style drift | assets flagged by project style profile |
| Agent result | diff returned, awaiting review |

**Rule:** a validator ships with the health item it emits. Never build the tracker first.

**Rule, added in v0.2:** a validator must emit a stable `fingerprint` per finding. Re-running a validator with no fix applied must produce the same fingerprint, so the item is updated rather than duplicated; a fingerprint that stops appearing closes its item automatically. A validator that cannot fingerprint its findings is a validator that turns the health lane into noise within a week.

---

## 4. Jobs

A Job dispatches work to a CLI agent.

```ts
interface Job {
  id: JobId;
  taskId: TaskId;
  agent: string;                // adapter id, e.g. "opencode", "claude-code"
  state: JobState;
  packet: ContextPacket;        // inspectable and editable before dispatch
  worktree: WorktreeRef;
  acceptance: string[];         // criteria the result is judged against
  budget: { maxCostUsd: number; maxDurationMs: number; maxAttempts: number };
  attempts: Attempt[];
  costUsd: number;
  logPath: string;
}

type JobState =
  | "drafted" | "dispatched" | "running" | "awaiting_answer"
  | "returned" | "review" | "accepted" | "rejected" | "refined";
```

### The context packet is the product

```ts
interface ContextPacket {
  objective: string;
  anchor: Anchor;
  anchorState: Record<string, unknown>;   // derived: component list, recent errors, usage count
  files: { path: string; reason: string }[];
  conventions: string[];                  // project conventions, incl. answered questions
  priorJobs: { id: JobId; outcome: string }[];
  acceptance: string[];
  constraints: string[];                  // budget, style profile, Unity version
}
```

The packet must be **inspectable and editable** before dispatch. A bad packet is the main failure mode.

`anchorState` is derived at assembly time, not stored: for a prefab anchor it is the component list and recent console errors touching that prefab; for a script anchor it is the file plus its direct importers. Deriving it fresh means a packet never ships stale state.

### Isolation

- Each job runs in its own git worktree, created with `Bun.$` so paths and branch names are escaped by construction.
- Agents never touch the working tree.
- What returns is a **diff you review**, never an applied change.

### Live output

The adapter exposes agent stdout as an async iterable, so job output streams to the Unity window and the web board as it is produced. There is no polling interval. A long-running job shows progress; a stuck one is visibly stuck.

---

## 5. What agents should and should not do

**Good agent work** — code and verifiable tools:
- C# MonoBehaviours and ScriptableObjects.
- Editor windows, PropertyDrawers, custom tools.
- Data importers/exporters.
- Unit tests and PlayMode tests.
- Refactoring and compile-error fixes.

**Bad agent work** — judged by eye:
- Scene composition (`.unity` YAML diffs are unreadable).
- Level dressing and prop placement.
- Art direction.
- Final tuning of feel values.

**The division:** agents write the tool; you run it and look at the level. Review load stays proportional to what a human can actually judge.

---

## 6. Agent questions

`awaiting_answer` is a first-class state. The job holds its worktree and context and resumes on answer.

```ts
interface AgentQuestion {
  jobId: JobId;
  question: string;
  context: string;
  options?: string[];
  recommendation?: string;
  timeoutPolicy: "suspend" | "proceed_with_recommendation";
  timeoutAfterMs: number;
}
```

- The assistant auto-answers project-state questions when it can resolve them from the store.
- Answers propagate into project conventions, so the same question is not asked twice.
- Timeouts have a stated policy, and the policy is on the question, not a global setting.
- A question arrives as a `questionAsked` WebSocket event, which means it can raise a notification in the Unity window rather than sitting unnoticed in a log.

---

## 7. Repo view

Worktrees as first-class objects:

- owning job, branch, base commit, ahead/behind
- diff stat, run state, cost
- **base drift** warning when the worktree's base falls behind HEAD past a threshold
- **conflict prediction** from file sets at dispatch time

Commits are anchored: a commit touching `Assets/Scripts/AI/` links to the AI tasks and prefabs it concerns.

Orphaned worktrees — from a crashed server or a killed agent — are cleaned by `uassist worktree prune`, which cross-references `git worktree list` against live job rows.

---

## 8. Send to prompt

Universal affordance on every object: right-click any asset, GameObject, task, log line, diff hunk, or health item → **Discuss** or **Dispatch**.

- **Discuss** opens chat.
- **Dispatch** becomes a job packet directly.

Typed chips carry the anchor into the composer.

---

## 9. PM agents

Narrow, scheduled, never continuous:

- **Triage** — categorize, dedupe, severity-score, link related work.
- **Staleness** — flag stalled active items and resolved blockers.
- **Dependency** — "keycard-door B is blocked because keycard-B item does not exist."
- **Digest** — what changed, what returned, what needs a decision.

Each runs on an interval as a validator with `triggers: ["interval"]`, which means they emit health items through the same path as everything else and get fingerprint dedupe for free.

---

## 10. Cost ledger

Agent spend and generation spend in one ledger. Per-job, per-day, running total attributed to tasks and anchors. Hard stop at cap.

The cap is enforced twice: at dispatch, and on every cost event during a run. A job that would exceed the cap mid-flight is killed and marked `rejected` with the reason, rather than discovered after the fact.

---

# Part III — Architecture

```
┌─ Unity Editor ────────────────────────────────────┐
│  Assistant window (dockable)                      │
│  ├─ Attention queue                               │
│  ├─ Task inspector                                │
│  ├─ Job status panel (live streamed output)       │
│  ├─ Context packet preview (editable)             │
│  ├─ Diff review UI                                │
│  └─ Send to prompt contextual menu                │
└──────────────┬────────────────────────────────────┘
               │ HTTP + WebSocket on 127.0.0.1:7373
               │
┌─ UAssist server (Bun) ────────────────────────────┐
│  Bun.serve — routes{} REST + websocket{} events   │
│  @uassist/core:                                   │
│    project state (bun:sqlite + JSON mirror)       │
│    git worktree manager (Bun.$)                   │
│    validator runner                               │
│    agent adapters (Bun.spawn, streaming stdout)   │
│    assistant provider                             │
│    cost ledger                                    │
└──────────────┬────────────────────────────────────┘
               │
               ├─── Web UI (vanilla TS)  ← ships first
               └─── Blender add-on (Python)
```

**Why Bun.** Same stack as the rest of the Bun Apps workspace. One runtime for the server, the CLI, the web UI, and the tests; `bun:sqlite` and `Bun.$` in the standard library; and `bun build --compile` ships the whole thing as a single binary when we want one. The full argument, including what it costs, is in `rust-to-bun-migration.md`.

**Where the server lives.** It is not a Unity-specific sidecar. It is a project-level daemon started by `uassist serve`, discoverable at `.uassist/port`, and shared by every client — the web board, the Unity window, and the Blender panel. The Unity window is a thin HTTP client with no state of its own beyond the current selection.

---

# Part IV — Unity Editor extension surfaces

The assistant contributes to Unity through standard Editor UI.

| Surface | Purpose |
|---|---|
| **Assistant window** | Main dockable panel showing Attention queue, job status, packet preview |
| **Hierarchy context menu** | Create task, send to prompt, see open work |
| **Project window context menu** | Same for assets, scripts, prefabs |
| **Inspector footer** | Open tasks for this object, health items |
| **Console integration** | Errors become anchorable health items |
| **Build post-processor** | Emit build health items (size, errors, validation) |

## Client discipline

- All state is fetched. The window caches nothing it cannot re-fetch, so a server restart is invisible.
- The WebSocket connection carries a monotonic `seq`; on reconnect the window sends its last `seq` and receives the gap. Domain reload in Unity is frequent, and a client that silently desynchronizes across one is worse than no live updates at all.
- When the server is not running, the window says so and offers to start it, rather than failing silently or blocking the editor.
- No Unity API call happens off the main thread; HTTP responses are marshalled through `EditorApplication.update`.

---

# Part V — Validators

Validators are the engine of the self-writing backlog. They run on save, on build, and on demand.

### MVP validators

1. **Compile error parser** — anchors to script file and line.
2. **Naming convention** — `class Foo : MonoBehaviour` must live in `Foo.cs`.
3. **Missing references** — serialized fields that are unassigned in prefabs.
4. **Missing licences** — imported assets with no entry in `Assets/Licences.csv`.
5. **NavMesh bake status** — scenes with NavMesh agents but no baked data.
6. **Budget validator** — scene triangle/draw-call budget; flag offenders.
7. **Save/load smoke** — run save, load, assert expected state.

### Where each one runs

Not all of these can run in the Bun process. Splitting them honestly:

| Validator | Runs in | Note |
|---|---|---|
| Compile error parser | Bun | parses `dotnet build` output, or Unity's `Editor.log` |
| Naming convention | Bun | text scan over `Assets/**/*.cs` |
| Missing licences | Bun | CSV cross-reference against asset records |
| Missing references | Unity | needs serialized object introspection; the C# side posts findings |
| NavMesh bake status | Unity | needs `NavMesh` API |
| Budget validator | Unity | needs the built scene |
| Save/load smoke | Unity | batch-mode PlayMode test |

Unity-side validators post their findings to `POST /api/events` with the same `HealthItem` shape, including the fingerprint. The health lane does not care which process found the problem.

### Later validators

Style profile drift for textures/materials, prefab version mismatch, unused assets, test coverage per namespace.

---

# Part VI — Capabilities

Agents declare capabilities; the assistant matches them to work. Internal-first means no user prompts, but declarations still drive the action-bar marker and cost gating.

| Capability | Risk |
|---|---|
| `code.read` | low |
| `code.write` | medium — must compile |
| `code.delete` | high — confirm |
| `asset.read` | low |
| `asset.write` | medium |
| `editor.tool` | medium |
| `generate` | high — budget-gated |
| `net` | high |
| `test.run` | low |

Capabilities are enforced at the adapter boundary, not by trusting the agent: a `net`-less job is spawned with an environment that has no proxy or credentials, and file writes are confined to the worktree by construction.

---

# Part VII — Phasing

The assistant ships incrementally alongside the game. It does not get built first.

**Ordering note.** The phases below are the *Unity-integration track*. In `uassist-spec.md` that track starts at its Phase 5, after the web board, plan re-ingest, agent dispatch, and validators exist. The reason is that all four of those are testable in a browser with devtools, while every one of them is painful to debug through a C# Editor window. By the time the Unity window is built, it is a client of an API that already works.

### Phase U0 — In-editor task list (1 week)

- Dockable window.
- Create task from selected object.
- Manual status editing.
- Reads and writes the running UAssist server; no local state.

### Phase U1 — Validators and health queue (1–2 weeks)

- Unity-side validators: missing references, NavMesh bake status.
- Bun-side compile error parser fed by `Editor.log`.
- Health items appear automatically, with fingerprint dedupe.

### Phase U2 — Agent dispatch from the editor (1–2 weeks)

- Context packet preview and edit in-window.
- Dispatch to an existing adapter.
- Live job output streamed into the window.
- Diff review UI.

### Phase U3 — Automation loop (2 weeks)

- Send to prompt from every surface.
- Auto-answer for project-state questions.
- Conventions propagation.
- PM-agent digest.

### Phase U4 — Advanced dispatch (ongoing)

- Multiple adapters.
- Conflict prediction.
- Build/validator-driven auto-dispatch for trivial fixes.
- Test-coverage-aware routing.

---

# Part VIII — Example workflows

### A: "Inventory UI is a mess"

1. Select `InventoryUI` GameObject.
2. Right-click → **Send to Agent → Discuss**.
3. Packet includes `InventoryUI.cs`, `InventoryManager.cs`, current prefab path, acceptance: "refactor into slot/grid pattern, no runtime regressions."
4. Agent returns diff.
5. Compile, play-mode smoke, review, accept/reject.

### B: "Guard gets stuck on corners"

1. Validator emits a health item on the `SecurityGuard` prefab.
2. Click **Dispatch**.
3. Packet includes guard controller, navmesh settings, scene geometry summary.
4. Agent returns a patch for avoidance priority and a stuck-timer fallback.
5. Test in scene, accept. The validator stops emitting that fingerprint and the health item closes itself.

### C: "Add Electric ammo type"

1. Dispatch a job anchored to the `AmmoDatabase` ScriptableObject.
2. Agent returns: `ElectricAmmo` data, `Weapon` update, reload logic.
3. Human creates a test weapon, fires it, tunes values.

---

# Part IX — Cautions

1. **Review is the bottleneck.** Cap concurrency at 1–3. Unreviewed diffs rot.
2. **Never auto-apply.** Propose-then-apply at all times.
3. **Agents do not touch scenes.** Scene YAML diffs are unreadable and merge badly.
4. **Context packets must be editable.** You cannot debug what you cannot see.
5. **Don't let the assistant become the product.** It exists to keep the game moving.
6. **The Unity window is a client, not a second implementation.** Any logic that ends up in C# and not in `@uassist/core` will drift.

---

# Part X — Relation to Toolwright

This assistant is a **portable subset** of the Toolwright project-agent layer. If Toolwright matures, the assistant can migrate to it. Until then, it runs alongside Unity and keeps the real project honest.
