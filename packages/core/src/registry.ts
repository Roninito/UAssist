/**
 * Project Registry — the machine-local index of known UAssist projects.
 *
 * Lives at ~/.uassist/registry.json, outside any single project's own
 * .uassist/. Not git-tracked: it answers "what projects does this machine
 * know about," which is meaningless to commit and meaningless to share. Each
 * project still runs as its own isolated server on its own port, exactly as
 * before — this is an index for finding your way to one, not a shared
 * multi-tenant process.
 *
 * See design/workspace-spec.md Part II.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProjectId } from "./ids.ts";

export interface RegisteredProject {
  id: ProjectId;
  name: string;
  root: string;
  addedAt: number;
  lastOpenedAt: number;
}

interface Registry {
  version: 1;
  projects: RegisteredProject[];
}

const EMPTY_REGISTRY: Registry = { version: 1, projects: [] };

/** Overridable for tests; otherwise the real per-user home directory. */
export function registryDir(home: string = homedir()): string {
  return join(home, ".uassist");
}

export function registryPath(home?: string): string {
  return join(registryDir(home), "registry.json");
}

function readRegistry(home?: string): Registry {
  const path = registryPath(home);
  if (!existsSync(path)) return EMPTY_REGISTRY;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as Registry).projects)
    ) {
      return value as Registry;
    }
  } catch {
    // A corrupted registry is not a reason to lose the ability to register
    // the current project — treat it as empty rather than throwing.
  }
  return EMPTY_REGISTRY;
}

function writeRegistry(registry: Registry, home?: string): void {
  const dir = registryDir(home);
  mkdirSync(dir, { recursive: true });
  // Sorted by root so the file diffs sanely if a person ever peeks at it or
  // syncs their home directory — not git-tracked, but no reason to churn.
  const sorted: Registry = {
    ...registry,
    projects: [...registry.projects].sort((a, b) => a.root.localeCompare(b.root)),
  };
  writeFileSync(dir + "/registry.json", JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

/** Add a project, or update its name/lastOpenedAt if its root is already known. */
export function registerProject(
  project: { id: ProjectId; name: string; root: string },
  home?: string,
): RegisteredProject {
  const registry = readRegistry(home);
  const now = Date.now();
  const existing = registry.projects.find((p) => p.root === project.root);

  const entry: RegisteredProject = existing
    ? { ...existing, id: project.id, name: project.name, lastOpenedAt: now }
    : { id: project.id, name: project.name, root: project.root, addedAt: now, lastOpenedAt: now };

  const projects = existing
    ? registry.projects.map((p) => (p.root === project.root ? entry : p))
    : [...registry.projects, entry];

  writeRegistry({ version: 1, projects }, home);
  return entry;
}

/** Bump lastOpenedAt for a known project. A no-op if it was never registered. */
export function touchProject(root: string, home?: string): void {
  const registry = readRegistry(home);
  const found = registry.projects.some((p) => p.root === root);
  if (!found) return;
  writeRegistry(
    {
      version: 1,
      projects: registry.projects.map((p) =>
        p.root === root ? { ...p, lastOpenedAt: Date.now() } : p,
      ),
    },
    home,
  );
}

export function listRegisteredProjects(home?: string): RegisteredProject[] {
  return [...readRegistry(home).projects].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt,
  );
}

export function unregisterProject(root: string, home?: string): void {
  const registry = readRegistry(home);
  writeRegistry(
    { version: 1, projects: registry.projects.filter((p) => p.root !== root) },
    home,
  );
}
