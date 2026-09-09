/**
 * Port reclamation.
 *
 * On startup, if the default port is taken, this does NOT blindly walk up to
 * the next free one. It first finds out what is actually listening there and
 * only acts if that thing can be positively identified as a stale UAssist
 * server for *this exact project*:
 *
 *   1. `findPortOwner`   — ask the OS (lsof) who holds the port. This is the
 *      "see what's running" step: it never causes any action on its own, it
 *      only produces a name to log or to compare against.
 *   2. `probeInstance`   — ask the thing on the port to identify itself over
 *      HTTP (instance.ts). Only a live UAssist server can answer this
 *      correctly, so it is the trusted signal — not the OS-reported command
 *      name, and not the pidfile, both of which can be stale or generic
 *      ("bun").
 *   3. Cross-check the pid the HTTP probe claims against the pid the OS says
 *      is actually holding the socket. A mismatch means something is
 *      forwarding or fronting the port and we back off rather than guess.
 *   4. Only when the probe confirms UAssist AND the project root matches ours
 *      do we terminate it — SIGTERM, wait, SIGKILL if it does not go quietly.
 *      A different UAssist project on the same port, or an unidentified
 *      process, is left alone; the caller falls back to the next free port.
 *
 * See design/uassist-spec.md Part XIII and Part XX (open decision #2).
 */

import {
  probeInstance,
  readInstanceFile,
  removeInstanceFile,
  type Instance,
} from "./instance.ts";

export interface PortOwner {
  pid: number;
  /** Process name as the OS reports it, e.g. "bun". Informational only —
   *  never the basis for a kill decision. */
  command: string;
}

/**
 * Ask the OS who is listening on a TCP port.
 *
 * `lsof` exits 1 with empty output when nothing matches, which Bun.$ treats
 * as a thrown error by default — that is the expected "port is free" case,
 * not a failure, so it is caught rather than propagated. Any other failure
 * (lsof missing, permission denied) degrades the same way: we simply cannot
 * see who owns the port, which — per the module doctrine above — means we
 * do not act on it.
 */
export async function findPortOwner(port: number): Promise<PortOwner | undefined> {
  try {
    const { $ } = await import("bun");
    const result = await $`lsof -nP -iTCP:${port} -sTCP:LISTEN`.quiet().nothrow();
    if (result.exitCode !== 0) return undefined;

    const lines = result.stdout.toString("utf8").trim().split("\n");
    const dataLine = lines[1]; // line 0 is the header row
    if (!dataLine) return undefined;

    const cols = dataLine.trim().split(/\s+/);
    const command = cols[0];
    const pid = Number(cols[1]);
    if (!command || !Number.isFinite(pid)) return undefined;
    return { pid, command };
  } catch {
    return undefined;
  }
}

