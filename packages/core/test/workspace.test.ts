import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanBlenderAssets,
  scanUnityAssets,
  validateBlenderPath,
  validateUnityPath,
} from "../src/workspace/scan.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-workspace-"));
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

/** A minimal but structurally real Unity project. */
function buildFixtureUnityProject(root: string): void {
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });

  write(
    root,
    "Assets/Scripts/Inventory/ItemDatabase.cs",
    `namespace Colony.Inventory {\n  public class ItemDatabase : MonoBehaviour {\n    struct Entry { public string id; }\n  }\n}\n`,
  );
  write(root, "Assets/Scripts/Inventory/ItemDatabase.cs.meta", "guid: abc123\n");
  write(root, "Assets/Prefabs/Player.prefab", "%YAML 1.1\n--- fake prefab\n");
  write(root, "Assets/Scenes/Corridor.unity", "%YAML 1.1\n--- fake scene\n");
  write(root, "Assets/Materials/Metal.mat", "fake material");
  write(root, "Assets/Data/Items.asset", "fake scriptable object");
  write(root, "Assets/Audio/alarm.wav", "RIFF....");
  write(root, "Assets/Models/guard.fbx", "fake mesh binary");

  // Noise that must never appear in the catalog.
  write(root, "Library/ArtifactDB", "binary junk");
  write(root, "Temp/somefile", "scratch");
  write(root, "Assets/Scripts/obj/Debug/generated.cs", "// build output, inside an obj/ dir");
}

describe("validateUnityPath", () => {
  test("a real Unity project root is valid", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    expect(validateUnityPath(root)).toEqual({ path: root, valid: true });
  });

  test("a random empty directory is not", () => {
    const root = scratch();
    const result = validateUnityPath(root);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Assets");
  });

  test("Assets/ without ProjectSettings/ is not", () => {
    const root = scratch();
    mkdirSync(join(root, "Assets"));
    const result = validateUnityPath(root);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("ProjectSettings");
  });

  test("a path that does not exist is not", () => {
    const result = validateUnityPath("/definitely/not/a/real/path/xyz");
    expect(result.valid).toBe(false);
  });

  test("an application bundle is rejected even if it happens to have Assets/ and ProjectSettings/-named dirs inside", () => {
    const root = scratch();
    const bundle = join(root, "Unity.app");
    write(bundle, "Contents/Info.plist", "<plist/>");
    mkdirSync(join(bundle, "Assets"), { recursive: true });
    mkdirSync(join(bundle, "ProjectSettings"), { recursive: true });

    const result = validateUnityPath(bundle);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("application bundle");
  });
});

describe("validateBlenderPath", () => {
  test("a directory containing a .blend file is valid", () => {
    const root = scratch();
    write(root, "sectors/corridor.blend", "fake blend binary");
    expect(validateBlenderPath(root)).toEqual({ path: root, valid: true });
  });

  test("a directory with no .blend files is not", () => {
    const root = scratch();
    write(root, "notes.txt", "hello");
    const result = validateBlenderPath(root);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(".blend");
  });

  test("a real incident: an application bundle that ships its own internal .blend files is rejected, not linked", () => {
    // Reproduces /Applications/Blender.app exactly: a real .app bundle
    // ships startup/template .blend files inside Contents/Resources/,
    // which used to make the naive ".blend exists somewhere under here"
    // check pass — then a scan catalogued the bundle's Python runtime.
    const root = scratch();
    const bundle = join(root, "Blender.app");
    write(bundle, "Contents/Info.plist", "<plist/>");
    write(bundle, "Contents/Resources/datafiles/startup.blend", "fake blend binary");
    write(bundle, "Contents/Resources/python/lib/_socket.cpython-311-darwin.so", "fake binary");

    const result = validateBlenderPath(bundle);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("application bundle");
  });

  test("a bundle without the .app suffix is still caught via Contents/Info.plist", () => {
    const root = scratch();
    const bundle = join(root, "SomeApp"); // renamed, no .app suffix
    write(bundle, "Contents/Info.plist", "<plist/>");
    write(bundle, "Contents/Resources/startup.blend", "fake blend binary");

    expect(validateBlenderPath(bundle).valid).toBe(false);
  });
});

