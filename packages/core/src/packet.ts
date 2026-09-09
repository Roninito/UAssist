/**
 * Context packet assembly — grounded via the Asset Catalog.
 *
 * design/workspace-spec.md Part IV specifies this concretely: resolve the
 * card's anchor through the catalog built in Phase 1.5 before assembling
 * `files`, rather than trusting the anchor's raw path string. This is what
 * "Agents will be tasked with performing real work" requires in practice —
 * the packet a dispatch sends is built from a file the catalog just
 * confirmed exists, not from what the card happens to say.
 *
 * See design/uassist-spec.md Part VIII.
 */

import type { Card, ContextPacket, Job } from "./types.ts";
import type { Store } from "./store.ts";
import { anchorPath } from "./types.ts";

export function anchorSource(card: Card): "unity" | "blender" | undefined {
  switch (card.anchor?.kind) {
    case "blenderObject":
      return "blender";
    case "unityAsset":
    case "unityGameObject":
    case "unityPrefab":
    case "script":
    case "scene":
      return "unity";
    default:
      return undefined;
  }
}

export interface AssemblePacketOptions {
  /** Extra instruction beyond the card's own title/description, e.g. from a
   *  human editing the packet before dispatch. */
  objectiveOverride?: string;
}

export function assembleContextPacket(
  store: Store,
  card: Card,
  options: AssemblePacketOptions = {},
): ContextPacket {
  const objective =
    options.objectiveOverride?.trim() ||
    [card.title, card.description].filter(Boolean).join("\n\n");

  const files: { path: string; reason: string }[] = [];
  let anchorState: Record<string, unknown> = {};

  if (card.anchor) {
    const source = anchorSource(card);
    const path = anchorPath(card.anchor);

    // Resolve through the catalog rather than trusting the anchor string —
    // the whole point of Phase 1.5. An anchor that does not resolve is still
    // included (the agent should know what was intended) but flagged, not
    // silently swapped for nothing.
    const resolved = source ? store.findWorkspaceAsset(source, path) : undefined;

    if (resolved) {
      files.push({ path: resolved.path, reason: `card anchor (${card.anchor.kind}, confirmed in catalog)` });
      anchorState = {
        kind: card.anchor.kind,
        path: resolved.path,
        assetKind: resolved.kind,
        sizeBytes: resolved.sizeBytes,
        classNames: resolved.classNames,
        resolved: true,
      };
    } else {
      files.push({ path, reason: `card anchor (${card.anchor.kind}, NOT found in the Asset Catalog — verify before relying on it)` });
      anchorState = { kind: card.anchor.kind, path, resolved: false };
    }
  }

  const priorJobs = store
    .listJobsForCard(card.id)
    .map((j: Job) => ({ id: j.id, outcome: j.state }));

  const project = store.getProject();

  return {
    objective,
    anchor: card.anchor,
    anchorState,
    files,
    conventions: project?.conventions ?? [],
    priorJobs,
    acceptance: card.acceptance.map((a) => a.text),
    constraints: [],
  };
}
