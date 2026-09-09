/**
 * Documents: list, view, edit, and AI chat scoped to a document.
 *
 * A document is a file under .uassist/docs/ — no database row, the same
 * reasoning as the Asset Catalog's mirror exemption but in the opposite
 * direction: the file already IS the durable, git-tracked, human-readable
 * form, so indexing it into SQLite would add a copy with nothing to justify
 * it at this corpus size.
 *
 * See design/workspace-spec.md Part V.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, relative, sep } from "node:path";

import type { ChatMessage } from "@uassist/core";
import { fail, json, type Ctx } from "./api.ts";

export interface DocSummary {
  path: string;
  title: string;
  updatedAt: number;
  sizeBytes: number;
  /** True for the imported build plan, surfaced with a distinct badge and
   *  its re-ingest action rather than treated as an ordinary document. */
  isPlan: boolean;
}

function docsDir(ctx: Ctx): string {
  const dir = join(ctx.store.dir, "docs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function plansDir(ctx: Ctx): string {
  return join(ctx.store.dir, "plans");
}

/**
 * Resolve a client-supplied relative path against a base directory, refusing
 * anything that escapes it. Untrusted input from a URL segment — `..` and
 * absolute paths must not reach the filesystem call below them.
 */
function resolveWithin(base: string, relPath: string): string | undefined {
  const full = normalize(join(base, relPath));
  const rel = relative(base, full);
  if (rel.startsWith("..") || rel.startsWith(sep) || (sep !== "/" && rel.startsWith("/"))) {
    return undefined;
  }
  return full;
}

function titleFromMarkdown(content: string, fallback: string): string {
  const heading = content.split("\n").find((line) => line.trim().startsWith("# "));
  return heading ? heading.replace(/^#\s*/, "").trim() : fallback;
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

// ---------------------------------------------------------------------------
// GET /api/docs
// ---------------------------------------------------------------------------

export function listDocs(ctx: Ctx): Response {
  const docs: DocSummary[] = [];

  for (const name of listMarkdownFiles(docsDir(ctx))) {
    const full = join(docsDir(ctx), name);
    const content = readFileSync(full, "utf8");
    const stat = statSync(full);
    docs.push({
      path: name,
      title: titleFromMarkdown(content, name.replace(/\.md$/, "")),
      updatedAt: stat.mtimeMs,
      sizeBytes: stat.size,
      isPlan: false,
    });
  }

  // The imported plan is a document too, badged distinctly — see workspace-spec.md
  // Part V. plans/ can hold more than one file historically re-imported; only
  // the most recently written one is "the" current plan for this listing.
  const planFiles = listMarkdownFiles(plansDir(ctx));
  for (const name of planFiles) {
    const full = join(plansDir(ctx), name);
    const content = readFileSync(full, "utf8");
    const stat = statSync(full);
    docs.push({
      path: `../plans/${name}`,
      title: titleFromMarkdown(content, name.replace(/\.md$/, "")),
      updatedAt: stat.mtimeMs,
      sizeBytes: stat.size,
      isPlan: true,
    });
  }

  docs.sort((a, b) => b.updatedAt - a.updatedAt);
  return json({ docs, seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// GET /api/docs/:path
// ---------------------------------------------------------------------------

/** A doc path prefixed `../plans/` addresses the plans directory instead —
 *  see the badge note above. Everything else lives under docs/. */
function resolveDocPath(ctx: Ctx, rawPath: string): { full: string; canonical: string } | undefined {
  if (rawPath.startsWith("../plans/")) {
    const full = resolveWithin(plansDir(ctx), rawPath.slice("../plans/".length));
    return full ? { full, canonical: rawPath } : undefined;
  }
  const full = resolveWithin(docsDir(ctx), rawPath);
  return full ? { full, canonical: rawPath } : undefined;
}

export function getDoc(ctx: Ctx, rawPath: string): Response {
  const resolved = resolveDocPath(ctx, decodeURIComponent(rawPath));
  if (!resolved) return fail(400, "invalid document path");
  if (!existsSync(resolved.full)) return fail(404, "no such document");

  const content = readFileSync(resolved.full, "utf8");
  const stat = statSync(resolved.full);
  return json({
    path: resolved.canonical,
    title: titleFromMarkdown(content, resolved.canonical),
    content,
    updatedAt: stat.mtimeMs,
    isPlan: resolved.canonical.startsWith("../plans/"),
    seq: ctx.store.lastSeq,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/docs/:path
// ---------------------------------------------------------------------------

export async function putDoc(ctx: Ctx, rawPath: string, req: Request): Promise<Response> {
  const decoded = decodeURIComponent(rawPath);
  if (decoded.startsWith("../plans/")) {
    return fail(400, "the imported plan is edited by re-importing, not by saving here");
  }
  if (!decoded.endsWith(".md")) return fail(400, "document paths must end in .md");

  const full = resolveWithin(docsDir(ctx), decoded);
  if (!full) return fail(400, "invalid document path");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") return fail(400, "content must be a string");

  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");

  ctx.bus.publish({ kind: "docChanged", seq: ctx.store.lastSeq, path: decoded });
  return json({ path: decoded, title: titleFromMarkdown(content, decoded), seq: ctx.store.lastSeq });
}

// ---------------------------------------------------------------------------
// Doc chat — same shape and streaming discipline as per-card chat (api.ts
// postChat); a separate table and code path rather than a generalized
// subject key, see design/workspace-spec.md Part V, "Why a second table."
// ---------------------------------------------------------------------------

export function getDocChat(ctx: Ctx, rawPath: string): Response {
  const decoded = decodeURIComponent(rawPath);
  const thread = ctx.store.getDocThread(decoded);
  if (!thread) return json({ docPath: decoded, messages: [], seq: ctx.store.lastSeq });
  return json({ thread, seq: ctx.store.lastSeq });
}

export async function postDocChat(
  ctx: Ctx,
  rawPath: string,
  req: Request,
  publish: (m: unknown) => void,
): Promise<Response> {
  const decoded = decodeURIComponent(rawPath);
  const resolved = resolveDocPath(ctx, decoded);
  if (!resolved || !existsSync(resolved.full)) return fail(404, "no such document");

  const project = ctx.store.getProject();
  if (!project) return fail(404, "no project — run `uassist init`");

  const config = project.aiConfig;
  const provider =
    config.providers.find((p) => p.id === config.activeProviderId && p.enabled) ??
    config.providers.find((p) => p.enabled);
  if (!provider) return fail(400, "no AI provider configured or enabled");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "body must be valid JSON");
  }
  const messageText = (body as { message?: unknown }).message;
  if (typeof messageText !== "string" || messageText.trim().length === 0) {
    return fail(400, "message must be a non-empty string");
  }

  const userMessage: ChatMessage = { role: "user", content: messageText.trim(), createdAt: Date.now() };
  let thread = ctx.store.appendDocChatMessage(decoded, userMessage);

  publish({
    kind: "docChatMessageAdded",
    seq: ctx.store.lastSeq,
    docPath: decoded,
    message: userMessage,
  });

  const { createLlmClient, describeEmptyReply } = await import("@uassist/core");
  const client = createLlmClient(provider);

  // The document's own content is the system context — v1 is read-and-discuss,
  // not propose-then-apply (that is v2, specified but not built; see
  // workspace-spec.md Part V).
  const docContent = readFileSync(resolved.full, "utf8");
  const systemMsg: ChatMessage = {
    role: "system",
    content: `${config.systemPrompt}\n\nYou are discussing the following project document ("${decoded}"). Suggest edits in prose; you are not applying changes directly.\n\n---\n${docContent}\n---`,
    createdAt: Date.now(),
  };

  const messagesForModel: ChatMessage[] = [
    systemMsg,
    ...thread.messages.filter((m) => m.role !== "system"),
  ];

  const controller = new AbortController();
  const run = async () => {
    try {
      let assistantContent = "";
      let finishReason: string | undefined;
      for await (const chunk of client.chat({
        messages: messagesForModel,
        model: provider.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        signal: controller.signal,
      })) {
        if (chunk.content) assistantContent += chunk.content;
        if (chunk.finishReason) finishReason = chunk.finishReason;
        publish({
          kind: "docChatToken",
          seq: ctx.store.lastSeq,
          docPath: decoded,
          token: chunk.content,
          done: chunk.done,
        });
        if (chunk.done) break;
      }
      if (assistantContent.length === 0) {
        assistantContent = describeEmptyReply(finishReason, config.maxTokens) ?? assistantContent;
      }
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: assistantContent,
        name: provider.name,
        createdAt: Date.now(),
      };
      thread = ctx.store.appendDocChatMessage(decoded, assistantMessage);
      publish({
        kind: "docChatMessageAdded",
        seq: ctx.store.lastSeq,
        docPath: decoded,
        message: assistantMessage,
        done: true,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: `Error: ${errorMessage}`,
        name: provider.name,
        createdAt: Date.now(),
      };
      thread = ctx.store.appendDocChatMessage(decoded, assistantMessage);
      publish({
        kind: "docChatMessageAdded",
        seq: ctx.store.lastSeq,
        docPath: decoded,
        message: assistantMessage,
        done: true,
        error: true,
      });
    }
  };

  void run();

  return json({ thread, streaming: true, seq: ctx.store.lastSeq });
}
