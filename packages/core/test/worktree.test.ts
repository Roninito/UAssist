import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptWorktree,
  computeDiff,
  createWorktree,
  hasChanges,
  isGitRepo,
  NotAGitRepoError,
  pruneOrphanedWorktrees,
  removeWorktree,
} from "../src/worktree.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-worktree-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function initRepo(): Promise<{ root: string; uassistDir: string }> {
  const root = scratch();
  const { $ } = await import("bun");
  await $`git init -q`.cwd(root).quiet();
  await $`git config user.email test@example.com`.cwd(root).quiet();
  await $`git config user.name Test`.cwd(root).quiet();
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
  await $`git add -A`.cwd(root).quiet();
  await $`git commit -q -m initial`.cwd(root).quiet();

  const uassistDir = join(root, ".uassist");
  return { root, uassistDir };
}

describe("isGitRepo", () => {
  test("true for an initialized repo", async () => {
    const { root } = await initRepo();
    expect(await isGitRepo(root)).toBe(true);
  });

  test("false for a plain directory", async () => {
    expect(await isGitRepo(scratch())).toBe(false);
  });
});

describe("createWorktree", () => {
  test("refuses a non-git root with a clear error", async () => {
    const root = scratch();
    await expect(createWorktree(root, join(root, ".uassist"), "job-1")).rejects.toThrow(NotAGitRepoError);
  });

  test("creates an isolated checkout branched from HEAD", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-1");

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(info.branch).toBe("uassist/job-1");
    expect(info.baseSha).toHaveLength(40);

    await removeWorktree(root, info);
  });

  test("the working tree of `root` is never touched by creating a worktree", async () => {
    const { root, uassistDir } = await initRepo();
    const before = readFileSync(join(root, "README.md"), "utf8");
    const info = await createWorktree(root, uassistDir, "job-2");

    writeFileSync(join(info.path, "README.md"), "changed only in the worktree\n", "utf8");

    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(before);
    await removeWorktree(root, info);
  });
});

describe("hasChanges / computeDiff", () => {
  test("a worktree with no edits reports no changes", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-3");
    expect(await hasChanges(info.path, info.baseSha)).toBe(false);
    await removeWorktree(root, info);
  });

  test("a new file is picked up as a change and appears in the diff", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-4");

    writeFileSync(join(info.path, "ItemDatabase.cs"), "class ItemDatabase {}\n", "utf8");

    expect(await hasChanges(info.path, info.baseSha)).toBe(true);
    const { diff, stat } = await computeDiff(info.path, info.baseSha);
    expect(diff).toContain("ItemDatabase.cs");
    expect(stat.filesChanged).toBe(1);
    expect(stat.insertions).toBeGreaterThan(0);
    expect(stat.files).toEqual(["ItemDatabase.cs"]);

    await removeWorktree(root, info);
  });
});

describe("acceptWorktree", () => {
  test("merges the agent's change into the real working tree as one commit", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-5");

    writeFileSync(join(info.path, "feature.txt"), "agent wrote this\n", "utf8");

    const { sha } = await acceptWorktree(root, info, "Add feature.txt");
    expect(sha).toHaveLength(40);

    // The change landed in the real root, not just the worktree.
    expect(existsSync(join(root, "feature.txt"))).toBe(true);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("agent wrote this\n");

    // The worktree itself is gone — accept always cleans up.
    expect(existsSync(info.path)).toBe(false);
  });

  test("a rejected job never touches the real working tree", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-6");
    writeFileSync(join(info.path, "rejected.txt"), "should never land\n", "utf8");

    await removeWorktree(root, info);

    expect(existsSync(join(root, "rejected.txt"))).toBe(false);
    expect(existsSync(info.path)).toBe(false);
  });
});

describe("pruneOrphanedWorktrees", () => {
  test("removes a worktree entry whose directory was deleted out from under it", async () => {
    const { root, uassistDir } = await initRepo();
    const info = await createWorktree(root, uassistDir, "job-7");

    // Simulate a crash: the directory disappears but git's index still
    // remembers the worktree.
    rmSync(info.path, { recursive: true, force: true });

    const removed = await pruneOrphanedWorktrees(root, uassistDir);
    // Compared by suffix, not equality: git (and this function, to compare
    // against git's own listing) reports the realpath, which on macOS
    // resolves /var to /private/var — a platform detail, not what the test
    // cares about.
    expect(removed.some((p) => p.endsWith(info.path))).toBe(true);

    const { $ } = await import("bun");
    const list = await $`git worktree list`.cwd(root).quiet();
    expect(list.stdout.toString("utf8")).not.toContain("job-7");
  });

  test("never touches a worktree outside UAssist's own naming convention", async () => {
    const { root, uassistDir } = await initRepo();
    const { $ } = await import("bun");
    const manualPath = join(root, "..", "manual-worktree-" + Date.now());
    await $`git worktree add ${manualPath} -b manual-branch`.cwd(root).quiet();

    await pruneOrphanedWorktrees(root, uassistDir);

    expect(existsSync(manualPath)).toBe(true);
    await $`git worktree remove ${manualPath} --force`.cwd(root).quiet();
  });
});
