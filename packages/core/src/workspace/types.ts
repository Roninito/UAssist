/**
 * Workspace and Asset Catalog types.
 *
 * See design/workspace-spec.md Part III.
 */

export const ASSET_KIND_GUESSES = [
  "script",
  "prefab",
  "scene",
  "material",
  "scriptableObject",
  "mesh",
  "texture",
  "audio",
  "animation",
  "blend",
  "other",
] as const;
export type AssetKindGuess = (typeof ASSET_KIND_GUESSES)[number];

export type WorkspaceSource = "unity" | "blender";

export interface WorkspaceAsset {
  /** Relative to the workspace root (Unity project root, or Blender source root). */
  path: string;
  source: WorkspaceSource;
  kind: AssetKindGuess;
  sizeBytes: number;
  mtimeMs: number;
  /** For .cs files: class/struct names found by a light regex scan. */
  classNames?: string[];
  hash: string;
}

export interface WorkspaceLinkStatus {
  path: string;
  valid: boolean;
  reason?: string;
}

export interface WorkspaceStatus {
  unity?: WorkspaceLinkStatus;
  blender?: WorkspaceLinkStatus;
  lastScannedAt?: number;
  assetCounts: Partial<Record<AssetKindGuess, number>>;
  totalAssets: number;
  /** True once at least one engine is validly linked — see
   *  design/automation-spec.md Part I. Not derived here (that would create a
   *  circular dependency on bootstrap.ts); callers set it from
   *  isWorkspaceComplete(project). */
  complete: boolean;
}

export interface ScanResult {
  assets: WorkspaceAsset[];
  durationMs: number;
  warnings: string[];
}
