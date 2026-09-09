import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject, Store } from "../src/store.ts";
import { importPlan } from "../src/plan/import.ts";
import { applySuggestion, ApplySuggestionError, scanAndReconcile, SUSPICIOUS_SCAN_SOURCE } from "../src/reconcile.ts";
import type { AttachAnchorPayload, Card, CreateCardPayload, UpdateCardStatusPayload } from "../src/types.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-reconcile-"));
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

function seeded(): { store: Store; unityRoot: string } {
  const projectRoot = scratch();
  const { store } = initProject(projectRoot, "Test");
  const unityRoot = scratch();
  mkdirSync(join(unityRoot, "ProjectSettings"), { recursive: true });
  return { store, unityRoot };
}

describe("scanAndReconcile — create_card", () => {
  test("a brand new asset with nothing on the board proposes create_card", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Prefabs/EnemyGrunt.prefab", "%YAML 1.1\n--- fake\n");

    const { proposed, diff } = scanAndReconcile(store, "unity", unityRoot);

    expect(diff.added).toHaveLength(1);
    expect(proposed).toHaveLength(1);
    const s = proposed[0]!;
    expect(s.kind).toBe("create_card");
    expect(s.source).toBe("reconciliation");
    const payload = s.payload as unknown as CreateCardPayload;
    expect(payload.title).toBe("Enemy Grunt");
    expect(payload.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/EnemyGrunt.prefab" });
    store.close();
  });

  test("guesses a category from the asset kind", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Audio/alarm.wav", "RIFF....");

    const { proposed } = scanAndReconcile(store, "unity", unityRoot);
    const payload = proposed[0]!.payload as unknown as CreateCardPayload;
    expect(payload.category).toBe("Audio");
    store.close();
  });

  test("an unrecognised extension falls back to Unknown, not a guess", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Config/settings.json", "{}");

    const { proposed } = scanAndReconcile(store, "unity", unityRoot);
    const payload = proposed[0]!.payload as unknown as CreateCardPayload;
    expect(payload.category).toBe("Unknown");
    store.close();
  });

  test("running the same scan twice proposes nothing the second time", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Prefabs/EnemyGrunt.prefab", "%YAML 1.1\n--- fake\n");

    scanAndReconcile(store, "unity", unityRoot);
    const second = scanAndReconcile(store, "unity", unityRoot);

    expect(second.diff.added).toHaveLength(0);
    expect(second.proposed).toHaveLength(0);
    store.close();
  });

  test("a changed-but-not-moved asset is reported in the diff but proposes nothing", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/Foo.cs", "class Foo {}");
    scanAndReconcile(store, "unity", unityRoot);

    write(unityRoot, "Assets/Scripts/Foo.cs", "class Foo { void Bar() {} }");
    const { diff, proposed } = scanAndReconcile(store, "unity", unityRoot);

    expect(diff.changed).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(proposed).toHaveLength(0);
    store.close();
  });

  test("does not re-propose a create_card for an asset already accepted onto the board", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Prefabs/EnemyGrunt.prefab", "%YAML 1.1\n--- fake\n");
    const first = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;
    store.decideSuggestion(first.id, "accepted");

    // Nothing changed in the workspace, so there is no new diff to reconcile —
    // the accepted suggestion simply stays accepted.
    const second = scanAndReconcile(store, "unity", unityRoot);
    expect(second.proposed).toHaveLength(0);
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);
    store.close();
  });
});

describe("scanAndReconcile — attach_anchor to an anchor-less card", () => {
  test("a new asset matching an anchor-less card's title proposes attach_anchor, not create_card", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Enemy Grunt.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Enemy Grunt"))!;
    expect(card).toBeDefined();
    expect(card.anchor).toBeUndefined();

    write(unityRoot, "Assets/Prefabs/Enemy Grunt.prefab", "%YAML 1.1\n--- fake\n");
    const { proposed } = scanAndReconcile(store, "unity", unityRoot);

    expect(proposed).toHaveLength(1);
    const s = proposed[0]!;
    expect(s.kind).toBe("attach_anchor");
    expect(s.relatedCardId).toBe(card.id);
    const payload = s.payload as unknown as AttachAnchorPayload;
    expect(payload.cardId).toBe(card.id);
    expect(payload.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/Enemy Grunt.prefab" });
    store.close();
  });

  test("an anchor-less card is matched at most once per scan", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Enemy Grunt.\n", "plan.md");
    write(unityRoot, "Assets/Prefabs/Enemy Grunt.prefab", "%YAML 1.1\n--- fake 1\n");
    write(unityRoot, "Assets/Prefabs/Enemy Grunt Variant.prefab", "%YAML 1.1\n--- fake 2\n");

    const { proposed } = scanAndReconcile(store, "unity", unityRoot);
    const attachAnchors = proposed.filter((s) => s.kind === "attach_anchor");
    expect(attachAnchors).toHaveLength(1);
    // The other new asset falls back to a create_card of its own.
    expect(proposed.filter((s) => s.kind === "create_card")).toHaveLength(1);
    store.close();
  });
});

