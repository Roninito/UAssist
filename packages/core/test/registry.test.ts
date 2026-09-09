import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listRegisteredProjects,
  registerProject,
  registryPath,
  touchProject,
  unregisterProject,
} from "../src/registry.ts";
import { newId } from "../src/ids.ts";

const dirs: string[] = [];
function fakeHome(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-registry-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("registry", () => {
  test("starts empty", () => {
    expect(listRegisteredProjects(fakeHome())).toEqual([]);
  });

  test("registering a project makes it listed", () => {
    const home = fakeHome();
    const id = newId("project");
    registerProject({ id, name: "ColonyEscape", root: "/projects/colony" }, home);

    const listed = listRegisteredProjects(home);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, name: "ColonyEscape", root: "/projects/colony" });
  });

  test("registering the same root twice updates rather than duplicates", () => {
    const home = fakeHome();
    const id = newId("project");
    registerProject({ id, name: "ColonyEscape", root: "/projects/colony" }, home);
    registerProject({ id, name: "Colony Escape (renamed)", root: "/projects/colony" }, home);

    const listed = listRegisteredProjects(home);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("Colony Escape (renamed)");
  });

  test("lists most-recently-opened first", async () => {
    const home = fakeHome();
    registerProject({ id: newId("project"), name: "A", root: "/a" }, home);
    await Bun.sleep(5);
    registerProject({ id: newId("project"), name: "B", root: "/b" }, home);
    await Bun.sleep(5);
    touchProject("/a", home);

    expect(listRegisteredProjects(home).map((p) => p.name)).toEqual(["A", "B"]);
  });

  test("touching an unregistered root is a harmless no-op", () => {
    const home = fakeHome();
    expect(() => touchProject("/never/registered", home)).not.toThrow();
    expect(listRegisteredProjects(home)).toEqual([]);
  });

  test("unregisterProject removes the entry", () => {
    const home = fakeHome();
    registerProject({ id: newId("project"), name: "A", root: "/a" }, home);
    unregisterProject("/a", home);
    expect(listRegisteredProjects(home)).toEqual([]);
  });

  test("the file on disk is not git-tracked project state — it lives under the given home", () => {
    const home = fakeHome();
    registerProject({ id: newId("project"), name: "A", root: "/a" }, home);
    const path = registryPath(home);
    expect(path.startsWith(home)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.projects).toHaveLength(1);
  });

  test("a corrupted registry file is treated as empty rather than throwing", () => {
    const home = fakeHome();
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(home, ".uassist"), { recursive: true });
    writeFileSync(join(home, ".uassist", "registry.json"), "{ not json", "utf8");

    expect(listRegisteredProjects(home)).toEqual([]);
    // And registering still works afterward — it does not stay wedged.
    registerProject({ id: newId("project"), name: "A", root: "/a" }, home);
    expect(listRegisteredProjects(home)).toHaveLength(1);
  });
});
