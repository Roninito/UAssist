/**
 * Periodic scanning, catalog diffing, and the Decisions queue.
 *
 * `scanAndReconcile` is meant to be the *only* place a workspace scan runs
 * from — see design/automation-spec.md Parts III–IV. It scans one engine's
 * workspace, diffs the result against the catalog already on disk (the
 * "before" snapshot, read before the catalog is replaced), replaces the
 * catalog, and turns the diff into Suggestions. It never writes a card or an
 * anchor directly — that is Part VIII's rule ("propose, never apply"), and
 * the reason this module calls `store.proposeSuggestion` and nothing else
 * that mutates the board.
 *
 * What gets proposed, and why:
 *  - A removed asset whose path exactly matches an anchored card's anchor,
 *    paired with a newly added asset that looks like the same thing by
 *    title, reads as a rename: propose `attach_anchor` pointing the existing
 *    anchor at the new path (Pass 1).
 *  - Any other newly added asset that looks like the target an anchor-less
 *    card was describing: propose `attach_anchor` for that card (Pass 2).
 *  - A newly added asset that matches nothing on the board: propose
 *    `create_card`, so the board never silently falls behind the workspace.
 *  - A changed-but-not-moved asset (same path, different hash) whose path
 *    matches an anchored, not-yet-done card: propose `update_card_status`
 *    moving it to "review" — Part III's own words are "worth a look," never
 *    "mark this done," so this only ever targets "review," and only for
 *    cards not already there or further along (Pass 3).
 *  - An outright removal with no plausible rename target produces no
 *    suggestion today — that is a health-item concern (a broken anchor),
 *    not a Decisions-queue one. Still reported in the returned diff for
 *    callers that want to show it.
 *
 * One backstop above all of that: a scan whose `added` count is wildly out
 * of proportion for a real workspace almost always means the wrong path is
 * linked, not that hundreds of real new assets appeared at once — a real
 * incident (see `SUSPICIOUS_SCAN_SOURCE`'s own doc comment) linked an
 * `.app` bundle and produced 5,500+ individual create_card suggestions
 * for the bundle's own Python runtime. That case is now also caught
 * earlier and more precisely by `validateBlenderPath`/`validateUnityPath`
 * rejecting anything that looks like an application bundle before a scan
 * ever runs — this is the general safety net for whatever that doesn't
 * anticipate.
 */

import { newId } from "./ids.ts";
import type { CardId } from "./ids.ts";
import type { Store } from "./store.ts";
import { anchorSource } from "./packet.ts";
import { titleSimilarity } from "./plan/sourceKey.ts";
import { scanBlenderAssets, scanUnityAssets } from "./workspace/scan.ts";
import type { WorkspaceAssetLike } from "./db/rows.ts";
import type { AssetKindGuess, WorkspaceSource } from "./workspace/types.ts";
import { anchorPath, newCardDefaults } from "./types.ts";
import type {
  Anchor,
  AttachAnchorPayload,
  Card,
  Category,
  CreateCardPayload,
  HealthItem,
  Suggestion,
  UpdateCardStatusPayload,
} from "./types.ts";

export interface CatalogDiff {
  source: WorkspaceSource;
  /** Present in the new scan, absent from the previous catalog. */
  added: WorkspaceAssetLike[];
  /** Present in the previous catalog, absent from the new scan. */
  removed: WorkspaceAssetLike[];
  /** Same path in both, different hash. No suggestion is generated for these today. */
  changed: WorkspaceAssetLike[];
}

export interface ReconcileResult {
  assets: WorkspaceAssetLike[];
  durationMs: number;
  warnings: string[];
  diff: CatalogDiff;
  /** Suggestions actually inserted — excludes anything proposeSuggestion deduped away. */
  proposed: Suggestion[];
  /** True when `added` was too large to trust — see SUSPICIOUS_SCAN_SOURCE. Nothing was proposed. */
  suspicious: boolean;
}

/**
 * A real incident: `/Applications/Blender.app` validated as a linkable
 * Blender workspace (it ships its own startup `.blend` files internally),
 * and scanning it catalogued the app's bundled Python runtime — thousands
 * of `.so`/`.py` files — as unaccounted-for assets, one `create_card`
 * suggestion each. `validateBlenderPath`/`validateUnityPath` now reject an
 * application bundle outright before a scan ever runs; this constant is
 * the source id for the backstop below, in case some other pathological
 * path gets linked that those checks don't anticipate.
 */
