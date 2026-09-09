import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject, Store } from "../src/store.ts";
import { importPlan } from "../src/plan/import.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-import-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const V1 = `## Phase 0 — Corridor

*2–3 weeks.*

- Custom 3D motor: walk and run.
- Cargo window UI (toggleable, grid, drag/drop optional in v1).
- Placeholder capsule for the player.

**Exit gate.** Build runs.
`;

function seeded(): Store {
  const root = scratch();
  const { store } = initProject(root, "Test");
  importPlan(store, V1, "plan.md");
  return store;
}

describe("re-ingest", () => {
  test("re-importing an unchanged plan is a no-op", () => {
    const store = seeded();
    const result = importPlan(store, V1, "plan.md");
    expect(result.addedCards).toHaveLength(0);
    expect(result.updatedCards).toHaveLength(0);
    expect(result.renamedCards).toHaveLength(0);
    expect(result.orphanedCards).toHaveLength(0);
    expect(result.addedMilestones).toHaveLength(0);
    store.close();
  });

  test("a new bullet is added without disturbing the rest", () => {
    const store = seeded();
    const before = store.countCards();
    const v2 = V1.replace(
      "- Placeholder capsule for the player.",
      "- Placeholder capsule for the player.\n- Hunger and thirst meters.",
    );
    const result = importPlan(store, v2, "plan.md");
    expect(result.addedCards.map((c) => c.title)).toEqual([
      "Hunger and thirst meters.",
    ]);
    expect(store.countCards()).toBe(before + 1);
    store.close();
  });

  test("a reworded bullet is a rename, not an add plus a delete", () => {
    const store = seeded();
    const before = store.countCards();
    const v2 = V1.replace(
      "- Cargo window UI (toggleable, grid, drag/drop optional in v1).",
      "- Cargo window UI (toggleable grid, optional drag and drop in v1).",
    );
    const result = importPlan(store, v2, "plan.md");
    expect(result.renamedCards).toHaveLength(1);
    expect(result.addedCards).toHaveLength(0);
    expect(result.orphanedCards).toHaveLength(0);
    expect(store.countCards()).toBe(before);
    store.close();
  });

  test("a rename preserves status, owner, and time spent", () => {
    const store = seeded();
    const card = store.listCards().find((c) => c.title.startsWith("Cargo window UI"))!;
    store.putCard({ ...card, status: "active", owner: "ronin", timeSpentHours: 4 });

    const v2 = V1.replace(
      "- Cargo window UI (toggleable, grid, drag/drop optional in v1).",
      "- Cargo window UI (toggleable grid, optional drag and drop in v1).",
    );
    importPlan(store, v2, "plan.md");

    const after = store.getCard(card.id)!;
    expect(after.title).toBe("Cargo window UI (toggleable grid, optional drag and drop in v1).");
    expect(after.status).toBe("active");
    expect(after.owner).toBe("ronin");
    expect(after.timeSpentHours).toBe(4);
    expect(after.version).toBeGreaterThan(card.version);
    store.close();
  });

  test("a removed bullet is orphaned, never deleted", () => {
    const store = seeded();
    const before = store.countCards();
    const v2 = V1.replace("- Placeholder capsule for the player.\n", "");
    const result = importPlan(store, v2, "plan.md");
    expect(result.orphanedCards.map((c) => c.title)).toEqual([
      "Placeholder capsule for the player.",
    ]);
    expect(store.countCards()).toBe(before);
    store.close();
  });

  test("a dry run reports the diff and writes nothing", () => {
    const store = seeded();
    const before = store.countCards();
    const v2 = V1.replace(
      "- Placeholder capsule for the player.",
      "- Placeholder capsule for the player.\n- Hunger and thirst meters.",
    );
    const result = importPlan(store, v2, "plan.md", { dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.addedCards).toHaveLength(1);
    expect(store.countCards()).toBe(before);
    store.close();
  });

  test("acceptance criteria already met stay met after re-import", () => {
    const store = seeded();
    const gate = store.listCards().find((c) => c.kind === "gate")!;
    store.putCard({
      ...gate,
      acceptance: gate.acceptance.map((a) => ({ ...a, met: true, verifiedBy: "human" as const })),
    });
    importPlan(store, V1, "plan.md");
    const after = store.getCard(gate.id)!;
    expect(after.acceptance.every((a) => a.met)).toBe(true);
    store.close();
  });

  test("editing a gate condition updates its acceptance criteria", () => {
    const store = seeded();
    const v2 = V1.replace(
      "**Exit gate.** Build runs.",
      "**Exit gate.** Build runs. Smoke test passes.",
    );
    const result = importPlan(store, v2, "plan.md");
    expect(result.updatedCards).toHaveLength(1);
    const gate = store.listCards().find((c) => c.kind === "gate")!;
    expect(gate.acceptance.map((a) => a.text)).toEqual([
      "Build runs.",
      "Smoke test passes.",
    ]);
    store.close();
  });

  test("retitling a phase keeps its cards", () => {
    const store = seeded();
    const before = store.countCards();
    const v2 = V1.replace("## Phase 0 — Corridor", "## Phase 0 — Capsule in a corridor");
    const result = importPlan(store, v2, "plan.md");
    expect(result.addedMilestones).toHaveLength(0);
    expect(result.updatedMilestones).toHaveLength(1);
    expect(result.orphanedCards).toHaveLength(0);
    expect(store.countCards()).toBe(before);
    store.close();
  });

  test("the plan source is retained for the next diff", async () => {
    const store = seeded();
    const saved = await Bun.file(join(store.dir, "plans", "plan.md")).text();
    expect(saved).toBe(V1);
    store.close();
  });
});
