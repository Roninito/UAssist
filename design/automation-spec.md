# Automation, Engine Integration, and Guided Decisions Specification

**RastaCamp Studio · draft v0.1 · September 2026**

**Purpose.** Four asks, considered together because two of them turn out to be the same mechanism: project bootstrap must be load-bearing, not optional; Unity/Blender integration needs both a CLI and an MCP path, configurable; the workspace must be watched over time, not just scanned on demand; and both that watching *and* the assistant's own judgment need to reach the user as reviewable proposals — yes, no, or hold — never as silent action.

**Status.** Formal design. Not yet implemented. Read alongside `workspace-spec.md`, which this extends rather than replaces.

---

# Part I — Project bootstrap is prime infrastructure, not a feature

## The reframe

Every prior phase has treated "link a Unity project" as something a user does *eventually*, on the Project Meta page, whenever they get around to it. That is backwards, and the user's own framing corrects it directly: **initialization is a first-class, mandatory consideration of the system.** A UAssist project that exists without a real, structured workspace behind it is exactly the failure mode `workspace-spec.md` opened with — cards describing a concept instead of a project. The fix is not a better Rescan button. It is refusing to let that gap open in the first place.

Concretely, this means `uassist init` — and its future web-UI equivalent, since this has to hold for projects created from the browser, not only the CLI — stops being "create `.uassist/`" and becomes "create `.uassist/`, and ensure there is a real, scannable Unity and/or Blender workspace behind it before the project is considered ready." A project without one is not a silent, permanent state; it is a visibly incomplete one that the system keeps surfacing until closed.

## Two paths to a real Unity workspace, both supported

The user posed this as an either/or; both are genuinely useful for different situations, so both are built, selected per-project:

### A. Headless — UAssist creates the Unity project directly

Unity Editor supports project creation from the command line:

```bash
Unity -batchmode -nographics -createProject <path> -quit -logFile <log>
```

`packages/core/src/unity/bootstrap.ts` wraps this the same way `worktree.ts` wraps git: locate a Unity Editor binary (`UNITY_PATH` env var, or the platform-conventional Hub install location — `/Applications/Unity/Hub/Editor/<version>/Unity.app/...` on macOS, `%ProgramFiles%\Unity\Hub\Editor\<version>\Editor\Unity.exe` on Windows), run it in batch mode, wait for exit, then hand the resulting path straight to `validateUnityPath` — the exact function that already exists — to confirm it worked before the project is marked ready.

This needs Unity actually installed and licensed on the machine running UAssist. It is fast and fully automatic when that is true, and a clear, specific failure (naming what is missing) when it is not — never a silent no-op.

### B. Task-based — a card with detailed instructions, optionally dispatched