export const SUSPICIOUS_SCAN_SOURCE = "suspicious_scan";

/**
 * A real workspace's normal churn is a handful to a few dozen new files
 * per scan. Comfortably above that, well below what a wrong-path incident
 * actually produces (thousands) — chosen to never trip on a legitimate
 * "just imported a big asset pack" scan.
 */
const SUSPICIOUS_ADDED_THRESHOLD = 200;

/** Scan one engine's workspace, replace its catalog, and reconcile the change into Suggestions. */
export function scanAndReconcile(
  store: Store,
  source: WorkspaceSource,
  path: string,
): ReconcileResult {
  const before = store.listWorkspaceAssets(source);
  const { assets, durationMs, warnings } =
    source === "unity" ? scanUnityAssets(path) : scanBlenderAssets(path);
  store.replaceWorkspaceAssets(source, assets);

  const diff = diffCatalog(source, before, assets);

  // Per-engine source id, not a shared one with the engine only in the
  // fingerprint: closeStaleHealthItems below operates per source, so a
  // clean Unity scan must never be able to clear a still-legitimate
  // Blender flag (or vice versa) just because they'd otherwise share one.
  const suspiciousSource = `${SUSPICIOUS_SCAN_SOURCE}_${source}`;
  const suspicious = diff.added.length > SUSPICIOUS_ADDED_THRESHOLD;
  if (suspicious) {
    store.putHealthItem({
      id: newId("health"),
      severity: "blocker",
      source: suspiciousSource,
      fingerprint: suspiciousSource,
      message:
        `The last ${source} scan found ${diff.added.length} unaccounted-for files — far more than a normal scan. ` +
        `This almost always means the wrong path is linked (an application bundle, a build output folder, a whole ` +
        `drive). Nothing was proposed from this scan. Check the ${source === "unity" ? "Unity" : "Blender"} path ` +
        `on the Project page before scanning again.`,
      autoClose: true,
      resolved: false,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    } satisfies HealthItem);
  } else {
    // A clean scan clears any earlier flag for this engine — the same
    // auto-close mechanism validate.ts's own checks use.
    store.closeStaleHealthItems(suspiciousSource, new Set());
  }

  const proposed = suspicious ? [] : reconcileDiff(store, source, diff);

  return { assets, durationMs, warnings, diff, proposed, suspicious };
}

function diffCatalog(
  source: WorkspaceSource,
  before: WorkspaceAssetLike[],
  after: WorkspaceAssetLike[],
): CatalogDiff {
  const beforeByPath = new Map(before.map((a) => [a.path, a]));
  const afterByPath = new Map(after.map((a) => [a.path, a]));

  const added: WorkspaceAssetLike[] = [];
  const changed: WorkspaceAssetLike[] = [];
  for (const [path, a] of afterByPath) {
    const b = beforeByPath.get(path);
    if (!b) added.push(a);
    else if (b.hash !== a.hash) changed.push(a);
  }

  const removed: WorkspaceAssetLike[] = [];
  for (const [path, b] of beforeByPath) {
    if (!afterByPath.has(path)) removed.push(b);
  }

  return { source, added, removed, changed };
}

// A tolerant match ("probably the same thing") needs a lower bar than a
// rename match ("this specific file became that specific file") — a rename
// candidate competes only against other files that also just appeared,
// while an anchor-less card's title is a much looser description to begin
// with, so demanding less avoids the queue going silent on real matches.
const RENAME_MATCH_THRESHOLD = 0.6;
const ANCHORLESS_MATCH_THRESHOLD = 0.5;

