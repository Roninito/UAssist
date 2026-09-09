/**
 * Project bootstrap — prime infrastructure, not an optional feature.
 *
 * A UAssist project without a real, validated workspace behind it is the
 * exact failure mode workspace-spec.md opened with: cards describing a
 * concept instead of a project. `bootstrapProject` is the enforcement point —
 * it is what `uassist init` (and, later, a web equivalent) actually calls, so
 * that gap does not get a chance to open for any project created going
 * forward.
 *
 * See design/automation-spec.md Part I.
 */

import { join } from "node:path";

import { newId } from "./ids.ts";
import { scanAndReconcile } from "./reconcile.ts";
import { registerProject } from "./registry.ts";
import { initProject, Store } from "./store.ts";
import type { Card, Project } from "./types.ts";
import { newCardDefaults } from "./types.ts";
import { validateBlenderPath, validateUnityPath } from "./workspace/scan.ts";
import { createUnityProjectHeadless, findUnityBinary } from "./unity/bootstrap.ts";

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * A project is complete once at least one engine is genuinely linked — not
 * both; a Blender-only or Unity-only project is a normal, finished state, not
 * a half-finished one. Computed fresh from the filesystem every time, the
 * same way GET /api/workspace already validates — never cached, because a
 * linked-but-since-deleted path must stop counting immediately.
 */
export function isWorkspaceComplete(project: Project): boolean {
  const unityOk = project.unityProjectPath ? validateUnityPath(project.unityProjectPath).valid : false;
  const blenderOk = project.blenderSourcePath ? validateBlenderPath(project.blenderSourcePath).valid : false;
  return unityOk || blenderOk;
}

// ---------------------------------------------------------------------------
// The task-based setup card — the safer default
// ---------------------------------------------------------------------------

const UNITY_SETUP_INSTRUCTIONS = `Create the Unity project this UAssist project coordinates.

Nothing else here can point at anything real until this exists — cards, anchors, and every agent's context packet are grounded through the Asset Catalog, which has nothing to scan until this project exists on disk.

Steps:
1. Create a new Unity project (2022.3 LTS, or the latest Unity 6 LTS after its first patch — prefer whichever this machine already has installed via Unity Hub).
2. Set the render pipeline to URP (Universal Render Pipeline) at creation, or convert immediately after — this project's stack assumes URP throughout.
3. Create the starter folder layout under Assets/:
   - Assets/Scripts/
   - Assets/Prefabs/
   - Assets/Scenes/
   - Assets/Materials/
   - Assets/Data/ (ScriptableObjects)
   - Assets/Audio/
4. Save the project. Confirm it opens without console errors.
5. Once done, link the project's absolute path on the Project Meta page (Workspace section) — that link is what turns this card's acceptance criteria checkable and lets everything else in UAssist start referencing real files.

If a build plan has already been imported (check the Docs page), its own stack table — if it specifies a different Unity version or pipeline — takes precedence over the defaults above.`;

/** Exported so ensureWorkspaceSetupCards can recognise one without a second, drifting copy of the string. */
export const UNITY_SETUP_TITLE = "Set up the Unity project";

/**
 * A card, not a silent default. This is the task-based bootstrap path
 * (design/automation-spec.md Part I) — dispatchable like any other card once
 * agent dispatch exists, or worked by hand. Deliberately blocker-priority and
 * milestone-less: it precedes any milestone a plan import would create.
 */
export function createUnitySetupCard(now: number = Date.now()): Card {
  return {
    ...newCardDefaults(now),
    id: newId("card"),
    title: UNITY_SETUP_TITLE,
    description: UNITY_SETUP_INSTRUCTIONS,
    category: "Infra",
    kind: "task",
    priority: "blocker",
    acceptance: [
      { text: "Assets/ and ProjectSettings/ exist at the project root.", met: false },
      { text: "The project opens in Unity Editor with no console errors.", met: false },
      { text: "Render pipeline is URP.", met: false },
      { text: "The project's absolute path is linked on the Project Meta page.", met: false },
    ],
  };
}

