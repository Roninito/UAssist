/**
 * Workspace, Asset Catalog, and Registry handlers.
 *
 * See design/workspace-spec.md Parts II, III, VI.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ASSET_KIND_GUESSES,
  ENGINE_INTEGRATION_METHODS,
  isWorkspaceComplete,
  listRegisteredProjects,
  scanAndReconcile,
  validateBlenderPath,
  validateUnityPath,
  type AssetKindGuess,
  type EngineIntegrationConfig,
  type EngineMethodConfig,
  type Project,
  type WorkspaceStatus,
} from "@uassist/core";
import { probeInstance, type Instance } from "./instance.ts";
import { ServerBinaryNotFoundError, spawnServer } from "./spawn.ts";
import { fail, json, oneOf, type Ctx } from "./api.ts";

// ---------------------------------------------------------------------------
// PATCH /api/project — set/clear the workspace links
// ---------------------------------------------------------------------------

interface ProjectPatch {
  name?: string;
  unityProjectPath?: string | null;
  blenderSourcePath?: string | null;
  /** null clears engine integration entirely, back to CLI-only default. */
  engineIntegration?: EngineIntegrationConfig | null;
}

function parseEngineMethodConfig(value: unknown, engineName: string): EngineMethodConfig | { error: string } {
  if (typeof value !== "object" || value === null) {
    return { error: `engineIntegration.${engineName} must be an object` };
  }
  const b = value as Record<string, unknown>;
  const method = oneOf(b["method"], ENGINE_INTEGRATION_METHODS);
  if (!method) {
    return { error: `engineIntegration.${engineName}.method must be one of: ${ENGINE_INTEGRATION_METHODS.join(", ")}` };
  }
  if ((method === "mcp" || method === "both") && typeof b["mcpServerUrl"] !== "string") {
    return { error: `engineIntegration.${engineName}.mcpServerUrl is required when method is "${method}"` };
  }
  const mcpServerUrl = b["mcpServerUrl"];
  if (mcpServerUrl !== undefined && typeof mcpServerUrl !== "string") {
    return { error: `engineIntegration.${engineName}.mcpServerUrl must be a string` };
  }
  return { method, mcpServerUrl: mcpServerUrl as string | undefined };
}

function parseEngineIntegration(value: unknown): EngineIntegrationConfig | { error: string } {
  if (typeof value !== "object" || value === null) return { error: "engineIntegration must be an object" };
  const b = value as Record<string, unknown>;
  const config: EngineIntegrationConfig = {};

  if (b["unity"] !== undefined) {
    const parsed = parseEngineMethodConfig(b["unity"], "unity");
    if ("error" in parsed) return parsed;
    config.unity = parsed;
  }
  if (b["blender"] !== undefined) {
    const parsed = parseEngineMethodConfig(b["blender"], "blender");
    if ("error" in parsed) return parsed;
    config.blender = parsed;
  }
  return config;
}

function parseProjectPatch(body: unknown): ProjectPatch | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const patch: ProjectPatch = {};

  if (b["name"] !== undefined) {
    if (typeof b["name"] !== "string" || b["name"].trim().length === 0) {
      return { error: "name must be a non-empty string" };
    }
    patch.name = b["name"].trim();
  }
  for (const key of ["unityProjectPath", "blenderSourcePath"] as const) {
    if (b[key] === undefined) continue;
    const v = b[key];
    // null clears the link — the workspace being unset is a real, distinct
    // state from "never asked," not something to reject as bad input.
    if (v !== null && (typeof v !== "string" || v.trim().length === 0)) {
      return { error: `${key} must be a non-empty string or null` };
    }
    patch[key] = v === null ? null : (v as string).trim();
  }
  if (b["engineIntegration"] !== undefined) {
    if (b["engineIntegration"] === null) {
      patch.engineIntegration = null;
    } else {
      const parsed = parseEngineIntegration(b["engineIntegration"]);
      if ("error" in parsed) return parsed;
      patch.engineIntegration = parsed;
    }
  }
  return patch;
}

