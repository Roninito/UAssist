/**
 * @uassist/server — one Bun.serve process carrying the REST API, the WebSocket
 * event stream, and the web UI.
 *
 * See design/uassist-spec.md Part XIII.
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureWorkspaceSetupCards, isWorkspaceComplete, runValidators, startScanScheduler, Store, VERSION } from "@uassist/core";
import index from "../web/index.html";
import project from "../web/project.html";
import docs from "../web/docs.html";
import decisions from "../web/decisions.html";
import {
  writeInstanceFile,
  removeInstanceFile,
  INSTANCE_NAME,
  type Instance,
} from "./instance.ts";
import { canBind, pruneDeadInstanceFile, reclaimPort } from "./reclaim.ts";
import { EventBus, parseClientMessage, send, TOPIC } from "./bus.ts";
import {
  fail,
  getBoard,
  getCard,
  getEvents,
  getProject,
  getViews,
  json,
  listCards,
  listHealth,
  listMilestones,
  patchCard,
  getAiConfig,
  putAiConfig,
  getChat,
  postChat,
  postValidate,
  type Ctx,
} from "./api.ts";
import {
  getRegistry,
  getWorkspace,
  getWorkspaceAssets,
  patchProject,
  postRegistryStart,
  postWorkspaceScan,
} from "./workspace.ts";
import { getDoc, getDocChat, listDocs, postDocChat, putDoc } from "./docs.ts";
import { postPlanImport } from "./plans.ts";
import { listSuggestions, postAcceptSuggestion, postHoldSuggestion, postRejectSuggestion } from "./suggestions.ts";
import {
  getAdapters,
  getDiff,
  getJob,
  getLedger,
  listCardJobs,
  postAccept,
  postDispatch,
  postReject,
} from "./jobs.ts";

export const DEFAULT_PORT = 7373;
/** How many ports past the requested one to try before giving up. */
export const PORT_PROBE_RANGE = 20;

/**
 * Find a bindable port at or above `first`, without touching whatever is
 * already there.
 *
 * This is the last resort — reached only when the requested port is busy and
 * `reclaimPort` (see reclaim.ts) could not positively identify its occupant
 * as a stale UAssist server for this project. Anything genuinely unknown, or
 * belonging to a different project, gets left alone and we move to the next
 * port instead of guessing.
 */
