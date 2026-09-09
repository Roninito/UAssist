import { describe, expect, test } from "bun:test";
import { parsePlan, splitAcceptance } from "../src/plan/parse.ts";
import { normalizeTitle, titleSimilarity } from "../src/plan/sourceKey.ts";

const PLAN = `# Colony Escape

# Part IV — Core systems, in build order

## Phase 0 — Capsule in a corridor

*2–3 weeks.*

The whole pipe, thin.

- Custom 3D motor: walk, run, jump.
- Cinemachine follow camera with collision.

**Exit demo.** Walk down the corridor. Jump the gap.

**Exit gate.** Build runs. No compile errors.

## Phase 6 — Content production and polish

*Ongoing, 3–6 months.*

- Additional colony sectors.

# Part V — Division of labour

## What Unity provides

- Physics via PhysX.

# Part VII — Cut list

- Multiplayer.
- Open world / streaming world (use discrete sectors).
`;

describe("parsePlan", () => {
  const plan = parsePlan(PLAN, "test.md");

  test("only `## Phase N` headings become milestones", () => {
    expect(plan.milestones.map((m) => m.title)).toEqual([
      "Capsule in a corridor",
      "Content production and polish",
    ]);
  });

  test("prose sections under other Parts do not become milestones", () => {
    expect(plan.milestones.some((m) => m.title === "What Unity provides")).toBe(false);
  });

  test("cut-list bullets never become cards", () => {
    const titles = plan.cards.map((c) => c.title);
    expect(titles).not.toContain("Multiplayer.");
    expect(titles).not.toContain("Open world / streaming world (use discrete sectors).");
  });

  test("bullets outside any phase are ignored", () => {
    expect(plan.cards.map((c) => c.title)).not.toContain("Physics via PhysX.");
  });

  test("bold exit lines produce gate and deliverable cards", () => {
    const gate = plan.cards.find((c) => c.kind === "gate");
    const demo = plan.cards.find((c) => c.kind === "deliverable");
    expect(gate?.title).toBe("Gate: Capsule in a corridor");
    expect(demo?.title).toBe("Demo: Capsule in a corridor");
  });

  test("exit conditions split into one criterion per sentence", () => {
    const gate = plan.cards.find((c) => c.kind === "gate")!;
    expect(gate.acceptance.map((a) => a.text)).toEqual([
      "Build runs.",
      "No compile errors.",
    ]);
    expect(gate.acceptance.every((a) => !a.met)).toBe(true);
  });

  test("gate condition lands on the milestone too", () => {
    const p0 = plan.milestones[0]!;
    expect(p0.gateCondition).toBe("Build runs. No compile errors.");
    expect(p0.demoCondition).toBe("Walk down the corridor. Jump the gap.");
  });

  test("week timeboxes parse", () => {
    expect(plan.milestones[0]!.timebox).toEqual({ minWeeks: 2, maxWeeks: 3 });
  });

  test("an ongoing phase gets no timebox and keeps a clean description", () => {
    const p6 = plan.milestones[1]!;
    expect(p6.timebox).toBeUndefined();
    expect(p6.description).not.toContain("Ongoing");
  });

  test("first prose line becomes the description", () => {
    expect(plan.milestones[0]!.description).toBe("The whole pipe, thin.");
  });

  test("every bullet in a phase becomes a card", () => {
    const p0 = plan.milestones[0]!;
    const tasks = plan.cards.filter(
      (c) => c.milestoneId === p0.id && c.kind === "task",
    );
    expect(tasks).toHaveLength(2);
  });

  test("cards carry source lines and stable keys", () => {
    const card = plan.cards[0]!;
    expect(card.source?.file).toBe("test.md");
    expect(card.source?.startLine).toBeGreaterThan(0);
    expect(card.sourceKey).toBeTruthy();
  });

  test("source keys are unique across the plan", () => {
    const keys = plan.cards.map((c) => c.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.warnings).toEqual([]);
  });

  test("categories are inferred from bullet text when there are no ### headings", () => {
    const motor = plan.cards.find((c) => c.title.startsWith("Custom 3D motor"))!;
    expect(motor.category).toBe("Gameplay");
  });

  test("parsing is deterministic in shape across runs", () => {
    const again = parsePlan(PLAN, "test.md");
    expect(again.cards.map((c) => c.sourceKey)).toEqual(
      plan.cards.map((c) => c.sourceKey),
    );
  });
});

describe("splitAcceptance", () => {
  test("splits on sentence boundaries", () => {
    expect(splitAcceptance("A runs. B fails. C passes.").map((c) => c.text)).toEqual([
      "A runs.",
      "B fails.",
      "C passes.",
    ]);
  });

  test("does not split on a decimal or an abbreviation mid-sentence", () => {
    expect(splitAcceptance("Frame time under 16.6 ms.")).toHaveLength(1);
  });
});

describe("sourceKey helpers", () => {
  test("normalizeTitle strips backticks and punctuation", () => {
    expect(normalizeTitle("Data model: `Item`, `Weapon`.")).toBe("data model item weapon");
  });

  test("a reworded title stays similar", () => {
    const score = titleSimilarity(
      "Cargo window UI (toggleable, grid, drag/drop optional in v1).",
      "Cargo window UI (toggleable grid, optional drag and drop in v1).",
    );
    expect(score).toBeGreaterThan(0.6);
  });

  test("unrelated titles are not similar", () => {
    expect(titleSimilarity("Audio buses", "NavMesh bake status")).toBeLessThan(0.6);
  });
});
