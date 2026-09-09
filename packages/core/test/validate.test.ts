import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importPlan } from "../src/plan/import.ts";
import { scanAndReconcile } from "../src/reconcile.ts";
import { initProject, Store } from "../src/store.ts";
import {
  BROKEN_ANCHOR_SOURCE,
  checkBrokenAnchors,
  checkUnityCompiles,
  checkWorkspaceIncomplete,
  COMPILE_CHECK_SOURCE,
  runValidators,
  WORKSPACE_INCOMPLETE_SOURCE,
} from "../src/validate.ts";

/**
 * checkUnityCompiles reuses the exact fixture pattern
 * dispatch-compile-check.test.ts and unity-verify.test.ts already
 * established: a fake Unity binary (deterministic, no license
 * dependency) standing in for the real one via UNITY_PATH, so this exercises
 * validate.ts's own wiring — the configuration gate, the error-to-HealthItem
 * mapping, auto-close — not Unity itself.
 */

const dirs: string[] = [];
const originalUnityPath = process.env["UNITY_PATH"];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-validate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (originalUnityPath === undefined) delete process.env["UNITY_PATH"];
  else process.env["UNITY_PATH"] = originalUnityPath;
});

function write(root: string, relPath: string, content = ""): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function seeded(): { store: Store; unityRoot: string } {
  const projectRoot = scratch();
  const { store } = initProject(projectRoot, "Test");
  const unityRoot = scratch();
  mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
  return { store, unityRoot };
}

