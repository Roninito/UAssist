import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUnityCompileCheck } from "../src/unity/verify.ts";

/**
 * The synthetic log excerpts below use the standard Roslyn/mono `error
 * CS####:` diagnostic format — the underlying C# compiler's own output
 * shape, not a Unity-specific or invented convention, and stable across
 * Unity versions for exactly that reason. This machine's real Unity install
 * has no activated license (verified in the headless-bootstrap tests, and
 * again live below), so it cannot be used to capture a genuine end-to-end
 * compile-error log; the license-failure branch below IS tested against a
 * real spawned Unity process, and IS the actual failure mode this install
 * can currently produce.
 */
const CLEAN_COMPILE_LOG = `
[Package Manager] Resolving packages...
[Package Manager] Done resolving packages in 0.42 seconds
Refreshing native plugins compatible for Editor in 12.34 ms, found 3 plugins.
Reloading assemblies after fresh import
[Project] Loading completed in 3.201 seconds
Exiting batchmode successfully now!`;

const COMPILE_ERROR_LOG = `
[Package Manager] Resolving packages...
Assets/Scripts/AmmoDatabase.cs(14,23): error CS1002: ; expected
Assets/Scripts/AmmoDatabase.cs(22,5): error CS0246: The type or namespace name 'ElectricAmmo' could not be found
Compilation failed: 2 errors, 0 warnings
Aborting batchmode due to failure:
error CS1002: ; expected`;

const REAL_LICENSE_FAILURE_LOG = `
[Licensing::Module] Licensing is not yet initialized.
[Licensing::Module] Error: Access token is unavailable; failed to update
No valid Unity Editor license found. Please activate your license.
[Package Manager] Server process was shutdown`;

/** A fake "Unity binary" that just echoes canned output and exits with a
 *  given code — proves runUnityCompileCheck's parsing against a real
 *  subprocess round-trip, not a mocked function call. */
function fakeUnityScript(dir: string, log: string, exitCode: number): string {
  const path = join(dir, "fake-unity.sh");
  // -logFile - is passed by runUnityBatch; the fake script ignores its args
  // and just prints the canned log, matching how a real Unity invocation's
  // output would arrive on this process's stdout.
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${log}\nEOF\nexit ${exitCode}\n`, { mode: 0o755 });
  return path;
}

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-unity-verify-"));
  dirs.push(d);
  return d;
}

describe("runUnityCompileCheck — against a fake Unity binary (real subprocess, canned output)", () => {
  test("a clean compile with exit 0 and no CS errors reports compiled: true", async () => {
    const dir = scratch();
    const bin = fakeUnityScript(dir, CLEAN_COMPILE_LOG, 0);
    const result = await runUnityCompileCheck({ unityBinary: bin, projectPath: dir });

    expect(result.compiled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.licenseFailed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("real CS compiler errors are extracted, not just detected as a failure", async () => {
    const dir = scratch();
    const bin = fakeUnityScript(dir, COMPILE_ERROR_LOG, 1);
    const result = await runUnityCompileCheck({ unityBinary: bin, projectPath: dir });

    expect(result.compiled).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.includes("CS1002"))).toBe(true);
    expect(result.errors.some((e) => e.includes("CS0246") && e.includes("ElectricAmmo"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a license failure is reported distinctly from a real compile failure", async () => {
    const dir = scratch();
    const bin = fakeUnityScript(dir, REAL_LICENSE_FAILURE_LOG, 198);
    const result = await runUnityCompileCheck({ unityBinary: bin, projectPath: dir });

    expect(result.compiled).toBe(false);
    expect(result.licenseFailed).toBe(true);
    expect(result.errors).toEqual([]); // never reached the compile step, so no CS errors either
    rmSync(dir, { recursive: true, force: true });
  });

  test("exit 0 but with CS errors in the log (a version that doesn't fail its own exit code) is still caught", async () => {
    const dir = scratch();
    const bin = fakeUnityScript(dir, COMPILE_ERROR_LOG, 0);
    const result = await runUnityCompileCheck({ unityBinary: bin, projectPath: dir });

    expect(result.compiled).toBe(false); // exit code alone is not proof — the doc string says this explicitly
    expect(result.errors.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hung process is killed at the timeout and reported as timedOut, not left running", async () => {
    const dir = scratch();
    const bin = join(dir, "hang.sh");
    // A shell wrapping `sleep` — not `exec sleep`, so `sleep` runs as a
    // grandchild and outlives the shell being killed. This is deliberately
    // the harder case: it also exercises the readWithDeadline grace period
    // (a held-open stdout pipe from the orphaned grandchild), not just the
    // kill-on-timeout path.
    writeFileSync(bin, `#!/bin/sh\nsleep 30\n`, { mode: 0o755 });

    const start = Date.now();
    const result = await runUnityCompileCheck({ unityBinary: bin, projectPath: dir, timeoutMs: 300 });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.compiled).toBe(false);
    // 300ms to kill + up to a 3s stream-read grace period (see spawn.ts) —
    // bounded, not hung, which is the actual property under test.
    expect(elapsed).toBeLessThan(5000);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Live, against the real installed Unity — when present. Confirms the actual
// end-to-end wiring (spawn, -logFile -, license detection) works against a
// genuine Unity binary, not just a stand-in script. Skips cleanly where no
// Unity install exists (most CI/dev machines).
// ---------------------------------------------------------------------------

const REAL_UNITY = "/Applications/Unity/Hub/Editor/6000.4.10f1/Unity.app/Contents/MacOS/Unity";

describe.skipIf(!existsSync(REAL_UNITY))("runUnityCompileCheck — live against a real Unity install", () => {
  test("a real Unity binary with no license fails fast and is reported as licenseFailed, not a hang", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "Assets"), { recursive: true });
    mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
    writeFileSync(
      join(dir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.4.10f1\nm_EditorVersionWithRevision: 6000.4.10f1 (0000000000)\n",
      "utf8",
    );

    const start = Date.now();
    const result = await runUnityCompileCheck({ unityBinary: REAL_UNITY, projectPath: dir, timeoutMs: 60_000 });
    const elapsed = Date.now() - start;

    expect(result.licenseFailed).toBe(true);
    expect(result.compiled).toBe(false);
    expect(result.timedOut).toBe(false); // fails fast on this machine, confirmed — not a license-prompt hang
    expect(elapsed).toBeLessThan(30_000);

    rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});
