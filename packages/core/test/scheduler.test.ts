import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject, Store } from "../src/store.ts";
import { isScanDue, runScheduledScan, startScanScheduler } from "../src/scheduler.ts";
import type { ScanScheduleConfig } from "../src/types.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-scheduler-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, relPath: string, content = ""): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const ENABLED_15: ScanScheduleConfig = { enabled: true, intervalMinutes: 15 };

describe("isScanDue", () => {
  const NOW = 1_000_000_000;

  test("never scanned before is always due", () => {
    expect(isScanDue(ENABLED_15, undefined, NOW)).toBe(true);
  });

  test("disabled is never due, no matter how stale", () => {
    expect(isScanDue({ enabled: false, intervalMinutes: 1 }, NOW - 10_000_000, NOW)).toBe(false);
  });

  test("within the interval is not due", () => {
    const lastScannedAt = NOW - 5 * 60_000; // 5 minutes ago
    expect(isScanDue(ENABLED_15, lastScannedAt, NOW)).toBe(false);
  });

  test("past the interval is due", () => {
    const lastScannedAt = NOW - 20 * 60_000; // 20 minutes ago
    expect(isScanDue(ENABLED_15, lastScannedAt, NOW)).toBe(true);
  });

  test("exactly at the interval boundary is due", () => {
    const lastScannedAt = NOW - 15 * 60_000;
    expect(isScanDue(ENABLED_15, lastScannedAt, NOW)).toBe(true);
  });

  test("undefined config falls back to the documented default (enabled, 15min)", () => {
    expect(isScanDue(undefined, NOW - 20 * 60_000, NOW)).toBe(true);
    expect(isScanDue(undefined, NOW - 5 * 60_000, NOW)).toBe(false);
  });
});

describe("runScheduledScan", () => {
  test("no project — nothing happens", () => {
    const root = scratch();
    mkdirSync(join(root, ".uassist"), { recursive: true });
    // A directory that looks like a project dir but has no project row yet:
    // exercise via a fresh store without calling initProject.
    const store = new Store(root, { mirrorDebounceMs: 0 });
    expect(runScheduledScan(store)).toEqual([]);
    store.close();
  });

  test("nothing linked — nothing happens even though a scan is due", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    expect(runScheduledScan(store)).toEqual([]);
    store.close();
  });

  test("not due yet — no scan runs even with a valid link", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const unityRoot = scratch();
    mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
    write(unityRoot, "Assets/Foo.cs", "class Foo {}");

    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot, workspaceScannedAt: Date.now() });

    expect(runScheduledScan(store)).toEqual([]);
    store.close();
  });

  test("due and linked — scans, reconciles, and stamps workspaceScannedAt", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const unityRoot = scratch();
    mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
    write(unityRoot, "Assets/Prefabs/Grunt.prefab", "%YAML 1.1\n--- fake\n");

    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot }); // never scanned -> due

    const results = runScheduledScan(store);
    expect(results).toEqual([{ source: "unity", assetCount: 1, proposedCount: 1 }]);
    expect(store.listSuggestions()).toHaveLength(1);
    expect(store.getProject()!.workspaceScannedAt).toBeDefined();
    store.close();
  });

  test("scanning both engines preserves the other engine's link on the stamped write", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const unityRoot = scratch();
    mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
    write(unityRoot, "Assets/Foo.cs", "class Foo {}");
    const blenderRoot = scratch();
    write(blenderRoot, "scene.blend", "fake");

    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot, blenderSourcePath: blenderRoot });

    const results = runScheduledScan(store);
    expect(results.map((r) => r.source).sort()).toEqual(["blender", "unity"]);
    const after = store.getProject()!;
    expect(after.unityProjectPath).toBe(unityRoot);
    expect(after.blenderSourcePath).toBe(blenderRoot);
    store.close();
  });
});

describe("startScanScheduler", () => {
  test("fires onResult once a due scan is found, on a fast tick", async () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const unityRoot = scratch();
    mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
    write(unityRoot, "Assets/Prefabs/Grunt.prefab", "%YAML 1.1\n--- fake\n");
    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot });

    const seen: unknown[] = [];
    const handle = startScanScheduler(store, { tickMs: 10, onResult: (r) => seen.push(r) });

    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.stop();

    expect(seen.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test("stop() prevents further ticks", async () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    let calls = 0;
    const handle = startScanScheduler(store, { tickMs: 10, onResult: () => calls++ });
    handle.stop();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(0);
    store.close();
  });

  test("onTick fires every tick even when nothing is linked to scan (no onResult at all)", async () => {
    const root = scratch();
    const { store } = initProject(root, "Test"); // nothing linked — runScheduledScan returns []

    let resultCalls = 0;
    let tickCalls = 0;
    const handle = startScanScheduler(store, {
      tickMs: 10,
      onResult: () => resultCalls++,
      onTick: () => {
        tickCalls++;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.stop();

    expect(resultCalls).toBe(0);
    expect(tickCalls).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test("the overlap guard covers an async onTick too", async () => {
    const root = scratch();
    const { store } = initProject(root, "Test");

    let concurrent = 0;
    let maxConcurrent = 0;
    const handle = startScanScheduler(store, {
      tickMs: 5,
      onTick: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrent--;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.stop();

    expect(maxConcurrent).toBe(1);
    store.close();
  });
});
