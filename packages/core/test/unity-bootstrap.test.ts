import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findUnityBinary,
  hubEditorRoot,
  listInstalledUnityVersions,
} from "../src/unity/bootstrap.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-unity-hub-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a fake Hub Editor directory for a given platform's binary layout. */
function fakeHubInstall(editorRoot: string, version: string, platform: NodeJS.Platform): string {
  let binPath: string;
  switch (platform) {
    case "darwin":
      binPath = join(editorRoot, version, "Unity.app", "Contents", "MacOS", "Unity");
      break;
    case "win32":
      binPath = join(editorRoot, version, "Editor", "Unity.exe");
      break;
    default:
      binPath = join(editorRoot, version, "Editor", "Unity");
  }
  mkdirSync(join(binPath, ".."), { recursive: true });
  writeFileSync(binPath, "#!/bin/sh\necho fake unity\n", "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("hubEditorRoot", () => {
  test("macOS: the conventional Applications path", () => {
    expect(hubEditorRoot("darwin", {})).toBe("/Applications/Unity/Hub/Editor");
  });

  test("Windows: derived from ProgramFiles", () => {
    expect(hubEditorRoot("win32", { ProgramFiles: "C:\\Program Files" })).toBe(
      "C:\\Program Files\\Unity\\Hub\\Editor",
    );
  });

  test("Windows without ProgramFiles set: undefined, not a guess", () => {
    expect(hubEditorRoot("win32", {})).toBeUndefined();
  });

  test("an unsupported platform: undefined", () => {
    expect(hubEditorRoot("freebsd" as NodeJS.Platform, {})).toBeUndefined();
  });
});

describe("listInstalledUnityVersions", () => {
  test("finds every version with an actual binary present", () => {
    const root = scratch();
    fakeHubInstall(root, "2022.3.10f1", "darwin");
    fakeHubInstall(root, "6000.4.10f1", "darwin");

    const installs = listInstalledUnityVersions(root, "darwin");
    expect(installs.map((i) => i.version).sort()).toEqual(["2022.3.10f1", "6000.4.10f1"]);
  });

  test("skips a version directory with no binary inside it", () => {
    const root = scratch();
    fakeHubInstall(root, "2022.3.10f1", "darwin");
    mkdirSync(join(root, "corrupted-install"), { recursive: true }); // no binary underneath

    const installs = listInstalledUnityVersions(root, "darwin");
    expect(installs.map((i) => i.version)).toEqual(["2022.3.10f1"]);
  });

  test("an editor root that does not exist: empty, not a throw", () => {
    expect(listInstalledUnityVersions("/definitely/not/real", "darwin")).toEqual([]);
  });

  test("newest-looking version sorts first", () => {
    const root = scratch();
    fakeHubInstall(root, "2021.3.5f1", "darwin");
    fakeHubInstall(root, "2022.3.10f1", "darwin");
    fakeHubInstall(root, "6000.4.10f1", "darwin");

    const installs = listInstalledUnityVersions(root, "darwin");
    expect(installs[0]?.version).toBe("6000.4.10f1");
  });
});

describe("findUnityBinary", () => {
  test("an explicit path wins outright", () => {
    const root = scratch();
    const explicit = fakeHubInstall(root, "explicit-version", "darwin");
    expect(findUnityBinary({ explicitPath: explicit })).toBe(explicit);
  });

  test("an explicit path that does not exist falls through to the Hub search, not a dead end", () => {
    const root = scratch();
    const fallback = fakeHubInstall(root, "6000.4.10f1", "darwin");
    const result = findUnityBinary({
      explicitPath: "/nonexistent/Unity",
      env: {},
      editorRoot: root,
      platform: "darwin",
    });
    expect(result).toBe(fallback);
  });

  test("UNITY_PATH env var is honored when set and real", () => {
    const root = scratch();
    const envBinary = fakeHubInstall(root, "env-version", "darwin");
    expect(findUnityBinary({ env: { UNITY_PATH: envBinary } })).toBe(envBinary);
  });

  test("falls back to the newest Hub install when UNITY_PATH is unset", () => {
    const root = scratch();
    fakeHubInstall(root, "2022.3.10f1", "darwin");
    const newest = fakeHubInstall(root, "6000.4.10f1", "darwin");

    const result = findUnityBinary({ env: {}, editorRoot: root, platform: "darwin" });
    expect(result).toBe(newest);
  });

  test("a preferred version is selected over the newest when both are installed", () => {
    const root = scratch();
    const preferred = fakeHubInstall(root, "2022.3.10f1", "darwin");
    fakeHubInstall(root, "6000.4.10f1", "darwin"); // newer, but not preferred

    const result = findUnityBinary({
      env: {},
      editorRoot: root,
      platform: "darwin",
      preferredVersion: "2022.3.10f1",
    });
    expect(result).toBe(preferred);
  });

  test("nothing installed anywhere: undefined, not a throw", () => {
    expect(findUnityBinary({ env: {}, editorRoot: "/nowhere", platform: "darwin" })).toBeUndefined();
  });
});

describe("diagnoseFailure", () => {
  // A real excerpt captured from this machine's own Unity 6000.4.10f1
  // failing headless project creation with no activated license — not a
  // guess at what Unity's log looks like.
  const REAL_LICENSE_FAILURE_LOG = `
[Licensing::Module] Licensing is not yet initialized.
[Licensing::Client] Code 1 while verifying Licensing Client signature (process Id: 38420, path: "/Applications/Unity/Hub/Editor/6000.4.10f1/Unity.app/Contents/Helpers/UnityLicensingClient.app/Contents/MacOS/Unity.Licensing.Client")
[Licensing::Module] LicensingClient has failed validation; ignoring
[Licensing::Module] Error: Access token is unavailable; failed to update
[Licensing::Client] Error: Code 404 while processing request (status: Found 0 entitlement groups and 0 free entitlements matching requested entitlement ids)
[Licensing::Module] Error: 'com.unity.editor.headless' was not found.
No valid Unity Editor license found. Please activate your license.
[Package Manager] Server process was shutdown`;

  test("names a real license failure specifically, not just the exit code", async () => {
    const { diagnoseFailure } = await import("../src/unity/bootstrap.ts");
    const message = diagnoseFailure(198, REAL_LICENSE_FAILURE_LOG);
    expect(message).toContain("license");
    expect(message.toLowerCase()).toContain("unity hub");
    expect(message).toContain("--unity-mode task");
  });

  test("an unrecognized failure still includes the exit code and log tail, not a dead end", async () => {
    const { diagnoseFailure } = await import("../src/unity/bootstrap.ts");
    const message = diagnoseFailure(1, "some unrelated batch-mode error\nwith no license signal in it");
    expect(message).toContain("1");
    expect(message).toContain("unrelated batch-mode error");
  });
});
