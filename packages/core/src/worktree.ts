/**
 * Git worktree manager.
 *
 * Every job runs in its own worktree, branched from the current HEAD. Agents
 * never touch the working tree directly — what comes back is a diff a human
 * reviews, never an applied change. See design/uassist-spec.md Part IX.
 *
 * All git invocations go through `Bun.$` tagged templates, which escape their
 * interpolated arguments by construction — a worktree path or branch name
 * with a space in it does not become shell injection.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** git reports worktree paths through their realpath (macOS: /var → /private/var
 *  via a symlink). Comparing against an un-resolved path silently fails —
 *  resolve both sides, falling back to the original if the path is gone. */
function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  createdAt: number;
}

export class NotAGitRepoError extends Error {
  constructor(root: string) {
    super(`${root} is not a git repository — worktree isolation needs one`);
    this.name = "NotAGitRepoError";
  }
}

async function git(root: string, ...args: string[]) {
  const { $ } = await import("bun");
  return $`git ${args}`.cwd(root).quiet();
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const result = await git(root, "rev-parse", "--is-inside-work-tree");
    return result.stdout.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

export function worktreesDir(uassistDir: string): string {
  return join(uassistDir, "worktrees");
}

/**
 * Create a worktree for `jobId`, branched from the current HEAD.
 *
 * Branch name is derived from the job id, which is already a collision-free
 * UUIDv7 — no separate uniqueness scheme needed for the branch name itself.
 */
export async function createWorktree(
  root: string,
  uassistDir: string,
  jobId: string,
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(root))) throw new NotAGitRepoError(root);

  const head = await git(root, "rev-parse", "HEAD");
  const baseSha = head.stdout.toString("utf8").trim();
  if (baseSha.length === 0) {
    throw new Error(
      "HEAD has no commits yet — worktree isolation needs at least one commit to branch from",
    );
  }

  const branch = `uassist/${jobId}`;
  const path = join(worktreesDir(uassistDir), jobId);

  await git(root, "worktree", "add", path, "-b", branch, baseSha);

  return { path, branch, baseSha, createdAt: Date.now() };
}

/**
 * Remove a worktree and its branch. Safe to call on a worktree that is
 * already gone (accept/reject both end here regardless of prior state).
 */
export async function removeWorktree(root: string, info: WorktreeInfo): Promise<void> {
  if (existsSync(info.path)) {
    try {
      await git(root, "worktree", "remove", info.path, "--force");
    } catch {
      // The directory may have been removed by hand; git still tracks it
      // until pruned. Fall through to prune rather than surfacing this.
    }
  }
  try {
    await git(root, "worktree", "prune");
  } catch {
    // Non-fatal — an orphaned worktree entry is cleaned up by the next
    // successful prune, and `uassist worktree prune` can be run by hand.
  }
  try {
    await git(root, "branch", "-D", info.branch);
  } catch {
    // The branch may already be gone (e.g. merged and deleted on accept).
  }
}

/** Everything currently in `git worktree list`, for `uassist worktree prune`. */
export async function listGitWorktrees(root: string): Promise<{ path: string; branch: string }[]> {
  const result = await git(root, "worktree", "list", "--porcelain");
  const text = result.stdout.toString("utf8");
  const entries: { path: string; branch: string }[] = [];
  let path: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && path) {
      entries.push({ path, branch: line.slice("branch ".length).replace(/^refs\/heads\//, "") });
      path = undefined;
    }
  }
  return entries;
}

/**
 * Remove any `uassist/*` worktree whose directory no longer exists under
 * `uassistDir/worktrees/` — the case a crashed server or a killed job leaves
 * behind. Never touches a worktree outside UAssist's own naming convention.
 */
export async function pruneOrphanedWorktrees(root: string, uassistDir: string): Promise<string[]> {
  const dir = realpathIfExists(worktreesDir(uassistDir));
  const removed: string[] = [];
  for (const entry of await listGitWorktrees(root)) {
    if (!entry.branch.startsWith("uassist/")) continue;
    if (!entry.path.startsWith(dir)) continue; // defense in depth, not just naming
    if (existsSync(entry.path)) continue; // still a live job's worktree
    try {
      await git(root, "worktree", "remove", entry.path, "--force");
    } catch {
      // Already gone from git's index too; fall through to prune below.
    }
    removed.push(entry.path);
  }
  await git(root, "worktree", "prune").catch(() => {});
  return removed;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

/** Whether the agent produced any change at all — commits or a dirty tree. */
export async function hasChanges(worktreePath: string, baseSha: string): Promise<boolean> {
  const { $ } = await import("bun");
  const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
  if (status.stdout.toString("utf8").trim().length > 0) return true;
  const log = await $`git log ${baseSha}..HEAD --oneline`.cwd(worktreePath).quiet().nothrow();
  return log.stdout.toString("utf8").trim().length > 0;
}

/**
 * Stage everything (agents do not commit for themselves) and produce the diff
 * against the worktree's base commit — what a human reviews before accept.
 */
export async function computeDiff(worktreePath: string, baseSha: string): Promise<{ diff: string; stat: DiffStat }> {
  const { $ } = await import("bun");
  await $`git add -A`.cwd(worktreePath).quiet();

  const diffResult = await $`git diff --cached ${baseSha}`.cwd(worktreePath).quiet();
  const diff = diffResult.stdout.toString("utf8");

  const statResult = await $`git diff --cached --numstat ${baseSha}`.cwd(worktreePath).quiet();
  const lines = statResult.stdout.toString("utf8").trim().split("\n").filter((l) => l.length > 0);

  let insertions = 0;
  let deletions = 0;
  const files: string[] = [];
  for (const line of lines) {
    const [ins, del, file] = line.split("\t");
    if (file) files.push(file);
    if (ins !== "-") insertions += Number(ins) || 0;
    if (del !== "-") deletions += Number(del) || 0;
  }

  return { diff, stat: { filesChanged: files.length, insertions, deletions, files } };
}

/**
 * Apply an accepted job's changes to the real working tree as one reviewed
 * commit, then remove the worktree. This is the only path by which agent
 * output ever reaches the working tree — never a direct write, always a
 * commit a human triggered by clicking accept.
 */
export async function acceptWorktree(
  root: string,
  info: WorktreeInfo,
  commitMessage: string,
): Promise<{ sha: string }> {
  const { $ } = await import("bun");

  // Committing inside the worktree keeps the diff exactly what was reviewed;
  // merging the branch (not cherry-picking loose changes) is what lands it.
  await $`git add -A`.cwd(info.path).quiet();
  const hasStaged = await $`git diff --cached --quiet`.cwd(info.path).quiet().nothrow();
  if (hasStaged.exitCode !== 0) {
    await $`git commit -m ${commitMessage}`.cwd(info.path).quiet();
  }

  const currentBranch = await $`git rev-parse --abbrev-ref HEAD`.cwd(root).quiet();
  const onFeatureBranch = currentBranch.stdout.toString("utf8").trim() === info.branch;
  if (onFeatureBranch) {
    throw new Error("refusing to merge a job branch into itself");
  }

  await $`git merge --no-ff -m ${`Merge ${info.branch}: ${commitMessage}`} ${info.branch}`
    .cwd(root)
    .quiet();

  const sha = (await $`git rev-parse HEAD`.cwd(root).quiet()).stdout.toString("utf8").trim();

  await removeWorktree(root, info);
  return { sha };
}
