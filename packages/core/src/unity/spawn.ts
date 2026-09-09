/**
 * Shared Unity batch-mode process discipline — every batch-mode invocation
 * (headless project creation in bootstrap.ts, the compile check in verify.ts)
 * needs the identical spawn/timeout/capture treatment, so it lives once here.
 *
 * `-logFile -` streams Unity's log to stdout instead of a file — verified
 * against this machine's real Unity 6000.4.10f1 install rather than assumed
 * from documentation.
 */

export interface UnityBatchResult {
  exitCode: number;
  timedOut: boolean;
  combinedLog: string;
}

export interface RunUnityBatchOptions {
  unityBinary: string;
  /** Args after -batchmode -nographics -logFile - ; callers add whatever
   *  the specific operation needs (-createProject, -projectPath, etc). */
  args: string[];
  timeoutMs?: number;
}

/**
 * Read a stream chunk by chunk, each individual read bounded by a shared
 * deadline, rather than waiting on `Response(stream).text()` for one final
 * EOF that may never come. If Unity (or a subprocess it spawned — its
 * licensing-client helper is a real one, seen in this project's own captured
 * logs) leaves an orphaned grandchild holding the pipe open after the parent
 * we actually killed has already exited, the pipe never reaches EOF and
 * `.text()` would hang forever. Reading incrementally means a hang loses
 * only whatever arrives *after* the deadline, not everything captured before
 * it — the output from right before a hang is exactly the most useful
 * diagnostic content to keep.
 */
async function readWithDeadline(
  stream: ReadableStream<Uint8Array> | null,
  deadline: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true }), Math.max(0, deadline - Date.now())),
      );
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

export async function runUnityBatch(options: RunUnityBatchOptions): Promise<UnityBatchResult> {
  const proc = Bun.spawn({
    cmd: [options.unityBinary, "-batchmode", "-nographics", "-logFile", "-", ...options.args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.kill();
    },
    options.timeoutMs ?? 5 * 60_000,
  );
  timer.unref?.();

  // proc.exited tracks the direct child via waitpid and resolves on kill
  // regardless of any subprocess it spawned — a hung grandchild cannot block
  // this. Stream collection is bounded separately, below.
  const exitCode = await proc.exited;
  clearTimeout(timer);

  // A short grace window past exit for the streams to actually deliver their
  // already-buffered content and close naturally — generous for the normal
  // case (data is already sitting in the pipe the instant the process
  // exits), bounded for the orphaned-grandchild case.
  const deadline = Date.now() + 3000;
  const [stdout, stderr] = await Promise.all([
    readWithDeadline(proc.stdout as ReadableStream<Uint8Array> | null, deadline),
    readWithDeadline(proc.stderr as ReadableStream<Uint8Array> | null, deadline),
  ]);

  return { exitCode, timedOut, combinedLog: `${stdout}\n${stderr}`.trim() };
}

/** Last N lines — enough to diagnose a failure without keeping a whole
 *  (often large) batch-mode log in memory. */
export function logTail(log: string, lines = 60): string {
  return log.split("\n").slice(-lines).join("\n");
}

/**
 * "Unity not found," "no license," "batch mode exited 1" are three different
 * problems — automation-spec.md Part VIII names this exact rule. Verified
 * against this machine's real license-less Hub install: batch-mode Unity
 * fails fast (not a hang) with "No valid Unity Editor license found" in the
 * log, distinctly different from any other non-zero exit.
 */
export function isLicenseFailure(log: string): boolean {
  return /no valid unity editor license/i.test(log) || /licensing.*(error|failed)/i.test(log);
}