/** Try to bind and immediately release. The only reliable "is this free" check. */
export async function canBind(port: number, hostname: string): Promise<boolean> {
  try {
    const probe = Bun.serve({
      port,
      hostname,
      fetch: () => new Response(null, { status: 503 }),
    });
    probe.stop(true);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") return false;
    throw err;
  }
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ReclaimDecision =
  | { action: "already-free" }
  | { action: "reclaim"; instance: Instance }
  | { action: "different-project"; instance: Instance }
  | { action: "unidentified"; owner?: PortOwner };

/**
 * Decide what to do about a busy port, without doing anything yet.
 *
 * Kept separate from the side-effecting kill so the decision logic — the part
 * that actually matters for "don't kill the wrong thing" — is a pure
 * function of its inputs and unit-testable without touching a real process.
 */
export function decidePortAction(
  owner: PortOwner | undefined,
  probed: Instance | undefined,
  ourRoot: string,
): ReclaimDecision {
  if (!owner && !probed) return { action: "already-free" };

  if (probed) {
    // The HTTP probe is the trusted identity check (see module doc). If the
    // OS also reports an owner, its pid must agree with what the probe
    // claims — otherwise something is fronting the port and this is no
    // longer a simple "our own stale server" case.
    if (owner && owner.pid !== probed.pid) {
      return { action: "unidentified", owner };
    }
    return probed.root === ourRoot
      ? { action: "reclaim", instance: probed }
      : { action: "different-project", instance: probed };
  }

  return { action: "unidentified", owner };
}

export interface ReclaimResult {
  action: "already-free" | "reclaimed" | "different-project" | "unidentified";
  /** One line, safe to log as-is. */
  message: string;
}

export interface ReclaimOptions {
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  termGraceMs?: number;
  /** Total time budget, including the SIGKILL wait. */
  totalTimeoutMs?: number;
}

/**
 * SIGTERM, wait for the port to free (proof the process actually released
 * it, not just that it was signaled), escalate to SIGKILL if it doesn't go
 * quietly. Exported for `uassist stop`/`uassist kill` — the same graceful
 * shutdown sequence port reclamation already uses, driven by an explicit
 * human decision rather than an incidental port conflict.
 */
export async function terminateAndWait(
  instance: Instance,
  hostname: string,
  opts: ReclaimOptions,
): Promise<boolean> {
  const termGrace = opts.termGraceMs ?? 2500;
  const totalTimeout = opts.totalTimeoutMs ?? 5000;
  const start = Date.now();
  const pollMs = 100;

  try {
    process.kill(instance.pid, "SIGTERM");
  } catch {
    // Already gone — fine, we just want the port back.
  }

  while (Date.now() - start < termGrace) {
    if (await canBind(instance.port, hostname)) return true;
    await Bun.sleep(pollMs);
  }

  if (await processAlive(instance.pid)) {
    try {
      process.kill(instance.pid, "SIGKILL");
    } catch {
      // Raced with a natural exit between the liveness check and this call.
    }
  }

  while (Date.now() - start < totalTimeout) {
    if (await canBind(instance.port, hostname)) return true;
    await Bun.sleep(pollMs);
  }
  return false;
}

/**
 * See what is on `port`, and if it is unambiguously a stale UAssist server
 * for `root`, stop it and free the port. Anything else — a different
 * project's server, or a process that never confirms — is left untouched.
 */
export async function reclaimPort(
  port: number,
  hostname: string,
  root: string,
  opts: ReclaimOptions = {},
): Promise<ReclaimResult> {
  if (await canBind(port, hostname)) {
    return { action: "already-free", message: `port ${port} is free` };
  }

  const [owner, probed] = await Promise.all([
    findPortOwner(port),
    probeInstance(port),
  ]);
  const decision = decidePortAction(owner, probed, root);

  switch (decision.action) {
    case "already-free":
      // Freed itself between the bind check and here — nothing to do.
      return { action: "already-free", message: `port ${port} is free` };

    case "reclaim": {
      const { instance } = decision;
      const age = Math.round((Date.now() - instance.startedAt) / 1000);
      const ok = await terminateAndWait(instance, hostname, opts);
      if (!ok) {
        return {
          action: "unidentified",
          message: `stale UAssist server for this project (pid ${instance.pid}, running ${age}s) did not exit on port ${port} — leaving it alone`,
        };
      }
      return {
        action: "reclaimed",
        message: `stopped stale UAssist server for this project (pid ${instance.pid}, running ${age}s) and freed port ${port}`,
      };
    }

    case "different-project":
      return {
        action: "different-project",
        message: `port ${port} is held by another UAssist project ("${decision.instance.root}", pid ${decision.instance.pid}) — not touching it`,
      };

    case "unidentified":
      return {
        action: "unidentified",
        message: decision.owner
          ? `port ${port} is held by pid ${decision.owner.pid} (${decision.owner.command}), which does not identify as UAssist — not touching it`
          : `port ${port} is in use but its owner could not be determined — not touching it`,
      };
  }
}

/**
 * Clear this project's own pidfile if it names a pid that is no longer alive.
 * Run at startup before anything else touches the port, so a crashed prior
 * run does not leave a phantom entry for `probeInstance` to trip over later
 * (it never trusts the file alone, but a clean directory is still worth it).
 */
export async function pruneDeadInstanceFile(uassistDir: string): Promise<void> {
  const recorded = readInstanceFile(uassistDir);
  if (!recorded) return;
  if (!(await processAlive(recorded.pid))) {
    removeInstanceFile(uassistDir);
  }
}

// -----------------------------------------------------------------------------
// Standalone use: `bun run packages/server/src/reclaim.ts [port] [root]`
//
// Runs the same identify-then-act logic index.ts runs automatically on
// startup, but on demand and with the "what's running" step printed — useful
// to check what a busy port actually holds without starting a server at all.
// -----------------------------------------------------------------------------

if (import.meta.main) {
  const { resolve } = await import("node:path");
  // Mirrors DEFAULT_PORT in index.ts; not imported from there to avoid a
  // dependency edge back into the module that owns the HTTP route surface.
  const port = Number(process.argv[2] ?? 7373);
  const root = resolve(process.argv[3] ?? process.cwd());

  if (!Number.isFinite(port) || port <= 0) {
    console.error(`usage: reclaim.ts [port] [project-root]`);
    process.exit(2);
  }

  console.log(`Checking port ${port} for project ${root}`);
  const owner = await findPortOwner(port);
  console.log(
    owner
      ? `  OS reports:   pid ${owner.pid} (${owner.command})`
      : `  OS reports:   nothing listening (or lsof could not tell)`,
  );

  const probed = await probeInstance(port);
  console.log(
    probed
      ? `  identifies as: UAssist v${probed.version}, project "${probed.root}", pid ${probed.pid}`
      : `  identifies as: (no answer, or not UAssist)`,
  );

  const result = await reclaimPort(port, "127.0.0.1", root);
  console.log(`  -> ${result.message}`);
  process.exit(result.action === "different-project" || result.action === "unidentified" ? 1 : 0);
}