function fakeUnityBinary(dir: string, log: string, exitCode: number): string {
  const path = join(dir, "fake-unity.sh");
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${log}\nEOF\nexit ${exitCode}\n`, { mode: 0o755 });
  return path;
}

const CLEAN_LOG = `Reloading assemblies after fresh import\nExiting batchmode successfully now!`;
const ERROR_LOG = `Assets/Scripts/AmmoDatabase.cs(9,5): error CS1002: ; expected\nCompilation failed: 1 errors, 0 warnings`;
const LICENSE_LOG = `No valid Unity Editor license found. Please activate Unity with a valid license.`;

describe("checkWorkspaceIncomplete", () => {
  test("fires when nothing is linked at all", () => {
    const { store } = seeded();
    const { items, fingerprints } = checkWorkspaceIncomplete(store);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("blocker");
    expect(items[0]!.source).toBe(WORKSPACE_INCOMPLETE_SOURCE);
    expect(fingerprints.size).toBe(1);
    store.close();
  });

  test("is silent once either engine is genuinely linked", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Foo.cs", "class Foo {}");
    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot });

    expect(checkWorkspaceIncomplete(store).items).toHaveLength(0);
    store.close();
  });

  test("clears once linked, via runValidators' auto-close", async () => {
    const { store, unityRoot } = seeded();
    await runValidators(store, { includeCompileCheck: false });
    expect(store.listHealthItems().some((h) => h.source === WORKSPACE_INCOMPLETE_SOURCE)).toBe(true);

    write(unityRoot, "Assets/Foo.cs", "class Foo {}");
    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot });

    await runValidators(store, { includeCompileCheck: false });
    expect(store.listHealthItems().some((h) => h.source === WORKSPACE_INCOMPLETE_SOURCE)).toBe(false);
    store.close();
  });

  test("reopens if the link is removed again after having been complete", async () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Foo.cs", "class Foo {}");
    const project = store.getProject()!;
    store.putProject({ ...project, unityProjectPath: unityRoot });
    await runValidators(store, { includeCompileCheck: false });
    expect(store.listHealthItems().some((h) => h.source === WORKSPACE_INCOMPLETE_SOURCE)).toBe(false);

    store.putProject({ ...store.getProject()!, unityProjectPath: undefined });
    await runValidators(store, { includeCompileCheck: false });
    expect(store.listHealthItems().some((h) => h.source === WORKSPACE_INCOMPLETE_SOURCE)).toBe(true);
    store.close();
  });
});

describe("checkBrokenAnchors", () => {
  test("an anchored card whose target is in the catalog is clean", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" } });

    const { items } = checkBrokenAnchors(store);
    expect(items).toHaveLength(0);
    store.close();
  });

  test("an anchored card whose target was never scanned is flagged", () => {
    const { store, unityRoot } = seeded();
    void unityRoot;
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/DoesNotExist.cs" } });

    const { items, fingerprints } = checkBrokenAnchors(store);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe(BROKEN_ANCHOR_SOURCE);
    expect(items[0]!.severity).toBe("high");
    expect(items[0]!.cardId).toBe(card.id);
    expect(fingerprints.size).toBe(1);
    store.close();
  });

  test("clears itself once the file reappears in the catalog", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" } });

    expect(checkBrokenAnchors(store).items).toHaveLength(1);

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);

    expect(checkBrokenAnchors(store).items).toHaveLength(0);
    store.close();
  });

  test("a card with no anchor, or an anchor kind outside the catalog (commit, worktree), is never flagged", () => {
    const { store } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Untouched task.\n\n- Commit-anchored task.\n", "plan.md");
    const cards = store.listCards();
    const commitCard = cards.find((c) => c.title.includes("Commit-anchored"))!;
    store.putCard({ ...commitCard, anchor: { kind: "commit", sha: "deadbeef" } });

    expect(checkBrokenAnchors(store).items).toHaveLength(0);
    store.close();
  });

  test("a blenderObject anchor is checked at the .blend file level, not the object name", () => {
    const projectRoot = scratch();
    const { store } = initProject(projectRoot, "Test");
    const blenderRoot = scratch();
    write(blenderRoot, "sectors/corridor.blend", "fake blend binary");
    scanAndReconcile(store, "blender", blenderRoot);

    importPlan(store, "## Phase 0 — Corridor\n\n- Place the lamp.\n", "plan.md");
    const card = store.listCards()[0]!;
    store.putCard({
      ...card,
      anchor: { kind: "blenderObject", blendFile: "sectors/corridor.blend", objectName: "Lamp01" },
    });

    // The file exists; the object name inside it is unverifiable and not checked.
    expect(checkBrokenAnchors(store).items).toHaveLength(0);

    store.putCard({
      ...card,
      anchor: { kind: "blenderObject", blendFile: "sectors/missing.blend", objectName: "Lamp01" },
    });
    expect(checkBrokenAnchors(store).items).toHaveLength(1);
    store.close();
  });
});

describe("checkUnityCompiles", () => {
  function configureCliIntegration(store: Store, unityDir: string): void {
    const project = store.getProject()!;
    store.putProject({
      ...project,
      unityProjectPath: unityDir,
      engineIntegration: { unity: { method: "cli" } },
    });
  }

  test("a clean compile produces no items", async () => {
    const { store, unityRoot } = seeded();
    configureCliIntegration(store, unityRoot);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), CLEAN_LOG, 0);

    const { items, fingerprints } = await checkUnityCompiles(store);
    expect(items).toHaveLength(0);
    expect(fingerprints.size).toBe(0);
    store.close();
  });

  test("a compile failure produces one blocker HealthItem per CS error", async () => {
    const { store, unityRoot } = seeded();
    configureCliIntegration(store, unityRoot);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), ERROR_LOG, 1);

    const { items } = await checkUnityCompiles(store);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("blocker");
    expect(items[0]!.source).toBe(COMPILE_CHECK_SOURCE);
    expect(items[0]!.message).toContain("CS1002");
    store.close();
  });

  test("without CLI integration configured, this is a silent no-op — no Unity spawn", async () => {
    const { store, unityRoot } = seeded();
    void unityRoot;
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), ERROR_LOG, 1); // must never be consulted
    const { items } = await checkUnityCompiles(store);
    expect(items).toHaveLength(0);
    store.close();
  });

  test("a license failure is silent, not reported as a compile failure", async () => {
    const { store, unityRoot } = seeded();
    configureCliIntegration(store, unityRoot);
    process.env["UNITY_PATH"] = fakeUnityBinary(scratch(), LICENSE_LOG, 1);

    const { items } = await checkUnityCompiles(store);
    expect(items).toHaveLength(0);
    store.close();
  });
});

// These fixtures never link a workspace, so checkWorkspaceIncomplete also
// fires on every run alongside whatever a given test is actually about —
// filtered out below rather than assumed away.
function brokenAnchorOnly(items: { source: string }[]) {
  return items.filter((h) => h.source === BROKEN_ANCHOR_SOURCE);
}

describe("runValidators — orchestration and auto-close", () => {
  test("a fixed broken anchor auto-closes on the next run", async () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" } });

    const first = await runValidators(store);
    expect(brokenAnchorOnly(first.created)).toHaveLength(1);
    expect(brokenAnchorOnly(store.listHealthItems())).toHaveLength(1);

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);

    const second = await runValidators(store);
    expect(brokenAnchorOnly(second.created)).toHaveLength(0);
    expect(second.closed).toBeGreaterThanOrEqual(1);
    expect(brokenAnchorOnly(store.listHealthItems())).toHaveLength(0); // resolved items are excluded by default
    expect(brokenAnchorOnly(store.listHealthItems({ includeResolved: true }))).toHaveLength(1);
    store.close();
  });

  test("re-running with the same broken anchor does not duplicate the item", async () => {
    const { store } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" } });

    await runValidators(store);
    await runValidators(store);
    expect(brokenAnchorOnly(store.listHealthItems())).toHaveLength(1);
    store.close();
  });
});