const BLENDER_SETUP_INSTRUCTIONS = `Set up the Blender source directory this UAssist project coordinates.

Unlike Unity, Blender has no project-scaffold equivalent to "create project" — a source directory with .blend files in it is the whole of what "linked" means here.

Steps:
1. Choose or create a directory to hold this project's .blend files (a "sectors/" or "assets/" subfolder is a reasonable convention if this project also has a Unity side).
2. Save at least one .blend file into it — an empty scene is enough to make the directory a valid, linkable workspace.
3. Link the directory's absolute path on the Project Meta page (Workspace section).`;

export const BLENDER_SETUP_TITLE = "Set up the Blender source directory";

export function createBlenderSetupCard(now: number = Date.now()): Card {
  return {
    ...newCardDefaults(now),
    id: newId("card"),
    title: BLENDER_SETUP_TITLE,
    description: BLENDER_SETUP_INSTRUCTIONS,
    category: "Infra",
    kind: "task",
    priority: "blocker",
    acceptance: [
      { text: "A directory exists containing at least one .blend file.", met: false },
      { text: "The directory's absolute path is linked on the Project Meta page.", met: false },
    ],
  };
}

/**
 * Self-healing: a project can end up with no engine linked and no open
 * setup card for reasons `uassist init` alone can't prevent — it predates
 * this safety net, a card got deleted, or a linked path was later removed
 * from disk. Called on every server start and on every scan-scheduler tick
 * (see index.ts), so the gap never has a chance to sit unnoticed for long.
 *
 * A no-op once either engine is genuinely linked (`isWorkspaceComplete`) —
 * a Blender-only or Unity-only project is a normal, finished state, not
 * something to keep nagging about the other engine for. Below that bar,
 * both cards are (re)created, because which engine the project actually
 * needs is exactly the kind of thing this system does not get to guess.
 */