function reconcileDiff(store: Store, source: WorkspaceSource, diff: CatalogDiff): Suggestion[] {
  const proposed: Suggestion[] = [];
  const consumedAddedPaths = new Set<string>();
  const consumedCardIds = new Set<CardId>();

  const cards = store.listCards();

  // Pass 1 — rename detection: a card anchored to something that just
  // disappeared, paired against this same scan's newly added assets.
  for (const removedAsset of diff.removed) {
    const anchoredCard = cards.find(
      (c) =>
        c.anchor !== undefined &&
        anchorSource(c) === source &&
        anchorPath(c.anchor) === removedAsset.path,
    );
    if (!anchoredCard || consumedCardIds.has(anchoredCard.id)) continue;

    const removedStem = basenameStem(removedAsset.path);
    let best: { asset: WorkspaceAssetLike; score: number } | undefined;
    for (const addedAsset of diff.added) {
      if (consumedAddedPaths.has(addedAsset.path)) continue;
      const score = titleSimilarity(removedStem, basenameStem(addedAsset.path));
      if (score >= RENAME_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { asset: addedAsset, score };
      }
    }
    if (!best) continue;

    const anchor = anchorForAsset(source, best.asset);
    const suggestion = store.proposeSuggestion({
      kind: "attach_anchor",
      source: "reconciliation",
      rationale: `"${removedAsset.path}" disappeared and "${best.asset.path}" looks like the same thing — probably a rename.`,
      payload: { cardId: anchoredCard.id, anchor } satisfies AttachAnchorPayload,
      fingerprint: attachAnchorFingerprint(anchoredCard.id, anchor),
      relatedCardId: anchoredCard.id,
    });
    if (suggestion) proposed.push(suggestion);
    consumedAddedPaths.add(best.asset.path);
    consumedCardIds.add(anchoredCard.id);
  }

  // Pass 2 — remaining new assets: match an anchor-less card by title, else
  // propose a brand new card so the board doesn't fall behind the workspace.
  const anchorlessCards = cards.filter((c) => c.anchor === undefined);
  for (const addedAsset of diff.added) {
    if (consumedAddedPaths.has(addedAsset.path)) continue;

    const stem = basenameStem(addedAsset.path);
    let best: { card: Card; score: number } | undefined;
    for (const card of anchorlessCards) {
      if (consumedCardIds.has(card.id)) continue;
      const score = titleSimilarity(card.title, stem);
      if (score >= ANCHORLESS_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { card, score };
      }
    }

    const anchor = anchorForAsset(source, addedAsset);
    if (best) {
      const suggestion = store.proposeSuggestion({
        kind: "attach_anchor",
        source: "reconciliation",
        rationale: `"${addedAsset.path}" looks like the target for "${best.card.title}".`,
        payload: { cardId: best.card.id, anchor } satisfies AttachAnchorPayload,
        fingerprint: attachAnchorFingerprint(best.card.id, anchor),
        relatedCardId: best.card.id,
      });
      if (suggestion) proposed.push(suggestion);
      consumedCardIds.add(best.card.id);
    } else {
      const suggestion = store.proposeSuggestion({
        kind: "create_card",
        source: "reconciliation",
        rationale: `"${addedAsset.path}" appeared in the workspace with nothing on the board to account for it.`,
        payload: {
          title: prettifyBasename(addedAsset.path),
          category: guessCategory(addedAsset.kind),
          anchor,
        } satisfies CreateCardPayload,
        fingerprint: createCardFingerprint(source, addedAsset.path),
      });
      if (suggestion) proposed.push(suggestion);
    }
  }

  // Pass 3 — a changed (not moved) asset whose anchor a not-yet-reviewed
  // card already owns: worth a look, per Part III's own wording. Never
  // targets "done" — see UpdateCardStatusPayload's doc comment.
  const STATUSES_WORTH_NUDGING = new Set(["open", "active"]);
  for (const changedAsset of diff.changed) {
    const anchoredCard = cards.find(
      (c) =>
        c.anchor !== undefined &&
        anchorSource(c) === source &&
        anchorPath(c.anchor) === changedAsset.path,
    );
    if (!anchoredCard || !STATUSES_WORTH_NUDGING.has(anchoredCard.status)) continue;

    const suggestion = store.proposeSuggestion({
      kind: "update_card_status",
      source: "reconciliation",
      rationale: `"${changedAsset.path}" changed since "${anchoredCard.title}" was last touched — worth a look.`,
      payload: { cardId: anchoredCard.id, toStatus: "review" } satisfies UpdateCardStatusPayload,
      fingerprint: updateCardStatusFingerprint(anchoredCard.id, changedAsset.hash),
      relatedCardId: anchoredCard.id,
    });
    if (suggestion) proposed.push(suggestion);
  }

  return proposed;
}

function basenameStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** "enemy_grunt_v2" / "enemyGruntV2" → "Enemy grunt V2" — a starting point, not a final title. */
function prettifyBasename(path: string): string {
  const stem = basenameStem(path);
  const spaced = stem
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced.length === 0) return stem;
  return spaced[0]!.toUpperCase() + spaced.slice(1);
}

