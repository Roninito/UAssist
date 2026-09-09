/**
 * Periodic scan scheduling.
 *
 * `isScanDue` is pure decision logic — no timer, no I/O — so the "should a
 * scan run right now" question is testable without waiting on a real clock.
 * `runScheduledScan` does the actual work for one tick, reusing
 * scanAndReconcile so a scheduled scan behaves identically to a manual one.
 * `startScanScheduler` is the only part that touches setInterval.
 *
 * "On by default, not a thing to remember to turn on" — see
 * design/automation-spec.md Part III and DEFAULT_SCAN_SCHEDULE in types.ts.
 */

import { scanAndReconcile } from "./reconcile.ts";
import type { Store } from "./store.ts";
import { DEFAULT_SCAN_SCHEDULE } from "./types.ts";
import type { ScanScheduleConfig } from "./types.ts";
import { validateBlenderPath, validateUnityPath } from "./workspace/scan.ts";
import type { WorkspaceSource } from "./workspace/types.ts";

/** Whether a scan should run now, given when the last one ran. Pure — no clock reads of its own. */
export function isScanDue(
  config: ScanScheduleConfig | undefined,
  lastScannedAt: number | undefined,
  now: number,
): boolean {
  const schedule = config ?? DEFAULT_SCAN_SCHEDULE;
  if (!schedule.enabled) return false;
  if (lastScannedAt === undefined) return true;
  const intervalMs = Math.max(1, schedule.intervalMinutes) * 60_000;
  return now - lastScannedAt >= intervalMs;
}

export interface ScheduledScanResult {
  source: WorkspaceSource;
  assetCount: number;
  proposedCount: number;
}

/**
 * Run a scan for whichever linked, validly-pathed engines are due — empty
 * if there is no project, nothing is due, or nothing is validly linked yet
 * (an incomplete workspace is not an error here; see isWorkspaceComplete).
 */
export function runScheduledScan(store: Store): ScheduledScanResult[] {
  const project = store.getProject();
  if (!project) return [];
  if (!isScanDue(project.scanSchedule, project.workspaceScannedAt, Date.now())) return [];

  const results: ScheduledScanResult[] = [];

  if (project.unityProjectPath && validateUnityPath(project.unityProjectPath).valid) {
    const { assets, proposed } = scanAndReconcile(store, "unity", project.unityProjectPath);
    results.push({ source: "unity", assetCount: assets.length, proposedCount: proposed.length });
  }
  if (project.blenderSourcePath && validateBlenderPath(project.blenderSourcePath).valid) {
    const { assets, proposed } = scanAndReconcile(store, "blender", project.blenderSourcePath);
    results.push({ source: "blender", assetCount: assets.length, proposedCount: proposed.length });
  }

  if (results.length > 0) {
    // Re-read: scanAndReconcile does not touch the project row itself, and a
    // second engine's scan above must not stamp over the first's other
    // fields with a stale in-memory copy.
    const current = store.getProject()!;
    store.putProject({ ...current, workspaceScannedAt: Date.now() });
  }

  return results;
}

export interface SchedulerHandle {
  stop(): void;
}

export interface ScanSchedulerOptions {
  onResult?: (results: ScheduledScanResult[]) => void;
  onError?: (err: unknown) => void;
  /**
   * Fires every tick, whether or not a scan actually ran — unlike
   * `onResult`, which only fires when `runScheduledScan` returns something.
   * A project with *nothing* linked never produces a scan result at all, so
   * anything that must keep checking regardless (workspace-completeness
   * validation, self-healing setup cards) belongs here, not in `onResult`.
   */
  onTick?: () => void | Promise<void>;
  /** How often to check whether a scan is due. Default 60s — isScanDue is
   *  what actually gates the (much less frequent) real work. */
  tickMs?: number;
}

/**
 * Wire runScheduledScan into a real timer.
 *
 * The scan itself is synchronous (workspace/scan.ts walks the filesystem
 * with sync fs calls), so a JS event loop tick can never truly overlap
 * another — but the guard costs nothing and keeps this correct if that ever
 * changes.
 */
export function startScanScheduler(store: Store, options: ScanSchedulerOptions = {}): SchedulerHandle {
  let running = false;
  const tickMs = options.tickMs ?? 60_000;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    (async () => {
      try {
        const results = runScheduledScan(store);
        if (results.length > 0) options.onResult?.(results);
        await options.onTick?.();
      } catch (err) {
        options.onError?.(err);
      } finally {
        running = false;
      }
    })();
  }, tickMs);

  // A background scan schedule should never be the thing keeping the
  // process alive — only a live request/response or an explicit stop() should.
  if (typeof timer.unref === "function") timer.unref();

  return { stop: () => clearInterval(timer) };
}
