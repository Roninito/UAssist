/**
 * Workspace validation and Asset Catalog scanning.
 *
 * A heuristic classifier, not a Unity/Blender parser — proportionate to what
 * the catalog needs (search, anchor resolution, existence checks), not a
 * substitute for the live in-editor plugins specified for Phase 5.
 *
 * See design/workspace-spec.md Part III.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { AssetKindGuess, ScanResult, WorkspaceAsset, WorkspaceLinkStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Catches linking the application itself instead of a project directory —
 * a real, observed mistake: `/Applications/Blender.app` validated as a
 * "linked" Blender workspace because Blender ships its own startup/template
 * `.blend` files inside the bundle (Contents/Resources/.../datafiles/), and
 * scanning it then catalogued the app's entire bundled Python runtime —
 * thousands of unrelated `.so`/`.py` files — as unaccounted-for assets, one
 * `create_card` suggestion each. `.app` is a reserved, unambiguous suffix
 * on macOS; `Contents/Info.plist` is the second, OS-independent signal for
 * the rare case a bundle got renamed without its extension.
 */
function looksLikeAppBundle(path: string): boolean {
  if (/\.app\/?$/i.test(path)) return true;
  return existsSync(join(path, "Contents", "Info.plist"));
}

/** A real Unity project has both of these at its root; a random folder does not. */
export function validateUnityPath(path: string): WorkspaceLinkStatus {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { path, valid: false, reason: "path does not exist or is not a directory" };
  }
  if (looksLikeAppBundle(path)) {
    return { path, valid: false, reason: "this looks like an application bundle, not a project directory" };
  }
  const hasAssets = existsSync(join(path, "Assets"));
  const hasSettings = existsSync(join(path, "ProjectSettings"));
  if (!hasAssets || !hasSettings) {
    return {
      path,
      valid: false,
      reason: hasAssets
        ? "missing ProjectSettings/ — not a Unity project root"
        : "missing Assets/ — not a Unity project root",
    };
  }
  return { path, valid: true };
}

/** Blender has no fixed project layout; a workspace counts once one .blend exists under it. */
export function validateBlenderPath(path: string): WorkspaceLinkStatus {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { path, valid: false, reason: "path does not exist or is not a directory" };
  }
  if (looksLikeAppBundle(path)) {
    return { path, valid: false, reason: "this looks like an application bundle, not a project directory" };
  }
  const found = findFirst(path, (name) => name.endsWith(".blend"));
  if (!found) {
    return { path, valid: false, reason: "no .blend files found under this path" };
  }
  return { path, valid: true };
}

