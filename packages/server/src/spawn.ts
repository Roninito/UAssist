/**
 * Spawning a `uassist-server` process for a project.
 *
 * Shared by `uassist start` (the CLI) and a running server's own "start
 * another project" endpoint (the web UI's multi-project registry, see
 * project.ts's registry section) — both need the exact same answer to
 * "how do I launch a server for a different project root," so this is the
 * one place that answer lives.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class ServerBinaryNotFoundError extends Error {}

/**
 * A compiled `uassist`/`uassist-server` looks for its sibling next to its
 * own executable path (the install script places both together) — this is
 * what makes starting a server work from a global install with no source
 * tree or dev-time `bun run` anywhere in sight. Running from source in this
 * checkout falls back to this module's own on-disk location, which is how
 * a running (dev-mode) server can spawn another project's server too.
 */
export function resolveServerCommand(): string[] {
  const exeName = process.platform === "win32" ? "uassist-server.exe" : "uassist-server";
  const compiled = join(dirname(process.execPath), exeName);
  if (existsSync(compiled)) return [compiled];

  const devEntry = join(import.meta.dir, "index.ts");
  if (existsSync(devEntry)) return [process.execPath, "run", devEntry];

  throw new ServerBinaryNotFoundError(
    `could not find a uassist-server binary next to ${process.execPath}, and no dev checkout at ${devEntry}. ` +
      `Build one with \`bun run build:server\`.`,
  );
}

export interface SpawnServerOptions {
  root: string;
  port?: number;
  /** Raw fd for stdout/stderr — "ignore" when the caller doesn't want a log file. */
  stdio?: number | "ignore";
}

/** Spawn a detached server process for `root`. Never awaited to completion — the
 *  caller decides how (or whether) to confirm it actually came up. */
export function spawnServer(options: SpawnServerOptions): Bun.Subprocess {
  const [cmd, ...baseArgs] = resolveServerCommand();
  const args = [...baseArgs, "--root", options.root];
  if (options.port !== undefined) args.push("--port", String(options.port));

  const stdio = options.stdio ?? "ignore";
  const proc = Bun.spawn([cmd!, ...args], {
    cwd: options.root,
    stdio: ["ignore", stdio, stdio],
    env: process.env,
  });
  proc.unref();
  return proc;
}
