/**
 * Asset Tracker — read-only aggregation over the workspace Asset Catalog,
 * card anchors, and health items.
 *
 * No new persistence here. The workspace scan already populates
 * workspace_assets; this module joins it with cards and health to answer
 * coverage, ownership, and validation questions.
 *
 * See README.md "Asset Tracker Dashboards" discussion.
 */

import { type Anchor, type Card, type HealthItem } from "@uassist/core";
import type { WorkspaceAssetLike } from "@uassist/core/db/rows";
import type { Ctx } from "./api.ts";
import { fail, json } from "./api.ts";

export interface AssetWithRelations {
  asset: WorkspaceAssetLike;
  cards: Card[];
  health: HealthItem[];
}

export interface AssetSummary {
  totalAssets: number;
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  /** Assets that have no card anchored to them. */
  uncoveredCount: number;
  /** Cards with an asset anchor whose path is not in the catalog. */
  orphanedCardCount: number;
  /** Open health items tied to an asset. */
  openHealthCount: number;
  lastScannedAt?: number;
}

function anchorPath(anchor: Anchor): string | undefined {
  switch (anchor.kind) {
    case "asset":
    case "unityAsset":
    case "unityPrefab":
    case "script":
    case "scene":
    case "worktree":
      return anchor.path;
    case "blenderObject":
      return anchor.blendFile;
    case "unityGameObject":
      return anchor.scene;
    case "dataTable":
      return anchor.path;
    default:
      return undefined;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/|\/$/g, "");
}

function matchesAnchor(asset: WorkspaceAssetLike, anchor: Anchor): boolean {
  const assetPath = normalizePath(asset.path);
  const maybePath = anchorPath(anchor);
  if (!maybePath) return false;
  const anchorPathNorm = normalizePath(maybePath);
  return assetPath === anchorPathNorm || anchorPathNorm.endsWith(assetPath) || assetPath.endsWith(anchorPathNorm);
}

function buildAssetIndex(ctx: Ctx): Map<string, AssetWithRelations> {
  const cards = ctx.store.listCards();
  const healthItems = ctx.store.listHealthItems();
  const allAssets: WorkspaceAssetLike[] = [];
  for (const source of ["unity", "blender"] as const) {
    allAssets.push(...ctx.store.listWorkspaceAssets(source));
  }

  const index = new Map<string, AssetWithRelations>();
  for (const asset of allAssets) {
    index.set(assetKey(asset), { asset, cards: [], health: [] });
  }

  for (const card of cards) {
    if (!card.anchor) continue;
    for (const entry of index.values()) {
      if (matchesAnchor(entry.asset, card.anchor)) {
        entry.cards.push(card);
      }
    }
  }

  for (const item of healthItems) {
    if (!item.anchor) continue;
    for (const entry of index.values()) {
      if (matchesAnchor(entry.asset, item.anchor)) {
        entry.health.push(item);
      }
    }
  }

  return index;
}

function assetKey(asset: WorkspaceAssetLike): string {
  return `${asset.source}:${asset.path}`;
}

function parseAssetKey(raw: string): { source: "unity" | "blender"; path: string } | undefined {
  const [source, ...rest] = raw.split(":");
  if (source !== "unity" && source !== "blender") return undefined;
  const path = rest.join(":");
  if (!path) return undefined;
  return { source, path };
}

export function listAssets(ctx: Ctx, req: Request): Response {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? undefined;
  const kind = url.searchParams.get("kind") ?? undefined;
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const uncoveredOnly = url.searchParams.get("uncovered") === "1";
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 1000;

  const index = buildAssetIndex(ctx);
  let items = Array.from(index.values());

  if (source) items = items.filter((i) => i.asset.source === source);
  if (kind) items = items.filter((i) => i.asset.kind === kind);
  if (q) items = items.filter((i) => i.asset.path.toLowerCase().includes(q));
  if (uncoveredOnly) items = items.filter((i) => i.cards.length === 0);

  items = items.slice(0, limit);

  return json({
    assets: items.map((i) => ({
      source: i.asset.source,
      path: i.asset.path,
      kind: i.asset.kind,
      sizeBytes: i.asset.sizeBytes,
      mtimeMs: i.asset.mtimeMs,
      classNames: i.asset.classNames,
      cardCount: i.cards.length,
      openHealthCount: i.health.filter((h) => !h.resolved).length,
    })),
    seq: ctx.store.lastSeq,
  });
}

export function getAssetSummary(ctx: Ctx): Response {
  const index = buildAssetIndex(ctx);
  const items = Array.from(index.values());

  const bySource: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const i of items) {
    bySource[i.asset.source] = (bySource[i.asset.source] ?? 0) + 1;
    byKind[i.asset.kind] = (byKind[i.asset.kind] ?? 0) + 1;
  }

  const uncoveredCount = items.filter((i) => i.cards.length === 0).length;
  const openHealthCount = items.reduce((sum, i) => sum + i.health.filter((h) => !h.resolved).length, 0);

  // Orphaned cards: cards with an asset anchor not matching any catalog asset.
  const cards = ctx.store.listCards();
  let orphanedCardCount = 0;
  for (const card of cards) {
    if (!card.anchor || !anchorPath(card.anchor)) continue;
    const found = items.some((i) => matchesAnchor(i.asset, card.anchor as Anchor));
    if (!found) orphanedCardCount++;
  }

  const project = ctx.store.getProject();
  const lastScannedAt = project?.workspaceScannedAt;

  const summary: AssetSummary = {
    totalAssets: items.length,
    bySource,
    byKind,
    uncoveredCount,
    orphanedCardCount,
    openHealthCount,
    lastScannedAt,
  };

  return json({ summary, seq: ctx.store.lastSeq });
}

export function getAssetDetail(ctx: Ctx, rawKey: string): Response {
  const parsed = parseAssetKey(decodeURIComponent(rawKey));
  if (!parsed) return fail(400, "invalid asset key");

  const asset = ctx.store.findWorkspaceAsset(parsed.source, parsed.path);
  if (!asset) return fail(404, "asset not found");

  const index = buildAssetIndex(ctx);
  const entry = index.get(assetKey(asset)) ?? { asset, cards: [], health: [] };

  // Related assets: same directory, same source, excluding self.
  const dir = asset.path.includes("/") ? asset.path.slice(0, asset.path.lastIndexOf("/")) : "";
  const related: { source: string; path: string; kind: string }[] = [];
  for (const i of index.values()) {
    if (i.asset.source !== asset.source || i.asset.path === asset.path) continue;
    const otherDir = i.asset.path.includes("/") ? i.asset.path.slice(0, i.asset.path.lastIndexOf("/")) : "";
    if (otherDir === dir) {
      related.push({ source: i.asset.source, path: i.asset.path, kind: i.asset.kind });
    }
  }

  return json({
    asset: {
      source: asset.source,
      path: asset.path,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      mtimeMs: asset.mtimeMs,
      classNames: asset.classNames,
      hash: asset.hash,
    },
    cards: entry.cards.map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority })),
    health: entry.health.map((h) => ({ id: h.id, severity: h.severity, message: h.message, resolved: h.resolved })),
    related,
    seq: ctx.store.lastSeq,
  });
}
