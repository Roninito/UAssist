/**
 * Real Unity batch-mode compile verification.
 *
 * See design/automation-spec.md Part II: "a dispatched job's acceptance
 * check runs a real Unity batch-mode compile, not a guess from reading the
 * diff" — the "Four gates" doctrine (unity-colony-build-plan.md Part VI)
 * already insists on this: "C# compiles before it ships. No agent diff is
 * applied without a successful compile."
 *
 * Error extraction uses `error CS\d+:` — the standard Roslyn/mono C#
 * compiler diagnostic format, not a Unity-specific convention, and stable
 * across Unity versions because it is the underlying compiler's own output
 * shape. This machine's real Unity install could not be used to capture a
 * genuine compile-error log end to end (see the licensing note on
 * `isLicenseFailure` — this same install fails before ever reaching the
 * compile step), so the pattern is verified against the well-documented CS
 * error format rather than a captured example; `licenseFailed` on the result
 * distinguishes "never got to compile" from "compiled and failed."
 */

import { runUnityBatch, isLicenseFailure, logTail } from "./spawn.ts";

const CSHARP_ERROR_RE = /error CS\d+:.*/g;

export interface CompileCheckOptions {
  unityBinary: string;
  projectPath: string;
  /** Default 5 minutes — a full domain reload and compile of a real project
   *  can be slow the first time; unbounded is not an option (see
   *  createUnityProjectHeadless's identical reasoning). */
  timeoutMs?: number;
}

export interface CompileCheckResult {
  /** True only when Unity exited 0, reached the compile step at all (not
   *  blocked by licensing), and no `error CS` lines appeared. */
  compiled: boolean;
  errors: string[];
  exitCode?: number;
  timedOut: boolean;
  /** True when Unity never reached compilation because of licensing —
   *  distinct from a real compile failure, and from every other reason. */
  licenseFailed: boolean;
  logTail: string;
}

/**
 * Run `Unity -batchmode -projectPath <path> -quit` and report whether the
 * project actually compiled. This is the literal, harder-to-fool
 * verification the Four Gates doctrine asks for — not a read of the diff,
 * an actual compile.
 */
export async function runUnityCompileCheck(options: CompileCheckOptions): Promise<CompileCheckResult> {
  const { exitCode, timedOut, combinedLog } = await runUnityBatch({
    unityBinary: options.unityBinary,
    args: ["-projectPath", options.projectPath, "-quit"],
    timeoutMs: options.timeoutMs,
  });

  const tail = logTail(combinedLog);

  if (timedOut) {
    return { compiled: false, errors: [], timedOut: true, licenseFailed: false, logTail: tail };
  }

  const licenseFailed = isLicenseFailure(combinedLog);
  const errors = [...combinedLog.matchAll(CSHARP_ERROR_RE)].map((m) => m[0]!.trim());

  return {
    compiled: !licenseFailed && exitCode === 0 && errors.length === 0,
    errors,
    exitCode,
    timedOut: false,
    licenseFailed,
    logTail: tail,
  };
}