describe("scanAndReconcile — rename detection", () => {
  test("an anchored card's target disappearing alongside a similarly-named new asset reads as a rename", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Boss turret.\n", "plan.md");
    const card = store.listCards()[0]!;
    write(unityRoot, "Assets/Prefabs/Turret.prefab", "%YAML 1.1\n--- fake\n");
    scanAndReconcile(store, "unity", unityRoot);
    store.putCard({ ...card, anchor: { kind: "unityPrefab", path: "Prefabs/Turret.prefab" } });

    // The old file is renamed on disk.
    rmSync(join(unityRoot, "Assets/Prefabs/Turret.prefab"));
    write(unityRoot, "Assets/Prefabs/Turret2.prefab", "%YAML 1.1\n--- fake\n");

    const { proposed, diff } = scanAndReconcile(store, "unity", unityRoot);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(proposed).toHaveLength(1);

    const s = proposed[0]!;
    expect(s.kind).toBe("attach_anchor");
    expect(s.relatedCardId).toBe(card.id);
    const payload = s.payload as unknown as AttachAnchorPayload;
    expect(payload.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/Turret2.prefab" });
    expect(s.rationale).toContain("rename");
    store.close();
  });
});

describe("scanAndReconcile — blender anchors", () => {
  test("a new .blend file proposes a plain asset anchor, with no object-level detail", () => {
    const projectRoot = scratch();
    const { store } = initProject(projectRoot, "Test");
    const blenderRoot = scratch();
    write(blenderRoot, "sectors/corridor.blend", "fake blend binary");

    const { proposed } = scanAndReconcile(store, "blender", blenderRoot);
    expect(proposed).toHaveLength(1);
    const payload = proposed[0]!.payload as unknown as CreateCardPayload;
    expect(payload.anchor).toEqual({ kind: "asset", path: "sectors/corridor.blend" });
    store.close();
  });
});

describe("scanAndReconcile — update_card_status ('worth a look')", () => {
  /** A real card, anchored to a real file, at a given starting status. */
  function anchoredCard(store: Store, status: Card["status"]): Card {
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    const updated = { ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" } as const, status };
    store.putCard(updated);
    return updated;
  }

  test("an anchored, open card whose target changed proposes moving it to review", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    const card = anchoredCard(store, "open");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const { proposed, diff } = scanAndReconcile(store, "unity", unityRoot);

    expect(diff.changed).toHaveLength(1);
    expect(proposed).toHaveLength(1);
    const s = proposed[0]!;
    expect(s.kind).toBe("update_card_status");
    expect(s.relatedCardId).toBe(card.id);
    const payload = s.payload as unknown as UpdateCardStatusPayload;
    expect(payload).toEqual({ cardId: card.id, toStatus: "review" });
    expect(s.rationale).toContain("worth a look");
    store.close();
  });

  test("never proposes moving a card straight to done, only review — even when it's active", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    anchoredCard(store, "active");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const { proposed } = scanAndReconcile(store, "unity", unityRoot);

    const payload = proposed[0]!.payload as unknown as UpdateCardStatusPayload;
    expect(payload.toStatus).toBe("review");
    store.close();
  });

  test("a card already in review or done is not nudged again", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    anchoredCard(store, "review");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const { proposed } = scanAndReconcile(store, "unity", unityRoot);
    expect(proposed).toHaveLength(0);
    store.close();
  });

  test("re-scanning with no further change does not re-propose", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    anchoredCard(store, "open");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const first = scanAndReconcile(store, "unity", unityRoot);
    expect(first.proposed).toHaveLength(1);

    const second = scanAndReconcile(store, "unity", unityRoot);
    expect(second.diff.changed).toHaveLength(0);
    expect(second.proposed).toHaveLength(0);
    store.close();
  });

  test("a further edit after rejection proposes again — a different hash is a new fact", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    anchoredCard(store, "open");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const first = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;
    store.decideSuggestion(first.id, "rejected");

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} void Fire() {} }");
    const second = scanAndReconcile(store, "unity", unityRoot);
    expect(second.proposed).toHaveLength(1);
    expect(second.proposed[0]!.id).not.toBe(first.id);
    store.close();
  });
});