function findPort(first: number, hostname: string): number {
  for (let port = first; port < first + PORT_PROBE_RANGE; port++) {
    try {
      const probe = Bun.serve({
        port,
        hostname,
        fetch: () => new Response(null, { status: 503 }),
      });
      probe.stop(true);
      if (port !== first) {
        console.warn(`[uassist] using port ${port} instead`);
      }
      return port;
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `no free port in ${first}..${first + PORT_PROBE_RANGE - 1}. Pass --port, or stop whatever is holding them.`,
  );
}

/**
 * Resolve which port to actually bind.
 *
 * On conflict this does not blindly increment. It runs the identify-then-act
 * sequence in reclaim.ts: find out what is on the port, confirm via HTTP
 * whether it is UAssist, and only reclaim it when it is unambiguously a
 * stale server for *this* project root. A different project's server, or an
 * unidentified process, is left running and we fall back to probing upward.
 */
async function resolvePort(
  requested: number,
  hostname: string,
  root: string,
): Promise<number> {
  if (await canBind(requested, hostname)) return requested;

  const result = await reclaimPort(requested, hostname, root);
  console.log(`[uassist] ${result.message}`);

  if (result.action === "already-free" || result.action === "reclaimed") {
    return requested;
  }
  // "different-project" or "unidentified": untouched by design. Move on.
  return findPort(requested, hostname);
}

export interface ServeOptions {
  root?: string;
  port?: number;
  /**
   * Bind beyond loopback. Loopback binding IS the security model — there is no
   * authentication — so this warns loudly and is never the default.
   */
  unsafeBind?: boolean;
}

export async function startServer(options: ServeOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const store = new Store(root, { readOnly: true });
  const bus = new EventBus();
  const ctx: Ctx = { store, bus };

  // Self-healing, not just a boot-time nudge — see bootstrap.ts's own doc
  // comment on ensureWorkspaceSetupCards. Run once immediately (don't make
  // a person wait out the first scan-scheduler tick to see it), and again
  // every tick below for as long as the server keeps running.
  {
    const project = store.getProject();
    if (project) {
      ensureWorkspaceSetupCards(store, project);
      await runValidators(store, { includeCompileCheck: false });
    }
  }

  const hostname = options.unsafeBind ? "0.0.0.0" : "127.0.0.1";
  if (options.unsafeBind) {
    console.warn(
      "WARNING: binding 0.0.0.0. UAssist has no authentication; anyone who can reach this port can read and modify the project.",
    );
  }

  const requested = options.port ?? Number(process.env["UASSIST_PORT"] ?? DEFAULT_PORT);

  // A crash or a kill -9 on a previous run can leave a pidfile naming a pid
  // that no longer exists. Clear it before anything else runs so a stale
  // entry never lingers past a clean restart. Reclamation below never trusts
  // this file by itself regardless — see instance.ts.
  await pruneDeadInstanceFile(store.dir);

  const port = await resolvePort(requested, hostname, root);

  // Built before Bun.serve so the /api/instance route below can close over
  // it directly, and so the pidfile write after binding uses the exact same
  // record the route answers with.
  const instance: Instance = {
    name: INSTANCE_NAME,
    version: VERSION,
    pid: process.pid,
    port,
    root,
    startedAt: Date.now(),
  };

  const server = Bun.serve({
    port,
    hostname,
    development: process.env["NODE_ENV"] !== "production",

    routes: {
      "/": index,
      "/board": index,
      "/project": project,
      "/docs": docs,
      "/decisions": decisions,

      "/api/version": () => json({ name: "UAssist", version: VERSION }),
      "/api/instance": () => json(instance),
      "/api/project": {
        GET: () => getProject(ctx),
        PATCH: (req) => patchProject(ctx, req),
      },
      "/api/board": (req) => getBoard(ctx, req),
      "/api/views": () => getViews(),
      "/api/milestones": () => listMilestones(ctx),
      "/api/health": () => listHealth(ctx),
      "/api/validate": { POST: () => postValidate(ctx) },
      "/api/events": (req) => getEvents(ctx, req),

      "/api/ai/config": {
        GET: () => getAiConfig(ctx),
        PUT: (req) => putAiConfig(ctx, req),
      },
      "/api/cards": {
        GET: (req) => listCards(ctx, req),
      },
      "/api/cards/:id": {
        GET: (req) => getCard(ctx, req.params.id),
        PATCH: (req) => patchCard(ctx, req.params.id, req),
      },
      "/api/cards/:id/chat": {
        GET: (req) => getChat(ctx, req.params.id),
        POST: (req) => postChat(ctx, req.params.id, req, (m) => bus.publish(m as Parameters<EventBus["publish"]>[0])),
      },
      "/api/cards/:id/dispatch": { POST: (req) => postDispatch(ctx, req.params.id, req) },
      "/api/cards/:id/jobs": { GET: (req) => listCardJobs(ctx, req.params.id) },

      "/api/adapters": () => getAdapters(),
      "/api/ledger": () => getLedger(ctx),
      "/api/jobs/:id": { GET: (req) => getJob(ctx, req.params.id) },
      "/api/jobs/:id/diff": { GET: (req) => getDiff(ctx, req.params.id) },
      "/api/jobs/:id/accept": { POST: (req) => postAccept(ctx, req.params.id, req) },
      "/api/jobs/:id/reject": { POST: (req) => postReject(ctx, req.params.id) },

      "/api/suggestions": { GET: (req) => listSuggestions(ctx, req) },
      "/api/suggestions/:id/accept": { POST: (req) => postAcceptSuggestion(ctx, req.params.id) },
      "/api/suggestions/:id/reject": { POST: (req) => postRejectSuggestion(ctx, req.params.id) },
      "/api/suggestions/:id/hold": { POST: (req) => postHoldSuggestion(ctx, req.params.id) },

      "/api/workspace": () => getWorkspace(ctx),
      "/api/workspace/scan": { POST: () => postWorkspaceScan(ctx) },
      "/api/workspace/assets": (req) => getWorkspaceAssets(ctx, req),
      "/api/registry": () => getRegistry(ctx),
      "/api/registry/:id/start": { POST: (req) => postRegistryStart(ctx, req.params.id) },
      "/api/plans/import": { POST: (req) => postPlanImport(ctx, req) },

      "/api/docs": { GET: () => listDocs(ctx) },
      "/api/docs/:path": {
        GET: (req) => getDoc(ctx, req.params.path),
        PUT: (req) => putDoc(ctx, req.params.path, req),
      },
      "/api/docs/:path/chat": {
        GET: (req) => getDocChat(ctx, req.params.path),
        POST: (req) => postDocChat(ctx, req.params.path, req, (m) => bus.publish(m as Parameters<EventBus["publish"]>[0])),
      },
    },

    websocket: {
      open(ws) {
        ws.subscribe(TOPIC);
      },
      message(ws, raw) {
        const msg = parseClientMessage(raw);
        if (!msg) return;
        if (msg.kind === "ping") {
          send(ws, { kind: "pong" });
          return;
        }
        bus.hello(ws, store, msg.lastSeq);
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
      },
    },

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return;
        return fail(400, "websocket upgrade failed");
      }
      if (url.pathname.startsWith("/api/")) return fail(404, "no such endpoint");
      return fail(404, "not found");
    },
  });

  bus.attach(server);

  writeInstanceFile(store.dir, instance);

  // "On by default, not a thing to remember to turn on" — see
  // design/automation-spec.md Part III. Unref'd, so this never keeps the
  // process alive on its own; a real request/response or an explicit
  // scheduler.stop() does.
  const scheduler = startScanScheduler(store, {
    onResult: (results) => {
      bus.publish({ kind: "workspaceScanned", seq: store.lastSeq });
      if (results.some((r) => r.proposedCount > 0)) {
        bus.publish({ kind: "suggestionsChanged", seq: store.lastSeq });
      }
    },
    // Fires every tick regardless of whether anything was linked to scan —
    // a project with nothing linked at all never produces a scan result,
    // and that is exactly the case ensureWorkspaceSetupCards and the
    // workspace-incomplete health check most need to keep re-checking.
    onTick: async () => {
      const project = store.getProject();
      if (project) {
        for (const card of ensureWorkspaceSetupCards(store, project)) {
          bus.publish({ kind: "cardCreated", seq: store.lastSeq, id: card.id });
        }
      }
      // Cheap only — no compile check here, see RunValidatorsOptions's doc
      // comment.
      const result = await runValidators(store, { includeCompileCheck: false });
      if (result.created.length > 0 || result.closed > 0) {
        bus.publish({ kind: "healthChanged", seq: store.lastSeq });
      }
    },
    onError: (err) => {
      console.error(`[uassist] scheduled scan failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  // Remove the pidfile when the process exits — but only if it still names
  // us. See instance.ts for the race this guards against: a server we just
  // reclaimed the port from can still be mid-shutdown when we start.
  for (const signal of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
    process.on(signal, () => {
      scheduler.stop();
      removeInstanceFile(store.dir, process.pid);
      process.exit(0);
    });
  }

  // Unity, Blender and the CLI discover the live port here rather than
  // assuming 7373, which may be taken.
  try {
    writeFileSync(join(store.dir, "port"), String(server.port), "utf8");
  } catch {
    // A read-only .uassist is unusual but not fatal; the server still runs.
  }

  return { server, store, bus, scheduler };
}

if (import.meta.main) {
  // Parsed here, not left to startServer()'s own defaults, so a compiled
  // standalone binary (dist/uassist-server, or `bun run packages/server/src/index.ts`
  // invoked directly) is fully controllable from the command line rather
  // than silently defaulting to process.cwd() — the bug `uassist start`
  // exists specifically to never reproduce (see cli's own doc comment on
  // spawning this entry point).
  const { parseArgs } = await import("node:util");
  const { values: cliArgs } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      root: { type: "string" },
      port: { type: "string" },
      "unsafe-bind": { type: "boolean", default: false },
    },
    strict: false,
  });
  const cliPort = cliArgs["port"] !== undefined ? Number(cliArgs["port"]) : undefined;
  if (cliPort !== undefined && !Number.isFinite(cliPort)) {
    console.error(`uassist-server: --port must be a number, got "${cliArgs["port"]}"`);
    process.exit(2);
  }

  const { server, store } = await startServer({
    root: typeof cliArgs["root"] === "string" ? cliArgs["root"] : undefined,
    port: cliPort,
    unsafeBind: cliArgs["unsafe-bind"] === true,
  });
  const project = store.getProject();
  console.log(
    `UAssist ${VERSION} — ${project?.name ?? "no project"} — http://${server.hostname}:${server.port}`,
  );
  console.log(
    `  ${store.countCards()} cards, ${store.listMilestones().length} milestones, seq ${store.lastSeq}`,
  );
  // Initialization is enforced, not optional — see design/automation-spec.md
  // Part I. A visible nudge on every start, not a one-time warning that
  // scrolls off, for as long as the gap actually remains open.
  if (project && !isWorkspaceComplete(project)) {
    console.log(
      `  workspace incomplete — no valid Unity or Blender path linked. See the Project page, or \`uassist workspace status\`.`,
    );
  }
}
