import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BLENDER_SETUP_TITLE,
  bootstrapProject,
  createBlenderSetupCard,
  createUnitySetupCard,
  ensureWorkspaceSetupCards,
  isWorkspaceComplete,
  UNITY_SETUP_TITLE,
} from "../src/bootstrap.ts";
import { registryPath } from "../src/registry.ts";
import { initProject } from "../src/store.ts";
import type { Project } from "../src/types.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-bootstrap-"));
  dirs.push(d);
  return d;
}
/** A throwaway "home" for the machine registry, so `bootstrapProject` — which
 *  always registers the project — never touches the real ~/.uassist/registry.json. */
function fakeHome(): string {
  return scratch();
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeUnityProject(root: string): string {
  const path = join(root, "unity-src");
  mkdirSync(join(path, "Assets"), { recursive: true });
  mkdirSync(join(path, "ProjectSettings"), { recursive: true });
  return path;
}

function fakeBlenderDir(root: string): string {
  const path = join(root, "blender-src");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "scene.blend"), "fake blend binary", "utf8");
  return path;
}

function baseProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: "project_x" as never,
    name: "Test",
    rootPath: "/tmp/x",
    conventions: [],
    dailyCapUsd: 10,
    totalCapUsd: 200,
    aiConfig: {
      providers: [],
      systemPrompt: "",
      maxContextMessages: 50,
      maxTokens: 4096,
      temperature: 0.7,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("isWorkspaceComplete", () => {
  test("false with neither engine linked", () => {
    expect(isWorkspaceComplete(baseProject())).toBe(false);
  });

  test("true with only Unity validly linked", () => {
    const root = scratch();
    const unity = fakeUnityProject(root);
    expect(isWorkspaceComplete(baseProject({ unityProjectPath: unity }))).toBe(true);
  });

  test("true with only Blender validly linked — neither engine is required over the other", () => {
    const root = scratch();
    const blender = fakeBlenderDir(root);
    expect(isWorkspaceComplete(baseProject({ blenderSourcePath: blender }))).toBe(true);
  });

  test("false when the linked path no longer validates — a stale link is not completion", () => {
    const root = scratch();
    const unity = fakeUnityProject(root);
    rmSync(join(unity, "Assets"), { recursive: true, force: true });
    expect(isWorkspaceComplete(baseProject({ unityProjectPath: unity }))).toBe(false);
  });
});

describe("setup cards", () => {
  test("the Unity setup card is a blocker-priority, milestone-less Infra task with checkable acceptance", () => {
    const card = createUnitySetupCard();
    expect(card.kind).toBe("task");
    expect(card.category).toBe("Infra");
    expect(card.priority).toBe("blocker");
    expect(card.milestoneId).toBeUndefined();
    expect(card.acceptance.length).toBeGreaterThan(0);
    expect(card.acceptance.every((a) => !a.met)).toBe(true);
    expect(card.description).toContain("URP");
  });

  test("the Blender setup card names the actual completion condition", () => {
    const card = createBlenderSetupCard();
    expect(card.description).toContain(".blend");
    expect(card.acceptance.some((a) => a.text.includes(".blend"))).toBe(true);
  });
});

describe("bootstrapProject — existing-path mode", () => {
  test("linking a valid Unity path scans it immediately, with no separate step", async () => {
    const root = scratch();
    const unity = fakeUnityProject(root);
    writeFileSync(join(unity, "Assets", "Player.cs"), "class Player {}", "utf8");

    const result = await bootstrapProject({
      root,
      name: "BootstrapTest",
      unity: { mode: "existing", path: unity },
      registryHome: fakeHome(),
    });

    expect(result.unity?.linked).toBe(true);
    expect(result.workspaceComplete).toBe(true);
    expect(result.project.workspaceScannedAt).toBeDefined();

    const { total } = result.store.workspaceAssetCounts();
    expect(total).toBeGreaterThan(0); // the scan actually ran, not just a flag flip

    result.store.close();
  });

  test("an invalid Unity path is reported, not silently accepted", async () => {
    const root = scratch();
    const result = await bootstrapProject({
      root,
      name: "BootstrapTest2",
      unity: { mode: "existing", path: join(root, "not-a-real-unity-project") },
      registryHome: fakeHome(),
    });

    expect(result.unity?.linked).toBe(false);
    expect(result.unity?.error).toBeTruthy();
    expect(result.workspaceComplete).toBe(false);

    result.store.close();
  });

  test("linking both engines at once: workspaceComplete from either", async () => {
    const root = scratch();
    const unity = fakeUnityProject(root);
    const blender = fakeBlenderDir(root);

    const result = await bootstrapProject({
      root,
      name: "BootstrapTest3",
      unity: { mode: "existing", path: unity },
      blender: { mode: "existing", path: blender },
      registryHome: fakeHome(),
    });

    expect(result.unity?.linked).toBe(true);
    expect(result.blender?.linked).toBe(true);
    expect(result.workspaceComplete).toBe(true);

    result.store.close();
  });
});

describe("bootstrapProject — task mode", () => {
  test("with no workspace choice given, the project is left incomplete with no setup card — a caller that asks for nothing gets nothing invented", async () => {
    const root = scratch();
    const result = await bootstrapProject({ root, name: "BootstrapTest4", registryHome: fakeHome() });

    expect(result.setupCards).toHaveLength(0);
    expect(result.workspaceComplete).toBe(false);

    result.store.close();
  });

  test("task mode creates a real, dispatchable card and leaves the project honestly incomplete", async () => {
    const root = scratch();
    const result = await bootstrapProject({
      root,
      name: "BootstrapTest5",
      unity: { mode: "task" },
      registryHome: fakeHome(),
    });

    expect(result.setupCards).toHaveLength(1);
    expect(result.setupCards[0]?.title).toContain("Unity");
    expect(result.unity?.linked).toBe(false);
    expect(result.workspaceComplete).toBe(false);

    // The card is real store state, not just returned in memory.
    const persisted = result.store.getCard(result.setupCards[0]!.id);
    expect(persisted).toBeDefined();

    result.store.close();
  });

  test("both engines in task mode produce two distinct setup cards", async () => {
    const root = scratch();
    const result = await bootstrapProject({
      root,
      name: "BootstrapTest6",
      unity: { mode: "task" },
      blender: { mode: "task" },
      registryHome: fakeHome(),
    });

    expect(result.setupCards).toHaveLength(2);
    expect(result.setupCards.map((c) => c.title).sort()).toEqual(
      ["Set up the Blender source directory", "Set up the Unity project"].sort(),
    );

    result.store.close();
  });
});

describe("bootstrapProject — registration", () => {
  test("a bootstrapped project registers itself in the machine registry — the given one, never the real one", async () => {
    const home = fakeHome();
    const root = scratch();

    const result = await bootstrapProject({ root, name: "RegistryTest", registryHome: home });

    const onDisk = JSON.parse(readFileSync(registryPath(home), "utf8"));
    expect(onDisk.projects.some((p: { root: string }) => p.root === root)).toBe(true);

    result.store.close();
  });
});

describe("ensureWorkspaceSetupCards", () => {
  test("creates both setup cards when nothing is linked at all", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const project = store.getProject()!;

    const created = ensureWorkspaceSetupCards(store, project);
    expect(created.map((c) => c.title).sort()).toEqual([BLENDER_SETUP_TITLE, UNITY_SETUP_TITLE].sort());
    expect(store.listCards().map((c) => c.title).sort()).toEqual([BLENDER_SETUP_TITLE, UNITY_SETUP_TITLE].sort());
    store.close();
  });

  test("is a no-op once either engine is genuinely linked", () => {
    const root = scratch();
    const unity = fakeUnityProject(root);
    const { store } = initProject(root, "Test");
    const project = { ...store.getProject()!, unityProjectPath: unity };

    const created = ensureWorkspaceSetupCards(store, project);
    expect(created).toHaveLength(0);
    expect(store.listCards()).toHaveLength(0);
    store.close();
  });

  test("does not duplicate an already-open setup card on a second call", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const project = store.getProject()!;

    ensureWorkspaceSetupCards(store, project);
    const second = ensureWorkspaceSetupCards(store, project);
    expect(second).toHaveLength(0);
    expect(store.listCards()).toHaveLength(2);
    store.close();
  });

  test("re-creates a setup card whose earlier copy was marked done without ever actually linking anything", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const project = store.getProject()!;

    const [first] = ensureWorkspaceSetupCards(store, project);
    store.putCard({ ...first!, status: "done" });

    // The card claims done, but isWorkspaceComplete says otherwise — the
    // validated filesystem state wins, not a card's own status field.
    const again = ensureWorkspaceSetupCards(store, project);
    expect(again.some((c) => c.title === first!.title)).toBe(true);
    store.close();
  });

  test("only tops up the missing one when a setup card was deleted but the workspace is still incomplete", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    const project = store.getProject()!;

    ensureWorkspaceSetupCards(store, project);
    const unityCard = store.listCards().find((c) => c.title === UNITY_SETUP_TITLE)!;
    store.deleteCard(unityCard.id);

    const created = ensureWorkspaceSetupCards(store, project);
    expect(created.map((c) => c.title)).toEqual([UNITY_SETUP_TITLE]);
    store.close();
  });
});
