import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject, Store } from "../src/store.ts";
import { importPlan } from "../src/plan/import.ts";
import { serializeCard } from "../src/serialize.ts";
import type { Card } from "../src/types.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PLAN = `## Phase 0 — Corridor

*2–3 weeks.*

- Custom 3D motor: walk and run.
- Cinemachine follow camera.

**Exit gate.** Build runs.
`;

function seeded() {
  const root = scratch();
  const { store } = initProject(root, "Test");
  importPlan(store, PLAN, "plan.md");
  return { root, store };
}

describe("store round-trip", () => {
  test("a card survives write and read unchanged", () => {
    const { store } = seeded();
    const before = store.listCards()[0]!;
    const after = store.getCard(before.id)!;
    expect(after).toEqual(before);
    store.close();
  });

  test("link arrays round-trip through card_links", () => {
    const { store } = seeded();
    const [a, b, c] = store.listCards();
    const updated: Card = {
      ...a!,
      dependencies: [b!.id],
      blockedBy: [c!.id],
      related: [b!.id, c!.id],
    };
    store.putCard(updated);
    const read = store.getCard(a!.id)!;
    expect(read.dependencies).toEqual([b!.id]);
    expect(read.blockedBy).toEqual([c!.id]);
    expect(read.related.sort()).toEqual([b!.id, c!.id].sort());
    store.close();
  });

  test("mirror file matches the serialized record", () => {
    const { root, store } = seeded();
    const card = store.listCards()[0]!;
    const onDisk = readFileSync(join(root, ".uassist", "cards", `${card.id}.json`), "utf8");
    expect(onDisk).toBe(serializeCard(card));
    store.close();
  });

  test("deleting a card removes its mirror file", () => {
    const { root, store } = seeded();
    const card = store.listCards()[0]!;
    const path = join(root, ".uassist", "cards", `${card.id}.json`);
    expect(existsSync(path)).toBe(true);
    store.deleteCard(card.id);
    expect(existsSync(path)).toBe(false);
    expect(store.getCard(card.id)).toBeUndefined();
    store.close();
  });
});

describe("deterministic serialization", () => {
  test("key order does not depend on insertion order", () => {
    const { store } = seeded();
    const card = store.listCards()[0]!;
    // Rebuild the object with keys in a scrambled order.
    const scrambled = Object.fromEntries(
      Object.entries(card).reverse(),
    ) as unknown as Card;
    expect(serializeCard(scrambled)).toBe(serializeCard(card));
    store.close();
  });

  test("undefined fields are omitted, not nulled", () => {
    const { store } = seeded();
    const card = store.listCards()[0]!;
    const json = serializeCard({ ...card, owner: undefined, anchor: undefined });
    expect(json).not.toContain("null");
    expect(json).not.toContain('"owner"');
    store.close();
  });

  test("id arrays are sorted before writing", () => {
    const { store } = seeded();
    const [a, b, c] = store.listCards();
    const forward = serializeCard({ ...a!, related: [b!.id, c!.id] });
    const reverse = serializeCard({ ...a!, related: [c!.id, b!.id] });
    expect(forward).toBe(reverse);
    store.close();
  });

  test("every file ends with a newline", () => {
    const { store } = seeded();
    expect(serializeCard(store.listCards()[0]!).endsWith("\n")).toBe(true);
    store.close();
  });
});

describe("db rebuild", () => {
  test("replays the mirror byte-identically", () => {
    const { root, store } = seeded();
    const dir = join(root, ".uassist");
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const kind of ["cards", "milestones"]) {
        const { readdirSync } = require("node:fs");
        for (const f of readdirSync(join(dir, kind)).sort()) {
          out[`${kind}/${f}`] = readFileSync(join(dir, kind, f), "utf8");
        }
      }
      return out;
    };
    const before = snapshot();
    store.close();

    const counts = Store.rebuild(root);
    expect(counts.cards).toBe(Object.keys(before).filter((k) => k.startsWith("cards/")).length);
    expect(snapshot()).toEqual(before);
  });

  test("a deleted database is rebuilt with the same card set", () => {
    const { root, store } = seeded();
    const titles = store.listCards().map((c) => c.title).sort();
    store.close();

    rmSync(join(root, ".uassist", "uassist.db"), { force: true });
    Store.rebuild(root);

    const reopened = new Store(root, { mirrorDebounceMs: 0 });
    expect(reopened.listCards().map((c) => c.title).sort()).toEqual(titles);
    reopened.close();
  });
});

describe("event log", () => {
  test("sequence numbers are monotonic and survive reopen", () => {
    const { root, store } = seeded();
    const seq = store.lastSeq;
    expect(seq).toBeGreaterThan(0);
    store.close();

    const reopened = new Store(root, { mirrorDebounceMs: 0 });
    expect(reopened.lastSeq).toBe(seq);
    reopened.appendEvent("test");
    expect(reopened.lastSeq).toBe(seq + 1);
    reopened.close();
  });

  test("eventsSince replays only newer events", () => {
    const { store } = seeded();
    const mark = store.lastSeq;
    store.appendEvent("alpha");
    store.appendEvent("beta");
    const replayed = store.eventsSince(mark);
    expect(replayed.map((e) => e.kind)).toEqual(["alpha", "beta"]);
    store.close();
  });
});

describe("queries", () => {
  test("cards are ordered by milestone phase", () => {
    const root = scratch();
    const { store } = initProject(root, "Test");
    importPlan(
      store,
      `## Phase 1 — Later\n\n- Second thing here.\n\n## Phase 0 — Earlier\n\n- First thing here.\n`,
      "plan.md",
    );
    const titles = store.listCards().map((c) => c.title);
    expect(titles[0]).toBe("First thing here.");
    store.close();
  });

  test("status filter narrows the result", () => {
    const { store } = seeded();
    const card = store.listCards()[0]!;
    store.putCard({ ...card, status: "active" });
    expect(store.listCards({ status: "active" })).toHaveLength(1);
    expect(store.cardCountsByStatus()["active"]).toBe(1);
    store.close();
  });
});