export function ensureWorkspaceSetupCards(store: Store, project: Project): Card[] {
  if (isWorkspaceComplete(project)) return [];

  const cards = store.listCards();
  const hasOpenCard = (title: string) => cards.some((c) => c.title === title && c.status !== "done");

  const created: Card[] = [];
  if (!hasOpenCard(UNITY_SETUP_TITLE)) {
    const card = createUnitySetupCard();
    store.putCard(card);
    created.push(card);
  }
  if (!hasOpenCard(BLENDER_SETUP_TITLE)) {
    const card = createBlenderSetupCard();
    store.putCard(card);
    created.push(card);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Bootstrap options and orchestration
// ---------------------------------------------------------------------------

export type UnityBootstrapChoice =
  | { mode: "existing"; path: string }
  | { mode: "headless"; targetPath?: string; unityBinary?: string; timeoutMs?: number }
  | { mode: "task" };

export type BlenderBootstrapChoice = { mode: "existing"; path: string } | { mode: "task" };

export interface BootstrapOptions {
  root: string;
  name: string;
  unity?: UnityBootstrapChoice;
  blender?: BlenderBootstrapChoice;
  /** Overrides the machine registry's home directory — real callers never
   *  set this; it exists so tests never touch the real ~/.uassist/registry.json. */
  registryHome?: string;
}

export interface EngineBootstrapOutcome {
  linked: boolean;
  path?: string;
  error?: string;
  logTail?: string;
}

export interface BootstrapResult {
  store: Store;
  project: Project;
  setupCards: Card[];
  unity?: EngineBootstrapOutcome;
  blender?: EngineBootstrapOutcome;
  workspaceComplete: boolean;
}

/** Scan and stamp workspaceScannedAt — the "no button to remember" rule from
 *  automation-spec.md Part I, "Initial scan is automatic, not a button." */
function scanAndStamp(store: Store, project: Project, source: "unity" | "blender", path: string): Project {
  // The very first scan of a freshly bootstrapped project — nothing on the
  // board yet to reconcile against, but going through scanAndReconcile
  // rather than a raw scan keeps this the one place a scan ever runs.
  scanAndReconcile(store, source, path);
  const stamped = { ...project, workspaceScannedAt: Date.now() };
  store.putProject(stamped);
  return stamped;
}

async function resolveUnity(
  store: Store,
  project: Project,
  choice: UnityBootstrapChoice,
  root: string,
): Promise<{ project: Project; outcome: EngineBootstrapOutcome; setupCard?: Card }> {
  if (choice.mode === "existing") {
    const validation = validateUnityPath(choice.path);
    if (!validation.valid) {
      return { project, outcome: { linked: false, error: validation.reason } };
    }
    let next: Project = { ...project, unityProjectPath: choice.path, updatedAt: Date.now() };
    store.putProject(next);
    next = scanAndStamp(store, next, "unity", choice.path);
    return { project: next, outcome: { linked: true, path: choice.path } };
  }

  if (choice.mode === "headless") {
    const unityBinary = choice.unityBinary ?? findUnityBinary();
    if (!unityBinary) {
      return {
        project,
        outcome: {
          linked: false,
          error: "no Unity Editor installation found — set UNITY_PATH, or use task mode instead",
        },
      };
    }
    const targetPath = choice.targetPath ?? join(root, "UnityProject");
    const result = await createUnityProjectHeadless({
      unityBinary,
      targetPath,
      timeoutMs: choice.timeoutMs,
    });
    if (!result.success) {
      return { project, outcome: { linked: false, error: result.error, logTail: result.logTail } };
    }
    let next: Project = { ...project, unityProjectPath: targetPath, updatedAt: Date.now() };
    store.putProject(next);
    next = scanAndStamp(store, next, "unity", targetPath);
    return { project: next, outcome: { linked: true, path: targetPath } };
  }

  // task mode
  const card = createUnitySetupCard();
  store.putCard(card);
  return { project, outcome: { linked: false }, setupCard: card };
}

async function resolveBlender(
  store: Store,
  project: Project,
  choice: BlenderBootstrapChoice,
): Promise<{ project: Project; outcome: EngineBootstrapOutcome; setupCard?: Card }> {
  if (choice.mode === "existing") {
    const validation = validateBlenderPath(choice.path);
    if (!validation.valid) {
      return { project, outcome: { linked: false, error: validation.reason } };
    }
    let next: Project = { ...project, blenderSourcePath: choice.path, updatedAt: Date.now() };
    store.putProject(next);
    next = scanAndStamp(store, next, "blender", choice.path);
    return { project: next, outcome: { linked: true, path: choice.path } };
  }

  const card = createBlenderSetupCard();
  store.putCard(card);
  return { project, outcome: { linked: false }, setupCard: card };
}

/**
 * The single entry point `uassist init` (and, later, a web equivalent) calls.
 * Composes store creation, machine-registry registration, and — the part
 * that makes initialization prime infrastructure rather than an afterthought
 * — either a validated real workspace link, a headless-created one, or an
 * explicit, dispatchable setup card. Never leaves a project silently
 * unlinked with nothing marking that fact.
 */
export async function bootstrapProject(options: BootstrapOptions): Promise<BootstrapResult> {
  const { store, project: initial } = initProject(options.root, options.name);
  registerProject({ id: initial.id, name: initial.name, root: options.root }, options.registryHome);

  let project = initial;
  const setupCards: Card[] = [];
  let unity: EngineBootstrapOutcome | undefined;
  let blender: EngineBootstrapOutcome | undefined;

  if (options.unity) {
    const result = await resolveUnity(store, project, options.unity, options.root);
    project = result.project;
    unity = result.outcome;
    if (result.setupCard) setupCards.push(result.setupCard);
  }

  if (options.blender) {
    const result = await resolveBlender(store, project, options.blender);
    project = result.project;
    blender = result.outcome;
    if (result.setupCard) setupCards.push(result.setupCard);
  }

  return {
    store,
    project,
    setupCards,
    unity,
    blender,
    workspaceComplete: isWorkspaceComplete(project),
  };
}
