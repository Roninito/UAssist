import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAiConfig, initProject, Store } from "@uassist/core";

describe("chat threads", () => {
  let root: string;
  let store: Store;

  beforeEach(() => {
    root = join(tmpdir(), `uassist-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const init = initProject(root, "chat-test");
    store = init.store;
  });

  afterEach(() => {
    try {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("default project has aiConfig", () => {
    const project = store.getProject();
    expect(project).toBeDefined();
    expect(project!.aiConfig).toEqual(defaultAiConfig());
  });

  test("append chat message creates a thread", () => {
    const card = store.listCards()[0];
    if (!card) return;

    const now = Date.now();
    const thread = store.appendChatMessage(card.id, { role: "user", content: "hello", createdAt: now });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.content).toBe("hello");

    const reloaded = store.getChatThread(card.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.messages[0]!.content).toBe("hello");
  });

  test("rebuild restores chat threads", () => {
    const card = store.listCards()[0];
    if (!card) return;

    store.appendChatMessage(card.id, { role: "user", content: "rebuild me", createdAt: Date.now() });
    store.close();

    const rebuilt = Store.rebuild(root);
    expect(rebuilt.cards).toBeGreaterThan(0);

    const fresh = new Store(root, { readOnly: true });
    const thread = fresh.getChatThread(card.id);
    expect(thread).toBeDefined();
    expect(thread!.messages[0]!.content).toBe("rebuild me");
    fresh.close();
  });
});