The other path needs nothing installed locally: `uassist init` creates a **setup card** — `kind: "task"`, `category: "Infra"`, milestone-less (it precedes any milestone) — whose description is a fully specified instruction: target Unity version, render pipeline (URP, per `unity-colony-build-plan.md`'s own stack table when a build plan is already known), starter folder layout under `Assets/`, and the acceptance criterion `validateUnityPath` will check. This card can be worked by a human, or dispatched (Part IX, `uassist-spec.md`) to an agent capable of driving Unity itself — which is exactly what Part II's MCP integration is for.

This is not a fallback bolted on for when headless isn't available. It is the *safer default* — nothing to install, nothing version-specific to get right, and it produces a reviewable artifact (the completed setup, diffed like any other job) instead of a batch-mode process a person has to trust blindly.

## Configuration

```ts
interface BootstrapConfig {
  unity?: { mode: "headless" | "task"; version?: string; renderPipeline?: "URP" | "builtin" | "HDRP" };
  blender?: { mode: "task" }; // Blender has no equivalent of Unity's -createProject; task-based only for now
}
```

Set at `uassist init` time (`--unity-mode headless|task`, prompted if omitted rather than silently defaulted) and stored on `Project`. Blender has no real analog to `-createProject` — a `.blend` file is not a project scaffold the way a Unity folder is — so `Blender` bootstrap is task-based only until a real need for more is shown.

## Enforcement, not just availability

A project with neither a valid `unityProjectPath` nor `blenderSourcePath` is **incomplete**, and the system says so persistently rather than once:

- `uassist status` and the server's own startup log both print a one-line nudge when no workspace is linked — not an error, a visible fact.
- The Project Meta page's Workspace section (already built) becomes the completion surface for exactly this: unlinked shows the setup card's status inline, not just an empty "not linked" badge.
- `GET /api/project` includes `workspaceComplete: boolean` so the board's own chrome can show a small, honest, un-ignorable indicator — not a blocking modal; this tool does not gate the board on it, it just refuses to let the gap go unnoticed.

## Initial scan is automatic, not a button

The moment `validateUnityPath`/`validateBlenderPath` succeeds — whether via headless creation, a completed setup task's acceptance, or a manually linked existing project — a scan runs immediately, unprompted. The Rescan button (already built) remains for every scan after that first one. The first one is not something a person has to remember to click; the gap between "workspace linked" and "catalog populated" should not exist long enough to be a state anyone observes.

---

# Part II — Engine integration: CLI, MCP, or both

## Positioning

Today, the only way anything talks to Unity or Blender is the static Asset Catalog scanner (Phase 1.5) and the *future* live plugins (Phase 5, C# Editor extension / Python add-on posting events). Neither of those *drives* the engines — they observe. This part adds the other direction: **acting on Unity and Blender**, for bootstrap (Part I), for dispatched jobs that need to compile or run a batch-mode check, and for the assistant itself when it needs a live answer ("what components does this prefab have") rather than a catalog guess.

Two mechanisms, not a choice between them — configured per engine, per project:

```ts
type EngineIntegrationMethod = "cli" | "mcp" | "both";

interface EngineIntegrationConfig {
  unity?: { method: EngineIntegrationMethod; mcpServerUrl?: string };
  blender?: { method: EngineIntegrationMethod; mcpServerUrl?: string };
}
```

## CLI

Direct invocation, the same discipline `worktree.ts` and `dispatch.ts` already established — `Bun.spawn`, an env allowlist, no shell interpolation:

- **Unity**: `Unity -batchmode -nographics -projectPath <path> -executeMethod <Class.Method> -quit -logFile <path>` — this is how Part I's headless bootstrap works, and it is also how a dispatched job's *acceptance check* can be genuinely verified rather than trusted: "does the project still compile" is `-executeMethod` calling a small bundled Editor script that exits nonzero on a compile error, not a guess from reading source.
- **Blender**: `blender --background <file.blend> --python <script.py>` — for headless renders, exports, or a verification script analogous to Unity's.

Both are wrapped as a `Capability` (`editor.tool`, already defined in `adapters/types.ts`) an adapter can declare it needs; `dispatch.ts` supplies the engine binary path (from `EngineIntegrationConfig`, resolved the same way Part I's Unity binary lookup works) via the same env-allowlist mechanism already built, nothing new to the trust model.

## MCP

Both community Unity-MCP and Blender-MCP servers exist — they expose engine operations (scene inspection, asset import, script compilation status, render triggers) as MCP tools rather than a batch-mode process per call. Where one is configured (`mcpServerUrl`), it is available in two places:

1. **The assistant's own chat** (Part VIII, `uassist-spec.md`) can call it for a live answer instead of the catalog's static snapshot — "what components are on the Player prefab right now" is an MCP tool call, not a heuristic parse of `.prefab` YAML the catalog scanner deliberately does not attempt (`workspace-spec.md` Part III).
2. **A dispatched agent's context packet** (`packet.ts`) can carry the MCP server's connection info as a `constraint`, for adapters whose underlying agent supports MCP tool use directly (Claude Code does) — so an agent asked to "add an Electric ammo type" can inspect the live Unity state through MCP rather than only the static files in its worktree.

MCP is additive, never a replacement for the CLI path — a batch-mode compile check stays a batch-mode compile check even when MCP is configured, because it is the more literal, harder-to-fool verification the "Four gates" doctrine (`unity-colony-build-plan.md` Part VI) already insists on: "C# compiles before it ships. No agent diff is applied without a successful compile."

## What this does not do

No MCP server is bundled or auto-installed. UAssist is a client here, not a distributor — pointing `mcpServerUrl` at a Unity-MCP install is a configuration step the user performs, matching the same posture as pointing `unityProjectPath` at an existing project: UAssist links to what exists, it does not manage the engine ecosystem underneath it.

---

# Part III — Periodic scanning and reconciliation

## From on-demand to watched

Phase 1.5 shipped a scanner triggered by a button and a CLI command. This part adds a scheduler: the running server (already the natural home for anything long-lived — it holds the WebSocket bus, the reclaim logic, everything else with a lifetime longer than one request) runs a scan on an interval.

```ts
interface ScanScheduleConfig {
  enabled: boolean;
  intervalMinutes: number; // default 15
}
```

Configured on `Project`, defaulting to enabled at 15 minutes — frequent enough that "the board reflects the project" stays true without a person remembering to ask, infrequent enough that scanning a real `Assets/` tree never becomes background noise. `setInterval` inside `startServer` (Part XIII, `uassist-spec.md`), guarded so a slow scan never overlaps itself.

## Reconciliation: what a scan diff means

A scan already produces a new catalog. Reconciliation is the new step: **compare it against the previous one** and turn the difference into something a human can act on.

```ts
interface CatalogDiff {
  added: WorkspaceAsset[];
  removed: { path: string; source: "unity" | "blender" }[];
  changed: { path: string; source: "unity" | "blender"; hashBefore: string; hashAfter: string }[];
}
```

Computed by diffing the new scan's rows against what `workspace_assets` held before `replaceWorkspaceAssets` overwrote them — cheap, since both sides are already in memory at scan time.

From that diff, two kinds of proposal (never a direct write — see Part IV):

1. **A new, unplanned asset.** A script, prefab, or scene appears that no card anchors to. Propose a card: title guessed from the filename/class name, category guessed the same way the plan parser already guesses category (`plan/parse.ts`'s `categoryFor`, reused rather than reinvented), anchor pre-filled to the real new file.
2. **Evidence a card might be done.** A card's anchor changed (script edited after being untouched, a scene file's mtime moved past the card's last status change) *and* every one of its acceptance criteria that can be mechanically checked (currently: none — acceptance checking against real state is Phase 4's job, not this one) passes. Until validators exist, this proposal is deliberately conservative: it surfaces as "this card's anchor changed since it was last touched — worth a look," not "mark this done." Overclaiming completion from a file timestamp is exactly the kind of guess this whole feature exists to avoid making silently.

## Doctrine: propose, never apply

Every reconciliation output is a `Suggestion` (Part IV). Nothing here writes a card directly. This is the same propose-then-apply discipline `unity-assistant-spec.md` Part IX states for agent output, applied to the scanner's own output — a file changing is not more trustworthy evidence than an agent's diff, and gets the same review gate.

---

# Part IV — The Decisions queue: yes / no / hold

## One queue, two sources

The user's fourth ask — AI analysis and guidance the user approves, rejects, or holds — and the third ask's reconciliation output are the same shape: a proposed change to project state, with a reason, awaiting a human decision. Building two separate review surfaces for them would be the wrong call; one queue, two producers:

```ts
type SuggestionKind =
  | "create_card"        // an unplanned asset, or an assistant-identified gap
  | "update_card_status"  // reconciliation evidence, never auto-applied
  | "attach_anchor"       // an existing card, a newly-scanned asset that matches it
  | "dispatch"             // "this card looks ready for an agent"
  | "close_health_item";   // once validators exist (Phase 4) — fingerprint absent, propose closing

interface Suggestion {
  id: string;
  kind: SuggestionKind;
  source: "reconciliation" | "assistant";
  rationale: string;           // one sentence, shown verbatim — "why this, now"
  payload: Record<string, unknown>; // shape depends on kind; validated at apply time, not creation time
  relatedCardId?: string;
  status: "pending" | "accepted" | "rejected" | "held";
  createdAt: number;
  decidedAt?: number;
}
```

## Hold is not a third answer to yes/no — it is deferral

`held` means "not now, ask me again later" — distinct from `rejected` ("no, and don't ask again for this exact thing"). A held suggestion resurfaces on the next reconciliation pass or the next digest if its underlying condition still holds; a rejected one with the same fingerprint (same kind + same payload shape) does not resurface, the same dedupe discipline `HealthItem.fingerprint` already established for validators.

## Where the assistant's own suggestions come from

Part VIII of `uassist-spec.md` already lists digest-shaped assistant commands ("Show this week's digest," "Why is this card blocked"). This part makes one of them proactive rather than only reactive: a **daily digest pass** (same scheduler as the scan, a longer interval — default once per day) asks the assistant, given the current board state, "what's worth a human decision right now" — stale active cards, an obvious next dispatch candidate, a dependency that just unblocked. Its answer becomes `Suggestion` rows with `source: "assistant"`, not free text — the whole point is that these land in the same reviewable, dismissible queue as everything else, not as one more chat message to lose track of.

## Server and UI

```
GET  /api/suggestions              # pending by default, ?status= for others
POST /api/suggestions/:id/accept   # applies the payload, kind-specific
POST /api/suggestions/:id/reject
POST /api/suggestions/:id/hold
```

Accepting a `create_card` suggestion calls the same card-creation path the plan importer uses; accepting `dispatch` opens the existing dispatch flow pre-filled rather than dispatching blind — a suggestion to dispatch is not permission to skip the budget/objective review Part IX already insists on.

UI: a **Decisions** panel, reachable from the header nav (`Board | Project | Docs | Decisions`) alongside a small badge count — the same visual register as the pinned Health lane (`uassist-spec.md` Part VI), because the property is the same: something the system found that a human has not yet looked at, that cannot be hidden, only resolved.

---

# Part V — Project overview: git and logs

An extension to the existing Project Meta page (`workspace-spec.md` Part II), not a new page — identity, workspace, and plan already live there; this is the remaining context a person reaches for when orienting on a project.

## Git

```ts
interface GitStatus {
  branch: string;
  headSha: string;
  headMessage: string;
  ahead?: number;
  behind?: number;
  openJobBranches: { branch: string; jobId: string; cardTitle: string }[];
}
```

`openJobBranches` is `git worktree list` cross-referenced with `jobs` in state `dispatched | running | awaiting_answer | returned | review` — the same list `uassist worktree prune` already knows how to compute, surfaced instead of only acted on.

## Logs

A read-only tail, not a full log viewer — this project's own instinct throughout (small, legible surfaces over a framework) applies here too:

- Last 50 lines of `events.log`, human-formatted.
- Per-job log link (`.uassist/jobs/{id}.log`, already written by `dispatch.ts`) for any job still visible in `openJobBranches`.

`GET /api/project/git` and `GET /api/project/logs?limit=50`, both cheap reads with no new storage.

---

# Part VI — Phasing

Slots into the existing plan (`uassist-spec.md` Part XVII) rather than replacing it.

## Phase 1.5 amendment — Bootstrap enforcement

Retroactive to the phase already shipped: `uassist init` gains the headless/task bootstrap choice and the `workspaceComplete` flag. Small enough to fold into 1.5's own scope rather than a new phase number.

## Phase 3.5 — Engine integration (CLI + MCP)

Follows agent dispatch (Phase 3, shipped) because it is dispatch's own context packet and adapter capability model that MCP connection info and CLI verification hook into.

**Exit gate:** a dispatched job's acceptance check runs a real Unity batch-mode compile, not a guess from reading the diff.

## Phase 3.75 — Periodic scanning, reconciliation, and the Decisions queue

Follows 3.5 because dispatch suggestions are one of the queue's two producers.

**Exit gate:** rename a script in Unity outside UAssist entirely; on the next scheduled scan, a suggestion appears proposing to update the card that anchored to it; accept it, and the anchor updates without hand-editing.

## Phase 4 (unchanged) — Validators and health

`close_health_item` suggestions and Part III's "evidence a card is done" both sharpen considerably once real validators exist to check acceptance criteria mechanically rather than by file-mtime heuristic.

---

# Part VII — Relation to other documents

- `workspace-spec.md` — this document's Part I is the enforcement layer on top of that document's Workspace/Asset Catalog; Part III's reconciliation is the "later, once validators exist" note from that document's anchor-health section, arriving sooner than originally scoped, via a heuristic path rather than the validator runner.
- `uassist-spec.md` — Part IX (dispatch), Part VIII (assistant commands) are what Parts II and IV here extend.
- `unity-colony-build-plan.md` — Part I's headless bootstrap reads its stack table (Unity version, URP) as the default when a build plan is already imported.

---

# Part VIII — Cautions

1. **Reconciliation proposes; it never writes.** Repeated here because it is the one rule in this document most tempting to shortcut for convenience, and the one whose violation would most directly undo the trust the whole "propose-then-apply" doctrine depends on.
2. **A scheduled scan must not become invisible load.** A very large `Assets/` tree scanned every 15 minutes is real disk I/O on a timer; the interval is configurable and disableable per project for exactly this reason, and a scan that takes longer than its own interval must skip the next tick rather than queue up.
3. **MCP server availability is not assumed.** A configured `mcpServerUrl` that is unreachable degrades to the CLI path (or to "assistant answers from the catalog snapshot instead of live state"), never a hard failure of unrelated functionality.
4. **Headless bootstrap failures must name what's missing.** "Unity not found," "no license," "batch mode exited 1" are three different problems; collapsing them into one generic error is the thing that makes a person distrust automation.

---

# Part IX — Open decisions

1. **Digest cadence.** Once per day is a starting guess for the assistant's proactive suggestion pass; the real answer depends on how noisy it turns out to be in practice.
2. **Suggestion payload validation.** Deferred to apply-time per kind rather than a shared schema — revisit if the `SuggestionKind` list grows past what a per-kind `switch` handles cleanly.
3. **Blender headless bootstrap.** Task-based only for now (Part I). If a genuine "create a starter `.blend` with a scene template" need appears, revisit.
4. **Multiple MCP servers per engine.** Currently one `mcpServerUrl` per engine. A studio running Unity-MCP and a second custom MCP server simultaneously is not designed for; not known to be a real need yet.
