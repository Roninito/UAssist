/**
 * Plan import / re-ingest, exposed for the web UI.
 *
 * The CLI (`uassist plan import`) and this endpoint share the same
 * `importPlan` core function and therefore the same diff — a dry run here is
 * the identical computation `--dry-run` reports on the command line, just
 * rendered instead of printed.
 *
 * See design/uassist-spec.md Part V.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { importPlan, type ImportResult } from "@uassist/core";
import { fail, json, type Ctx } from "./api.ts";

interface ImportRequest {
  path: string;
  dryRun?: boolean;
}

function parseImportRequest(body: unknown): ImportRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b["path"] !== "string" || b["path"].trim().length === 0) {
    return { error: "path must be a non-empty string" };
  }
  if (b["dryRun"] !== undefined && typeof b["dryRun"] !== "boolean") {
    return { error: "dryRun must be a boolean" };
  }
  return { path: b["path"].trim(), dryRun: b["dryRun"] === true };
}

export async function postPlanImport(ctx: Ctx, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const parsed = parseImportRequest(body);
  if ("error" in parsed) return fail(400, parsed.error);

  if (!existsSync(parsed.path)) return fail(404, `no such file: ${parsed.path}`);

  let markdown: string;
  try {
    markdown = readFileSync(parsed.path, "utf8");
  } catch (err) {
    return fail(400, `could not read ${parsed.path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result: ImportResult;
  try {
    result = importPlan(ctx.store, markdown, parsed.path, { dryRun: parsed.dryRun });
  } catch (err) {
    return fail(400, `import failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.applied) {
    const project = ctx.store.getProject();
    if (project) ctx.store.putProject({ ...project, planSourcePath: parsed.path });

    ctx.bus.publish({
      kind: "planImported",
      seq: ctx.store.lastSeq,
      added: result.addedCards.length + result.addedMilestones.length,
      updated: result.updatedCards.length + result.updatedMilestones.length,
      renamed: result.renamedCards.length,
    });
  }

  return json({
    ...result,
    fileName: basename(parsed.path),
    seq: ctx.store.lastSeq,
  });
}
