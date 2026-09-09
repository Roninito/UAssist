/**
 * Instance identity.
 *
 * A running server advertises who it is in two places:
 *
 *   1. `.uassist/server.json` — a pidfile, readable without touching the port.
 *   2. `GET /api/instance` — authoritative, because only the process actually
 *      holding the port can answer it.
 *
 * Port reclamation depends on (2): a pidfile can be stale, and a stale pidfile
 * that names a pid some unrelated program has since been assigned is exactly
 * how a "helpful" restart script kills the wrong thing.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTANCE_FILE = "server.json";

/** The marker that says "this is UAssist". Must not change casually. */
export const INSTANCE_NAME = "uassist-server";

export interface Instance {
  name: typeof INSTANCE_NAME;
  version: string;
  pid: number;
  port: number;
  /** Absolute project root. Two UAssist servers for different projects are
   *  different things, and only one of them is ours to kill. */
  root: string;
  startedAt: number;
}

export function isInstance(value: unknown): value is Instance {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["name"] === INSTANCE_NAME &&
    typeof v["version"] === "string" &&
    typeof v["pid"] === "number" &&
    typeof v["port"] === "number" &&
    typeof v["root"] === "string" &&
    typeof v["startedAt"] === "number"
  );
}

export function writeInstanceFile(uassistDir: string, instance: Instance): void {
  try {
    writeFileSync(
      join(uassistDir, INSTANCE_FILE),
      JSON.stringify(instance, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Advisory only. A server that cannot write its pidfile still runs; the
    // HTTP probe is what reclamation actually trusts.
  }
}

export function readInstanceFile(uassistDir: string): Instance | undefined {
  const path = join(uassistDir, INSTANCE_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isInstance(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the pidfile — but only if it still names `expectedPid`.
 *
 * Reclaiming a stale server has a real race: process A frees the port and is
 * mid-shutdown while process B (us) has already bound it and written a fresh
 * pidfile. If A's shutdown handler then deletes the file unconditionally, it
 * deletes B's record, not its own. Checking ownership first closes that
 * window; when `expectedPid` is omitted the old unconditional behavior
 * applies, for callers that have already established they own the file.
 */
export function removeInstanceFile(uassistDir: string, expectedPid?: number): void {
  const path = join(uassistDir, INSTANCE_FILE);
  try {
    if (expectedPid !== undefined) {
      const current = readInstanceFile(uassistDir);
      if (current && current.pid !== expectedPid) return;
    }
    rmSync(path, { force: true });
  } catch {
    // Nothing to do; a leftover file is harmless because it is never trusted
    // on its own.
  }
}

/** Ask whatever is on this port to identify itself. */
export async function probeInstance(
  port: number,
  timeoutMs = 700,
): Promise<Instance | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/instance`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const value: unknown = await res.json();
    return isInstance(value) ? value : undefined;
  } catch {
    // Connection refused, timeout, non-JSON body, or something that is simply
    // not us. All mean "cannot confirm", which means "do not kill".
    return undefined;
  }
}
