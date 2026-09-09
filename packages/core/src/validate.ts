/**
 * Validators — mechanical health checks against real project state.
 *
 * See design/uassist-spec.md's Phase 4 and design/automation-spec.md Part
 * VII ("Part III's reconciliation is the 'later, once validators exist'
 * note from workspace-spec.md's anchor-health section, arriving sooner
 * than originally scoped").
 *
 * Each validator returns the set of fingerprints it currently sees and the
 * HealthItems for them; `runValidators` writes those and then auto-closes
 * any previously-open item for that validator's `source` whose fingerprint
 * did not reappear (Store.closeStaleHealthItems) — the mechanism
 * HealthItem.fingerprint's own doc comment in types.ts describes.
 *
 * This is a different discipline from reconcile.ts's Suggestion queue. A
 * Suggestion proposes a board write (a card, an anchor) and must never
 * apply itself — Part VIII's "propose, never apply." A HealthItem never
 * writes a card at all; it only flags one, which is why it has always
 * written directly (Phase 1's own design, unchanged here) rather than
 * going through the Decisions queue.
 */

import { isWorkspaceComplete } from "./bootstrap.ts";
import { newId } from "./ids.ts";
import { anchorSource } from "./packet.ts";
import type { Store } from "./store.ts";
import { findUnityBinary } from "./unity/bootstrap.ts";
import { runUnityCompileCheck } from "./unity/verify.ts";
import type { Anchor, HealthItem } from "./types.ts";

export interface ValidatorOutput {
  fingerprints: Set<string>;
  items: HealthItem[];
}

// ---------------------------------------------------------------------------
// Workspace incomplete — no Unity or Blender workspace linked at all. The
// same "cards, anchors, and every agent's context packet are grounded
// through the Asset Catalog" concern bootstrap.ts's own doc comment states
// for initialization — surfaced here as a standing, pinned-lane warning for
// as long as it stays true, not just a one-time console line at boot.
// ---------------------------------------------------------------------------

export const WORKSPACE_INCOMPLETE_SOURCE = "workspace_incomplete";