// Best-effort only — the human reviewing the suggestion can always correct
// the category; "Unknown" is the honest answer when the file extension alone
// doesn't say enough.
const KIND_CATEGORY: Partial<Record<AssetKindGuess, Category>> = {
  audio: "Audio",
  texture: "Art",
  material: "Art",
  mesh: "Art",
  animation: "Art",
  blend: "Art",
  script: "Systems",
  scriptableObject: "Systems",
};

function guessCategory(kind: string): Category {
  return KIND_CATEGORY[kind as AssetKindGuess] ?? "Unknown";
}

/**
 * Blender assets carry no object-level detail from the scanner (only the
 * .blend file itself is catalogued — see workspace/scan.ts), so the anchor
 * is a plain file anchor there. Unity's kind guess maps onto the richer
 * anchor vocabulary where one exists.
 */
function anchorForAsset(source: WorkspaceSource, asset: WorkspaceAssetLike): Anchor {
  if (source === "blender") return { kind: "asset", path: asset.path };
  switch (asset.kind as AssetKindGuess) {
    case "script":
      return { kind: "script", path: asset.path };
    case "prefab":
      return { kind: "unityPrefab", path: asset.path };
    case "scene":
      return { kind: "scene", path: asset.path };
    default:
      return { kind: "unityAsset", path: asset.path };
  }
}

function createCardFingerprint(source: WorkspaceSource, path: string): string {
  return `create_card:${source}:${path}`;
}

function attachAnchorFingerprint(cardId: CardId, anchor: Anchor): string {
  return `attach_anchor:${cardId}:${anchorPath(anchor)}`;
}

/** Keyed on the asset's new hash: a further edit after this is rejected is a
 *  genuinely new fact (a different hash), so it gets a fresh fingerprint
 *  rather than staying suppressed by the earlier rejection. */
function updateCardStatusFingerprint(cardId: CardId, hash: string): string {
  return `update_card_status:${cardId}:${hash}`;
}

// ---------------------------------------------------------------------------
// Applying an accepted suggestion — the other half of "propose, never apply."
//
// Nothing above this line writes a card. This is the one place that does,
// and it only runs when a human has already said yes: the caller (the
// server's accept route, or a future CLI equivalent) is expected to call
// this *instead of* `store.decideSuggestion` directly, then mark the
// suggestion decided only once the write actually lands — see
// design/automation-spec.md Part IV.
// ---------------------------------------------------------------------------

export class ApplySuggestionError extends Error {}

export interface ApplySuggestionResult {
  cardId: CardId;
  /** true for create_card (a new card was made); false for attach_anchor (an existing card was updated). */
  created: boolean;
}

export function applySuggestion(store: Store, suggestion: Suggestion): ApplySuggestionResult {
  switch (suggestion.kind) {
    case "create_card": {
      const payload = suggestion.payload as unknown as CreateCardPayload;
      const now = Date.now();
      const card: Card = {
        ...newCardDefaults(now),
        id: newId("card"),
        title: payload.title,
        category: payload.category,
        anchor: payload.anchor,
      };
      store.putCard(card);
      return { cardId: card.id, created: true };
    }
    case "attach_anchor": {
      const payload = suggestion.payload as unknown as AttachAnchorPayload;
      const card = store.getCard(payload.cardId);
      if (!card) {
        throw new ApplySuggestionError(
          `attach_anchor suggestion references card ${payload.cardId}, which no longer exists`,
        );
      }
      store.putCard({ ...card, anchor: payload.anchor });
      return { cardId: card.id, created: false };
    }
    case "update_card_status": {
      const payload = suggestion.payload as unknown as UpdateCardStatusPayload;
      const card = store.getCard(payload.cardId);
      if (!card) {
        throw new ApplySuggestionError(
          `update_card_status suggestion references card ${payload.cardId}, which no longer exists`,
        );
      }
      store.putCard({ ...card, status: payload.toStatus });
      return { cardId: card.id, created: false };
    }
    case "dispatch":
    case "close_health_item":
      // Specified in SUGGESTION_KINDS, produced by nothing yet — see the
      // doc comment on that const in types.ts.
      throw new ApplySuggestionError(`accepting a "${suggestion.kind}" suggestion is not implemented yet`);
  }
}