describe("suggestions", () => {
  function propose(store: Store, fingerprint = "fp-1") {
    return store.proposeSuggestion({
      kind: "create_card",
      source: "reconciliation",
      rationale: "found an unplanned asset",
      payload: { title: "New enemy prefab" },
      fingerprint,
    });
  }

  test("a fresh fingerprint is inserted pending", () => {
    const { store } = seeded();
    const s = propose(store);
    expect(s?.status).toBe("pending");
    expect(store.listSuggestions()).toHaveLength(1);
    store.close();
  });

  test("re-proposing the same fingerprint while pending is a no-op", () => {
    const { store } = seeded();
    const first = propose(store);
    const second = propose(store);
    expect(second).toBeUndefined();
    expect(store.listSuggestions()).toHaveLength(1);
    expect(store.getSuggestion(first!.id)?.rationale).toBe("found an unplanned asset");
    store.close();
  });

  test("rejecting, then re-proposing the same fingerprint, does not resurface it", () => {
    const { store } = seeded();
    const first = propose(store);
    store.decideSuggestion(first!.id, "rejected");
    const again = propose(store);
    expect(again).toBeUndefined();
    expect(store.getSuggestion(first!.id)?.status).toBe("rejected");
    store.close();
  });

  test("holding, then re-proposing the same fingerprint, reopens it as pending — 'ask me again later'", () => {
    const { store } = seeded();
    const first = propose(store);
    store.decideSuggestion(first!.id, "held");
    const reopened = propose(store);
    expect(reopened).toBeDefined();
    expect(reopened!.id).toBe(first!.id); // same slot, not a new row
    expect(reopened!.status).toBe("pending");
    expect(reopened!.decidedAt).toBeUndefined();
    store.close();
  });

  test("accepting, then re-proposing the same fingerprint, reopens it as pending", () => {
    const { store } = seeded();
    const first = propose(store);
    store.decideSuggestion(first!.id, "accepted");
    const reopened = propose(store);
    expect(reopened).toBeDefined();
    expect(reopened!.id).toBe(first!.id); // same slot, not a new row
    expect(reopened!.status).toBe("pending");
    expect(reopened!.decidedAt).toBeUndefined();
    expect(store.listSuggestions()).toHaveLength(1);
    store.close();
  });

  test("listSuggestions filters by status", () => {
    const { store } = seeded();
    const a = propose(store, "fp-a")!;
    propose(store, "fp-b");
    store.decideSuggestion(a.id, "accepted");
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(1);
    expect(store.listSuggestions({ status: "accepted" })).toHaveLength(1);
    store.close();
  });

  test("survives db rebuild with status and decidedAt intact", () => {
    const { root, store } = seeded();
    const a = propose(store, "fp-a")!;
    store.decideSuggestion(a.id, "accepted");
    propose(store, "fp-b");
    store.close();

    Store.rebuild(root);
    const reopened = new Store(root, { mirrorDebounceMs: 0 });
    const restored = reopened.getSuggestion(a.id);
    expect(restored?.status).toBe("accepted");
    expect(restored?.decidedAt).toBeDefined();
    expect(reopened.listSuggestions()).toHaveLength(2);
    reopened.close();
  });

  test("deleteSuggestion removes it outright, not just marks it decided", () => {
    const { store } = seeded();
    const a = propose(store, "fp-a")!;
    propose(store, "fp-b");

    store.deleteSuggestion(a.id);
    expect(store.getSuggestion(a.id)).toBeUndefined();
    expect(store.listSuggestions()).toHaveLength(1);
    store.close();
  });

  test("a deleted suggestion's fingerprint is free to be proposed again", () => {
    const { store } = seeded();
    const a = propose(store, "fp-a")!;
    store.deleteSuggestion(a.id);

    const again = propose(store, "fp-a");
    expect(again).toBeDefined();
    expect(again!.id).not.toBe(a.id); // a fresh row, not a resurrected one
    store.close();
  });

  test("deleteSuggestion does not survive db rebuild reintroducing it", () => {
    const { root, store } = seeded();
    const a = propose(store, "fp-a")!;
    propose(store, "fp-b");
    store.deleteSuggestion(a.id);
    store.close();

    Store.rebuild(root);
    const reopened = new Store(root, { mirrorDebounceMs: 0 });
    expect(reopened.getSuggestion(a.id)).toBeUndefined();
    expect(reopened.listSuggestions()).toHaveLength(1);
    reopened.close();
  });
});