export function checkWorkspaceIncomplete(store: Store): ValidatorOutput {
  const now = Date.now();
  const project = store.getProject();
  if (!project || isWorkspaceComplete(project)) return { fingerprints: new Set(), items: [] };

  // One fingerprint per project, not per missing engine — "no workspace
  // linked" is one fact, and a setup card already exists per engine (see
  // ensureWorkspaceSetupCards) for the actionable half of this.
  const fingerprint = `workspace_incomplete:${project.id}`;
  return {
    fingerprints: new Set([fingerprint]),
    items: [
      {
        id: newId("health"),
        severity: "blocker",
        source: WORKSPACE_INCOMPLETE_SOURCE,
        fingerprint,
        message:
          "No Unity or Blender workspace is linked yet — cards can't anchor to real files, and dispatched agents have nothing real to work against. See the Project page.",
        autoClose: true,
        resolved: false,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Broken anchor — a card's anchor points at a file the Asset Catalog no
// longer has. Cheap and synchronous: no subprocess, just the catalog
// already on disk.
// ---------------------------------------------------------------------------

export const BROKEN_ANCHOR_SOURCE = "broken_anchor";

/**
 * Only anchor kinds `anchorSource` maps to an engine are catalog-checkable
 * at all (a commit sha or a worktree path isn't "in" the Asset Catalog by
 * definition). Of those, `blenderObject` and `unityGameObject` name an
 * object *inside* a file the scanner doesn't index at that granularity —
 * checked at the file level only (does the .blend / the scene file still
 * exist), which is genuinely all the catalog can attest to either way.
 */
function catalogFileTarget(anchor: Anchor): { source: "unity" | "blender"; path: string } | undefined {
  switch (anchor.kind) {
    case "unityAsset":
    case "unityPrefab":
    case "script":
    case "scene":
      return { source: "unity", path: anchor.path };
    case "unityGameObject":
      return { source: "unity", path: anchor.scene };
    case "blenderObject":
      return { source: "blender", path: anchor.blendFile };
    default:
      return undefined;
  }
}

export function checkBrokenAnchors(store: Store): ValidatorOutput {
  const now = Date.now();
  const fingerprints = new Set<string>();
  const items: HealthItem[] = [];

  for (const card of store.listCards()) {
    if (!card.anchor || anchorSource(card) === undefined) continue;
    const target = catalogFileTarget(card.anchor);
    if (!target) continue;
    if (store.findWorkspaceAsset(target.source, target.path)) continue;

    const fingerprint = `${card.id}:${target.source}:${target.path}`;
    fingerprints.add(fingerprint);
    items.push({
      id: newId("health"),
      severity: "high",
      source: BROKEN_ANCHOR_SOURCE,
      fingerprint,
      message: `"${card.title}" is anchored to "${target.path}", which is no longer in the ${target.source} catalog.`,
      anchor: card.anchor,
      cardId: card.id,
      autoClose: true,
      resolved: false,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { fingerprints, items };
}

// ---------------------------------------------------------------------------
// Unity compile — a real batch-mode compile of the linked project, not a
// guess from reading a diff. Reuses the exact check dispatch.ts runs per
// job (unity/verify.ts), against the linked project directly rather than a
// worktree — there is no job here, just "does the project compile right now."
// ---------------------------------------------------------------------------

export const COMPILE_CHECK_SOURCE = "unity_compile";

/**
 * Silent (empty output, not an item) whenever the check plain can't run —
 * CLI integration not configured, no Unity binary found, no license, or a
 * timeout. Every one of those means "we don't know," and Part VIII's
 * caution about MCP unavailability applies just as much here: an unknown
 * is never reported as a failure.
 */
export async function checkUnityCompiles(store: Store): Promise<ValidatorOutput> {
  const now = Date.now();
  const fingerprints = new Set<string>();
  const items: HealthItem[] = [];

  const project = store.getProject();
  const unityIntegration = project?.engineIntegration?.unity;
  if (!unityIntegration || (unityIntegration.method !== "cli" && unityIntegration.method !== "both")) {
    return { fingerprints, items };
  }
  if (!project?.unityProjectPath) return { fingerprints, items };

  const unityBinary = findUnityBinary();
  if (!unityBinary) return { fingerprints, items };

  const result = await runUnityCompileCheck({ unityBinary, projectPath: project.unityProjectPath });
  if (result.timedOut || result.licenseFailed) return { fingerprints, items };

  for (const error of result.errors) {
    // The CS error text itself (file, line, code, message) is already a
    // stable, unique identity — no need to invent a separate key.
    fingerprints.add(error);
    items.push({
      id: newId("health"),
      severity: "blocker",
      source: COMPILE_CHECK_SOURCE,
      fingerprint: error,
      message: error,
      autoClose: true,
      resolved: false,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { fingerprints, items };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ValidatorRunResult {
  created: HealthItem[];
  closed: number;
}

export interface RunValidatorsOptions {
  /**
   * A real Unity compile is genuinely heavy — Part VIII's caution about a
   * scan becoming invisible load applies at least as much to a full
   * batch-mode compile as to a filesystem walk. Default true (a bare
   * `runValidators(store)` runs everything); the periodic scan scheduler
   * passes false and relies on `uassist validate` / a future dedicated,
   * longer-interval schedule for the compile check.
   */
  includeCompileCheck?: boolean;
}

export async function runValidators(store: Store, opts: RunValidatorsOptions = {}): Promise<ValidatorRunResult> {
  const created: HealthItem[] = [];
  let closed = 0;

  const incomplete = checkWorkspaceIncomplete(store);
  for (const item of incomplete.items) store.putHealthItem(item);
  created.push(...incomplete.items);
  closed += store.closeStaleHealthItems(WORKSPACE_INCOMPLETE_SOURCE, incomplete.fingerprints);

  const broken = checkBrokenAnchors(store);
  for (const item of broken.items) store.putHealthItem(item);
  created.push(...broken.items);
  closed += store.closeStaleHealthItems(BROKEN_ANCHOR_SOURCE, broken.fingerprints);

  if (opts.includeCompileCheck ?? true) {
    const compile = await checkUnityCompiles(store);
    for (const item of compile.items) store.putHealthItem(item);
    created.push(...compile.items);
    closed += store.closeStaleHealthItems(COMPILE_CHECK_SOURCE, compile.fingerprints);
  }

  return { created, closed };
}