function findFirst(root: string, match: (name: string) => boolean): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (shouldSkipDir(name)) continue;
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (match(name)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ignore rules — shared with the file-watching fallback (uassist-spec.md Part VII)
// ---------------------------------------------------------------------------

const ALWAYS_SKIP_DIRS = new Set([
  "Library",
  "Temp",
  "obj",
  ".git",
  "Logs",
  "UserSettings",
  "node_modules",
  // Defense in depth alongside looksLikeAppBundle: even a legitimately
  // linked directory should never have an embedded language runtime's
  // internals treated as game/art assets, on the off chance one ended up
  // vendored somewhere under it.
  "Contents", // macOS .app bundle internals
  "site-packages",
  "lib-dynload",
  "__pycache__",
]);

function shouldSkipDir(name: string): boolean {
  return ALWAYS_SKIP_DIRS.has(name) || name.startsWith(".");
}

/**
 * Minimal .uassistignore: one pattern per line, blank lines and `#` comments
 * skipped. A pattern with no "/" matches any path segment by exact name (the
 * common .gitignore case); a pattern with "/" matches as a relative-path
 * prefix, interpreted relative to the *scan* root (e.g. `Assets/` for Unity),
 * not necessarily where the file itself lives — see `findIgnoreFile`. Not
 * full gitignore semantics — a small, legible subset is enough for excluding
 * a generated folder or two.
 */
function loadIgnorePatterns(ignoreFilePath: string): { names: Set<string>; prefixes: string[] } {
  const names = new Set<string>();
  const prefixes: string[] = [];
  if (!existsSync(ignoreFilePath)) return { names, prefixes };
  for (const raw of readFileSync(ignoreFilePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.includes("/")) prefixes.push(line.replace(/\/+$/, ""));
    else names.add(line);
  }
  return { names, prefixes };
}

function isIgnored(
  relPath: string,
  baseName: string,
  ignore: { names: Set<string>; prefixes: string[] },
): boolean {
  if (ignore.names.has(baseName)) return true;
  return ignore.prefixes.some((p) => relPath === p || relPath.startsWith(p + "/"));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const EXTENSION_KIND: Record<string, AssetKindGuess> = {
  ".cs": "script",
  ".prefab": "prefab",
  ".unity": "scene",
  ".mat": "material",
  ".asset": "scriptableObject",
  ".fbx": "mesh",
  ".obj": "mesh",
  ".dae": "mesh",
  ".png": "texture",
  ".jpg": "texture",
  ".jpeg": "texture",
  ".tga": "texture",
  ".psd": "texture",
  ".tif": "texture",
  ".tiff": "texture",
  ".exr": "texture",
  ".wav": "audio",
  ".mp3": "audio",
  ".ogg": "audio",
  ".aiff": "audio",
  ".anim": "animation",
  ".controller": "animation",
  ".overridecontroller": "animation",
  ".blend": "blend",
};

function classify(path: string): AssetKindGuess {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "other";
  const ext = path.slice(dot).toLowerCase();
  return EXTENSION_KIND[ext] ?? "other";
}

const CLASS_NAME_RE = /\b(?:class|struct)\s+(\w+)/g;

function extractClassNames(content: string): string[] | undefined {
  const names = new Set<string>();
  for (const match of content.matchAll(CLASS_NAME_RE)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names.size > 0 ? [...names] : undefined;
}

function hashMeta(sizeBytes: number, mtimeMs: number, path: string): string {
  return Bun.hash(`${path}:${sizeBytes}:${mtimeMs}`).toString(16);
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Walk `root`, yielding one WorkspaceAsset per file. Directories are pruned
 * before descending, so a huge Library/ never gets touched — this is a
 * synchronous walk (not readdir's `recursive` option) specifically so pruning
 * can happen before descent rather than after a full traversal.
 *
 * `ignoreFileRoot` is where `.uassistignore` is read from — for a Unity
 * project this is the project root (next to `ProjectSettings/`), not `root`
 * itself (which is `Assets/`), so the file sits where a person actually
 * expects project-level config to live. Its patterns are still interpreted
 * relative to `root`, the scan root, which is what a person writing "ignore
 * Scripts/Generated" means regardless of where the file lives.
 */
function walk(
  root: string,
  ignoreFileRoot: string,
  source: WorkspaceAsset["source"],
  warnings: string[],
): WorkspaceAsset[] {
  const ignore = loadIgnorePatterns(join(ignoreFileRoot, ".uassistignore"));
  const assets: WorkspaceAsset[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      warnings.push(`could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const name of entries) {
      const full = join(dir, name);
      const relPath = relative(root, full);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue; // a file that vanished between readdir and stat — ignore
      }

      if (stat.isDirectory()) {
        if (shouldSkipDir(name) || isIgnored(relPath, name, ignore)) continue;
        stack.push(full);
        continue;
      }

      if (!stat.isFile()) continue;
      if (isIgnored(relPath, name, ignore)) continue;
      if (name.endsWith(".meta")) continue; // Unity's per-asset metadata sidecar, not an asset itself

      const kind = classify(name);
      let classNames: string[] | undefined;
      let hash: string;

      if (kind === "script") {
        try {
          const content = readFileSync(full, "utf8");
          classNames = extractClassNames(content);
          hash = Bun.hash(content).toString(16);
        } catch (err) {
          warnings.push(`could not read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
          hash = hashMeta(stat.size, stat.mtimeMs, relPath);
        }
      } else {
        hash = hashMeta(stat.size, stat.mtimeMs, relPath);
      }

      assets.push({
        path: relPath.split("\\").join("/"), // stable forward-slash form on any OS
        source,
        kind,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        classNames,
        hash,
      });
    }
  }

  return assets;
}

export function scanUnityAssets(unityProjectPath: string): ScanResult {
  const started = performance.now();
  const warnings: string[] = [];
  const assetsRoot = join(unityProjectPath, "Assets");
  const assets = existsSync(assetsRoot)
    ? walk(assetsRoot, unityProjectPath, "unity", warnings)
    : [];
  return { assets, durationMs: performance.now() - started, warnings };
}

export function scanBlenderAssets(blenderSourcePath: string): ScanResult {
  const started = performance.now();
  const warnings: string[] = [];
  const assets = walk(blenderSourcePath, blenderSourcePath, "blender", warnings);
  return { assets, durationMs: performance.now() - started, warnings };
}
