/**
 * Unity Editor discovery and headless project creation.
 *
 * See design/automation-spec.md Part I, "Headless — UAssist creates the Unity
 * project directly." Binary discovery reads a real directory layout rather
 * than shelling out to `which` or relying on PATH, since Unity Hub installs
 * are versioned and never put on PATH by default.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

import { validateUnityPath } from "../workspace/scan.ts";
import type { WorkspaceLinkStatus } from "../workspace/types.ts";
import { isLicenseFailure, logTail, runUnityBatch } from "./spawn.ts";

/**
 * `node:path`'s plain `join` always uses the *host* OS's separator — join()
 * on this macOS/Linux dev machine produces forward slashes even when the
 * path being built is meant to describe a Windows layout. That is fine for
 * paths this process will actually use (host and target platform are always
 * the same at runtime), but wrong for constructing a path *string* to
 * describe a different platform, which only happens in tests exercising the
 * Windows/Linux branches from a macOS runner. `path.win32`/`path.posix` join
 * with the right separator regardless of what's actually running the code.
 */
function joinFor(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : posix.join(...segments);
}

export interface UnityInstall {
  version: string;
  path: string;
}

/** Where Unity Hub installs editors, per platform. Not itself a check that
 *  anything is actually there — callers combine this with a readdir. */
export function hubEditorRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  switch (platform) {
    case "darwin":
      return "/Applications/Unity/Hub/Editor";
    case "win32":
      return env["ProgramFiles"] ? joinFor(platform, env["ProgramFiles"], "Unity", "Hub", "Editor") : undefined;
    case "linux":
      return env["HOME"] ? joinFor(platform, env["HOME"], "Unity", "Hub", "Editor") : undefined;
    default:
      return undefined;
  }
}

function binaryPathForVersion(editorRoot: string, version: string, platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return joinFor(platform, editorRoot, version, "Unity.app", "Contents", "MacOS", "Unity");
    case "win32":
      return joinFor(platform, editorRoot, version, "Editor", "Unity.exe");
    default:
      return joinFor(platform, editorRoot, version, "Editor", "Unity");
  }
}

/**
 * Every Unity version Hub has installed, newest-looking version first. A
 * version directory with no binary inside it (a partial or corrupted
 * install) is silently skipped rather than offered as a false option.
 */
export function listInstalledUnityVersions(
  editorRoot: string | undefined = hubEditorRoot(),
  platform: NodeJS.Platform = process.platform,
): UnityInstall[] {
  if (!editorRoot || !existsSync(editorRoot)) return [];
  const installs: UnityInstall[] = [];
  for (const name of readdirSync(editorRoot)) {
    const path = binaryPathForVersion(editorRoot, name, platform);
    if (existsSync(path)) installs.push({ version: name, path });
  }
  return installs.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export interface FindUnityOptions {
  explicitPath?: string;
  preferredVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Override where the Hub search looks — real callers never set this; it
   *  exists so the search is testable against a fake install layout instead
   *  of whatever Unity happens to be on the machine running the tests. */
  editorRoot?: string;
  platform?: NodeJS.Platform;
}

/**
 * Resolve a Unity binary to run: an explicit path wins outright, then
 * `UNITY_PATH`, then the newest (or a preferred) Hub install. Returns
 * undefined rather than guessing — a caller that gets nothing back should
 * say "Unity not found," not fail two steps later with a confusing spawn error.
 */
export function findUnityBinary(options: FindUnityOptions = {}): string | undefined {
  if (options.explicitPath && existsSync(options.explicitPath)) return options.explicitPath;

  const env = options.env ?? process.env;
  const envPath = env["UNITY_PATH"];
  if (envPath && existsSync(envPath)) return envPath;

  const platform = options.platform ?? process.platform;
  const editorRoot = options.editorRoot ?? hubEditorRoot(platform, env);
  const installs = listInstalledUnityVersions(editorRoot, platform);
  if (installs.length === 0) return undefined;
  if (options.preferredVersion) {
    const match = installs.find((i) => i.version === options.preferredVersion);
    if (match) return match.path;
  }
  return installs[0]!.path;
}

export interface HeadlessCreateOptions {
  unityBinary: string;
  targetPath: string;
  /** Default 5 minutes — batch-mode Unity creating a fresh project is slow
   *  the first time (importing default packages) but should not run forever;
   *  a hung process here is almost always a license-activation prompt with
   *  no one to answer it. */
  timeoutMs?: number;
}

/**
 * "Unity not found," "no license," "batch mode exited 1" are three different
 * problems — automation-spec.md Part VIII names this exact rule. A bare exit
 * code tells a person nothing actionable; Unity's own log text does, so this
 * checks the signal `isLicenseFailure` already established (verified against
 * this machine's own Unity 6000.4.10f1: batch-mode fails fast — not a hang —
 * exiting non-zero with "No valid Unity Editor license found" in the log)
 * before falling back to a generic message that still includes the exit code
 * and the log tail.
 */
export function diagnoseFailure(exitCode: number, log: string): string {
  if (isLicenseFailure(log)) {
    return (
      `Unity exited ${exitCode}: no valid Unity Editor license found. ` +
      `Open Unity Hub and activate a license (Personal is enough) for this install, then retry — ` +
      `or use --unity-mode task instead, which needs no local Unity install at all.`
    );
  }
  return `Unity exited with code ${exitCode}. Last output:\n${log.split("\n").slice(-15).join("\n")}`;
}

export interface HeadlessCreateResult {
  success: boolean;
  exitCode?: number;
  /** Last ~60 lines of combined stdout/stderr — enough to diagnose a failure
   *  without keeping the whole (often large) batch-mode log in memory. */
  logTail: string;
  error?: string;
  validation?: WorkspaceLinkStatus;
}

/**
 * Run `Unity -batchmode -createProject <path> -quit` and confirm the result
 * with the same `validateUnityPath` the rest of the system trusts — a zero
 * exit code alone is not proof; Unity can exit 0 having done less than asked.
 */
export async function createUnityProjectHeadless(
  options: HeadlessCreateOptions,
): Promise<HeadlessCreateResult> {
  mkdirSync(dirname(options.targetPath), { recursive: true });

  const { exitCode, timedOut, combinedLog } = await runUnityBatch({
    unityBinary: options.unityBinary,
    args: ["-createProject", options.targetPath, "-quit"],
    timeoutMs: options.timeoutMs,
  });
  const tail = logTail(combinedLog);

  if (timedOut) {
    return {
      success: false,
      logTail: tail,
      error:
        "Unity did not exit within the timeout — most likely waiting on a license activation prompt with no one to answer it. Open Unity Hub once to complete activation, then retry.",
    };
  }
  if (exitCode !== 0) {
    return { success: false, exitCode, logTail: tail, error: diagnoseFailure(exitCode, combinedLog) };
  }

  const validation = validateUnityPath(options.targetPath);
  if (!validation.valid) {
    return {
      success: false,
      exitCode,
      logTail: tail,
      validation,
      error: `Unity exited 0 but the result does not look like a valid project: ${validation.reason}`,
    };
  }

  return { success: true, exitCode, logTail: tail, validation };
}