describe("scanUnityAssets", () => {
  test("classifies real assets by extension", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    const { assets, warnings } = scanUnityAssets(root);
    expect(warnings).toEqual([]);

    const byPath = Object.fromEntries(assets.map((a) => [a.path, a]));
    expect(byPath["Scripts/Inventory/ItemDatabase.cs"]?.kind).toBe("script");
    expect(byPath["Prefabs/Player.prefab"]?.kind).toBe("prefab");
    expect(byPath["Scenes/Corridor.unity"]?.kind).toBe("scene");
    expect(byPath["Materials/Metal.mat"]?.kind).toBe("material");
    expect(byPath["Data/Items.asset"]?.kind).toBe("scriptableObject");
    expect(byPath["Audio/alarm.wav"]?.kind).toBe("audio");
    expect(byPath["Models/guard.fbx"]?.kind).toBe("mesh");
  });

  test("extracts class and struct names from scripts", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    const { assets } = scanUnityAssets(root);
    const script = assets.find((a) => a.path.endsWith("ItemDatabase.cs"));
    expect(script?.classNames?.sort()).toEqual(["Entry", "ItemDatabase"]);
  });

  test("never includes Library/, Temp/, or an obj/ directory", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    const { assets } = scanUnityAssets(root);
    expect(assets.some((a) => a.path.includes("Library"))).toBe(false);
    expect(assets.some((a) => a.path.includes("Temp"))).toBe(false);
    expect(assets.some((a) => a.path.includes("/obj/"))).toBe(false);
  });

  test("never includes Unity's .meta sidecar files", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    const { assets } = scanUnityAssets(root);
    expect(assets.some((a) => a.path.endsWith(".meta"))).toBe(false);
  });

  test("a workspace with no Assets/ yet scans to nothing, not an error", () => {
    const root = scratch();
    mkdirSync(join(root, "ProjectSettings"), { recursive: true });
    const { assets, warnings } = scanUnityAssets(root);
    expect(assets).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("respects .uassistignore (at the Unity project root) for an extra excluded directory", () => {
    const root = scratch();
    buildFixtureUnityProject(root);
    write(root, "Assets/Generated/Junk.cs", "class Junk {}");
    write(root, ".uassistignore", "Generated\n"); // sits next to ProjectSettings/, not inside Assets/

    const { assets } = scanUnityAssets(root);
    expect(assets.some((a) => a.path.includes("Generated"))).toBe(false);
    // The rest of the fixture is untouched by the ignore rule.
    expect(assets.some((a) => a.path.endsWith("ItemDatabase.cs"))).toBe(true);
  });

  test("hashes change when a script's content changes, at the same path", () => {
    const root = scratch();
    write(root, "Assets/Foo.cs", "class Foo {}");
    const before = scanUnityAssets(root).assets[0]!;

    write(root, "Assets/Foo.cs", "class Foo { void Bar() {} }");
    const after = scanUnityAssets(root).assets[0]!;

    expect(after.hash).not.toBe(before.hash);
    expect(after.path).toBe(before.path);
  });
});

describe("scanBlenderAssets", () => {
  test("finds .blend files under the source root", () => {
    const root = scratch();
    write(root, "sectors/corridor.blend", "fake blend binary");
    write(root, "sectors/hangar.blend", "fake blend binary");
    write(root, "readme.txt", "not an asset");

    const { assets } = scanBlenderAssets(root);
    expect(assets.filter((a) => a.kind === "blend")).toHaveLength(2);
    expect(assets.every((a) => a.source === "blender")).toBe(true);
  });

  test("never catalogues an embedded runtime's internals (Contents/, site-packages/, lib-dynload/, __pycache__/)", () => {
    const root = scratch();
    write(root, "sectors/corridor.blend", "fake blend binary");
    write(root, "Contents/Resources/python/lib-dynload/_socket.cpython-311-darwin.so", "fake binary");
    write(root, "Contents/Resources/python/site-packages/foo.py", "# fake");
    write(root, "vendor/tool/__pycache__/mod.cpython-311.pyc", "fake bytecode");

    const { assets } = scanBlenderAssets(root);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.kind).toBe("blend");
  });
});