describe("applySuggestion", () => {
  test("create_card writes a new card with the proposed title, category, and anchor", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Prefabs/Grunt.prefab", "%YAML 1.1\n--- fake\n");
    const suggestion = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;

    const result = applySuggestion(store, suggestion);
    expect(result.created).toBe(true);
    const card = store.getCard(result.cardId)!;
    expect(card.title).toBe("Grunt");
    expect(card.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/Grunt.prefab" });
    store.close();
  });

  test("attach_anchor updates the existing card's anchor and returns created: false", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Grunt.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Grunt"))!;
    write(unityRoot, "Assets/Prefabs/Grunt.prefab", "%YAML 1.1\n--- fake\n");
    const suggestion = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;
    expect(suggestion.kind).toBe("attach_anchor");

    const result = applySuggestion(store, suggestion);
    expect(result.created).toBe(false);
    expect(result.cardId).toBe(card.id);
    expect(store.getCard(card.id)!.anchor).toEqual({ kind: "unityPrefab", path: "Prefabs/Grunt.prefab" });
    store.close();
  });

  test("update_card_status moves the card to review and nowhere else", () => {
    const { store, unityRoot } = seeded();
    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase {}");
    scanAndReconcile(store, "unity", unityRoot);
    importPlan(store, "## Phase 0 — Corridor\n\n- Reload logic.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Reload logic"))!;
    store.putCard({ ...card, anchor: { kind: "script", path: "Scripts/AmmoDatabase.cs" }, status: "open" });

    write(unityRoot, "Assets/Scripts/AmmoDatabase.cs", "class AmmoDatabase { void Reload() {} }");
    const suggestion = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;

    const result = applySuggestion(store, suggestion);
    expect(result.created).toBe(false);
    expect(store.getCard(card.id)!.status).toBe("review");
    store.close();
  });

  test("attach_anchor throws ApplySuggestionError, and writes nothing, if the card was deleted first", () => {
    const { store, unityRoot } = seeded();
    importPlan(store, "## Phase 0 — Corridor\n\n- Grunt.\n", "plan.md");
    const card = store.listCards().find((c) => c.title.includes("Grunt"))!;
    write(unityRoot, "Assets/Prefabs/Grunt.prefab", "%YAML 1.1\n--- fake\n");
    const suggestion = scanAndReconcile(store, "unity", unityRoot).proposed[0]!;
    store.deleteCard(card.id);

    expect(() => applySuggestion(store, suggestion)).toThrow(ApplySuggestionError);
    store.close();
  });

  test("dispatch and close_health_item are not implemented yet and say so", () => {
    const { store } = seeded();
    const stub = {
      id: "suggestion_stub",
      kind: "dispatch" as const,
      source: "reconciliation" as const,
      rationale: "stub",
      payload: {},
      fingerprint: "stub",
      status: "pending" as const,
      createdAt: Date.now(),
    };
    expect(() => applySuggestion(store, stub)).toThrow(ApplySuggestionError);
    store.close();
  });
});

describe("scanAndReconcile — suspicious-scan circuit breaker", () => {
  function floodUnity(unityRoot: string, count: number): void {
    for (let i = 0; i < count; i++) {
      write(unityRoot, `Assets/Junk/file${i}.bin`, "x");
    }
  }

  test("a scan with an implausible number of new assets proposes nothing and flags a blocker health item", () => {
    const { store, unityRoot } = seeded();
    floodUnity(unityRoot, 250);

    const { proposed, suspicious, diff } = scanAndReconcile(store, "unity", unityRoot);
    expect(suspicious).toBe(true);
    expect(diff.added).toHaveLength(250);
    expect(proposed).toHaveLength(0);
    expect(store.listSuggestions()).toHaveLength(0);

    const health = store.listHealthItems();
    expect(health).toHaveLength(1);
    expect(health[0]!.severity).toBe("blocker");
    expect(health[0]!.source).toBe(`${SUSPICIOUS_SCAN_SOURCE}_unity`);
    expect(health[0]!.message).toContain("250");
  });

  test("a normal-sized scan is unaffected", () => {
    const { store, unityRoot } = seeded();
    floodUnity(unityRoot, 10);

    const { proposed, suspicious } = scanAndReconcile(store, "unity", unityRoot);
    expect(suspicious).toBe(false);
    expect(proposed).toHaveLength(10);
    expect(store.listHealthItems()).toHaveLength(0);
  });

  test("a later clean scan closes the flag", () => {
    const { store, unityRoot } = seeded();
    floodUnity(unityRoot, 250);
    scanAndReconcile(store, "unity", unityRoot);
    expect(store.listHealthItems()).toHaveLength(1);

    // Fix the link (remove the flood) and scan again.
    for (let i = 0; i < 250; i++) {
      rmSync(join(unityRoot, "Assets/Junk", `file${i}.bin`));
    }
    const { suspicious } = scanAndReconcile(store, "unity", unityRoot);
    expect(suspicious).toBe(false);
    expect(store.listHealthItems()).toHaveLength(0);
  });

  test("a suspicious Unity scan does not touch a separately-tracked, still-legitimate Blender flag", () => {
    const { store, unityRoot } = seeded();
    const blenderRoot = scratch();
    for (let i = 0; i < 250; i++) write(blenderRoot, `junk/file${i}.bin`, "x");

    scanAndReconcile(store, "blender", blenderRoot);
    expect(store.listHealthItems()).toHaveLength(1);

    // A clean, small Unity scan must not clear Blender's still-open flag —
    // they share the SUSPICIOUS_SCAN_SOURCE prefix but must be isolated
    // per engine, or one engine's clean scan could mask another's real
    // wrong-path incident.
    write(unityRoot, "Assets/Foo.cs", "class Foo {}");
    scanAndReconcile(store, "unity", unityRoot);

    const health = store.listHealthItems();
    expect(health).toHaveLength(1);
    expect(health[0]!.source).toBe(`${SUSPICIOUS_SCAN_SOURCE}_blender`);
  });

});