export async function patchProject(ctx: Ctx, req: Request): Promise<Response> {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const parsed = parseProjectPatch(body);
  if ("error" in parsed) return fail(400, parsed.error);

  const next: Project = { ...project, updatedAt: Date.now() };
  const changed: string[] = [];

  if (parsed.name !== undefined && parsed.name !== project.name) {
    next.name = parsed.name;
    changed.push("name");
  }
  if (parsed.unityProjectPath !== undefined) {
    const value = parsed.unityProjectPath ?? undefined;
    if (value !== project.unityProjectPath) {
      next.unityProjectPath = value;
      changed.push("unityProjectPath");
    }
  }
  if (parsed.blenderSourcePath !== undefined) {
    const value = parsed.blenderSourcePath ?? undefined;
    if (value !== project.blenderSourcePath) {
      next.blenderSourcePath = value;
      changed.push("blenderSourcePath");
    }
  }
  if (parsed.engineIntegration !== undefined) {
    const value = parsed.engineIntegration ?? undefined;
    if (JSON.stringify(value) !== JSON.stringify(project.engineIntegration)) {
      next.engineIntegration = value;
      changed.push("engineIntegration");
    }
  }

  if (changed.length === 0) {
    return json({ project: next, changed, workspace: buildWorkspaceStatus(ctx), seq: ctx.store.lastSeq });
  }

  ctx.store.putProject(next);

  // Initial scan is automatic, not a button — design/automation-spec.md
  // Part I. `bootstrapProject` already does this for a fresh link at init
  // time; this is the other real path — completing a setup card later and
  // linking it here — and it needs the identical treatment, or the catalog
  // silently stays empty until someone remembers to click Rescan.
  let scanned = next;
  let proposedCount = 0;
  if (changed.includes("unityProjectPath") && next.unityProjectPath && validateUnityPath(next.unityProjectPath).valid) {
    const { proposed } = scanAndReconcile(ctx.store, "unity", next.unityProjectPath);
    proposedCount += proposed.length;
    scanned = { ...scanned, workspaceScannedAt: Date.now() };
  }
  if (changed.includes("blenderSourcePath") && next.blenderSourcePath && validateBlenderPath(next.blenderSourcePath).valid) {
    const { proposed } = scanAndReconcile(ctx.store, "blender", next.blenderSourcePath);
    proposedCount += proposed.length;
    scanned = { ...scanned, workspaceScannedAt: Date.now() };
  }
  if (scanned !== next) {
    ctx.store.putProject(scanned);
    ctx.bus.publish({ kind: "workspaceScanned", seq: ctx.store.lastSeq });
    if (proposedCount > 0) ctx.bus.publish({ kind: "suggestionsChanged", seq: ctx.store.lastSeq });
  }

  ctx.bus.publish({ kind: "projectChanged", seq: ctx.store.lastSeq, id: scanned.id });
  return json({ project: scanned, changed, workspace: buildWorkspaceStatus(ctx), seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/workspace
// ---------------------------------------------------------------------------

function buildWorkspaceStatus(ctx: Ctx): WorkspaceStatus {
  const project = ctx.store.getProject();
  const { total, byKind } = ctx.store.workspaceAssetCounts();

  const status: WorkspaceStatus = {
    assetCounts: byKind as Partial<Record<AssetKindGuess, number>>,
    totalAssets: total,
    complete: project ? isWorkspaceComplete(project) : false,
  };

  if (project?.unityProjectPath) status.unity = validateUnityPath(project.unityProjectPath);
  if (project?.blenderSourcePath) status.blender = validateBlenderPath(project.blenderSourcePath);
  if (project?.workspaceScannedAt) status.lastScannedAt = project.workspaceScannedAt;

  return status;
}

export function getWorkspace(ctx: Ctx): Response {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");
  return json({ workspace: buildWorkspaceStatus(ctx), seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// POST /api/workspace/scan
// ---------------------------------------------------------------------------

export function postWorkspaceScan(ctx: Ctx): Response {
  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");
  if (!project.unityProjectPath && !project.blenderSourcePath) {
    return fail(400, "no workspace linked — set unityProjectPath or blenderSourcePath first");
  }

  const results: Record<
    string,
    { count: number; durationMs: number; warnings: string[]; proposed: number } | { error: string }
  > = {};
  let proposedCount = 0;

  if (project.unityProjectPath) {
    const link = validateUnityPath(project.unityProjectPath);
    if (!link.valid) {
      results["unity"] = { error: link.reason ?? "invalid Unity path" };
    } else {
      const { assets, durationMs, warnings, proposed } = scanAndReconcile(ctx.store, "unity", project.unityProjectPath);
      proposedCount += proposed.length;
      results["unity"] = { count: assets.length, durationMs, warnings, proposed: proposed.length };
    }
  }

  if (project.blenderSourcePath) {
    const link = validateBlenderPath(project.blenderSourcePath);
    if (!link.valid) {
      results["blender"] = { error: link.reason ?? "invalid Blender path" };
    } else {
      const { assets, durationMs, warnings, proposed } = scanAndReconcile(ctx.store, "blender", project.blenderSourcePath);
      proposedCount += proposed.length;
      results["blender"] = { count: assets.length, durationMs, warnings, proposed: proposed.length };
    }
  }

  ctx.store.putProject({ ...project, workspaceScannedAt: Date.now() });
  ctx.bus.publish({ kind: "workspaceScanned", seq: ctx.store.lastSeq });
  if (proposedCount > 0) ctx.bus.publish({ kind: "suggestionsChanged", seq: ctx.store.lastSeq });
  return json({ results, workspace: buildWorkspaceStatus(ctx), seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/workspace/assets — backs the anchor picker
// ---------------------------------------------------------------------------

export function getWorkspaceAssets(ctx: Ctx, req: Request): Response {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const kindParam = url.searchParams.get("kind") ?? undefined;
  if (kindParam && !(ASSET_KIND_GUESSES as readonly string[]).includes(kindParam)) {
    return fail(400, `kind must be one of: ${ASSET_KIND_GUESSES.join(", ")}`);
  }
  const sourceParam = url.searchParams.get("source") ?? undefined;
  if (sourceParam && sourceParam !== "unity" && sourceParam !== "blender") {
    return fail(400, `source must be "unity" or "blender"`);
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const assets = ctx.store.searchWorkspaceAssets(q, { kind: kindParam, source: sourceParam, limit });
  return json({ assets, seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/registry — other known projects, reachability probed live
// ---------------------------------------------------------------------------

/**
 * Ask whatever a registered project's own port file names to identify
 * itself — the same authoritative check port-reclamation uses (Part II,
 * workspace-spec.md): a port file can be stale, an HTTP answer cannot.
 */
async function probeRegisteredProject(root: string): Promise<Instance | undefined> {
  const portFile = join(root, ".uassist", "port");
  if (!existsSync(portFile)) return undefined;
  const port = Number(readFileSync(portFile, "utf8").trim());
  if (!Number.isFinite(port)) return undefined;
  const instance = await probeInstance(port);
  return instance && instance.root === root ? instance : undefined;
}

export async function getRegistry(ctx: Ctx): Promise<Response> {
  const project = ctx.store.getProject();
  const selfRoot = ctx.store.root;

  const entries = await Promise.all(
    listRegisteredProjects().map(async (entry) => {
      if (entry.root === selfRoot) {
        return { ...entry, reachable: true as const, self: true as const };
      }
      const instance = await probeRegisteredProject(entry.root);
      return {
        ...entry,
        reachable: instance !== undefined,
        self: false as const,
        url: instance ? `http://127.0.0.1:${instance.port}` : undefined,
      };
    }),
  );

  return json({ project: project ? { id: project.id, name: project.name, root: selfRoot } : undefined, projects: entries });
}

// ---------------------------------------------------------------------------
// POST /api/registry/:id/start — start another registered project's server
// ---------------------------------------------------------------------------

/**
 * Only ever starts a server for an *already-registered* project — never an
 * arbitrary path a request could name. Consistent with this app's stated
 * security stance (loopback binding IS the security model, ServeOptions'
 * own doc comment): a request that can already read and modify the current
 * project can, by that same trust, ask this one to also start another
 * project it already knows about — never a project it doesn't.
 */
export async function postRegistryStart(ctx: Ctx, id: string): Promise<Response> {
  const entry = listRegisteredProjects().find((p) => p.id === id);
  if (!entry) return fail(404, "no such registered project");

  const already = await probeRegisteredProject(entry.root);
  if (already) {
    return json({ started: false, reachable: true, url: `http://127.0.0.1:${already.port}` });
  }

  // Never spawn a second process for the project already answering this
  // exact request — if we get here for our own root, our port file or the
  // self-probe raced with something (a read-only .uassist, a request that
  // landed before the port file write completed); report it rather than
  // risk two Store instances writing the same mirror concurrently.
  if (entry.root === ctx.store.root) {
    return fail(503, "this project's own server could not confirm its own port — try again in a moment");
  }

  if (!existsSync(join(entry.root, ".uassist"))) {
    return fail(409, `"${entry.name}" has no .uassist/ at ${entry.root} — it may have moved or been deleted`);
  }

  try {
    spawnServer({ root: entry.root });
  } catch (err) {
    return fail(500, err instanceof ServerBinaryNotFoundError ? err.message : err instanceof Error ? err.message : String(err));
  }

  const deadline = Date.now() + 10_000;
  let confirmed: Instance | undefined;
  while (Date.now() < deadline && !confirmed) {
    await Bun.sleep(200);
    confirmed = await probeRegisteredProject(entry.root);
  }

  if (!confirmed) return fail(504, `"${entry.name}" did not start within 10s — check its .uassist/server.log`);
  return json({ started: true, reachable: true, url: `http://127.0.0.1:${confirmed.port}` });
}
