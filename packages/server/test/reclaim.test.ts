import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  canBind,
  decidePortAction,
  findPortOwner,
  pruneDeadInstanceFile,
  reclaimPort,
  type PortOwner,
} from "../src/reclaim.ts";
import {
  INSTANCE_NAME,
  readInstanceFile,
  removeInstanceFile,
  writeInstanceFile,
  type Instance,
} from "../src/instance.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-instance-server.ts");

/** Ports spread out per test so parallel runs don't collide with each other
 *  or with a real UAssist dev server on 7373. */
let nextPort = 58100;
function port(): number {
  return nextPort++;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function instanceFor(overrides: Partial<Instance> = {}): Instance {
  return {
    name: INSTANCE_NAME,
    version: "0.0.0-test",
    pid: 999999, // never a real pid in these unit tests
    port: 12345,
    root: "/project/a",
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decidePortAction — pure logic, the part that decides whether to kill
// ---------------------------------------------------------------------------

describe("decidePortAction", () => {
  test("nothing owns the port and nothing answers: already-free", () => {
    expect(decidePortAction(undefined, undefined, "/project/a")).toEqual({
      action: "already-free",
    });
  });

  test("confirmed UAssist for our own project: reclaim", () => {
    const inst = instanceFor({ root: "/project/a", pid: 4242 });
    const owner: PortOwner = { pid: 4242, command: "bun" };
    expect(decidePortAction(owner, inst, "/project/a")).toEqual({
      action: "reclaim",
      instance: inst,
    });
  });

  test("confirmed UAssist with no OS-level owner info still reclaims", () => {
    // findPortOwner can fail to resolve (lsof missing, permissions) even
    // when the HTTP probe succeeds. The probe alone is enough to act.
    const inst = instanceFor({ root: "/project/a" });
    expect(decidePortAction(undefined, inst, "/project/a")).toEqual({
      action: "reclaim",
      instance: inst,
    });
  });

  test("confirmed UAssist for a DIFFERENT project: never reclaim", () => {
    const inst = instanceFor({ root: "/project/other", pid: 4242 });
    const owner: PortOwner = { pid: 4242, command: "bun" };
    expect(decidePortAction(owner, inst, "/project/a")).toEqual({
      action: "different-project",
      instance: inst,
    });
  });

  test("the OS-reported pid disagrees with what the probe claims: back off", () => {
    // Something is fronting the port, or the probe answer is not trustworthy.
    // This must never resolve to "reclaim" even though root matches.
    const inst = instanceFor({ root: "/project/a", pid: 4242 });
    const owner: PortOwner = { pid: 9999, command: "bun" };
    const decision = decidePortAction(owner, inst, "/project/a");
    expect(decision.action).toBe("unidentified");
  });

  test("something is listening but never confirms as UAssist: unidentified, never killed", () => {
    const owner: PortOwner = { pid: 555, command: "postgres" };
    expect(decidePortAction(owner, undefined, "/project/a")).toEqual({
      action: "unidentified",
      owner,
    });
  });

  test("root comparison is exact, not a prefix match", () => {
    // "/project/a-old" must not be treated as project "/project/a".
    const inst = instanceFor({ root: "/project/a-old", pid: 1 });
    const owner: PortOwner = { pid: 1, command: "bun" };
    expect(decidePortAction(owner, inst, "/project/a").action).toBe(
      "different-project",
    );
  });
});

// ---------------------------------------------------------------------------
// canBind — real sockets
// ---------------------------------------------------------------------------

describe("canBind", () => {
  test("true for a free port, false while something holds it", async () => {
    const p = port();
    expect(await canBind(p, "127.0.0.1")).toBe(true);

    const held = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response() });
    cleanups.push(() => held.stop(true));
    expect(await canBind(p, "127.0.0.1")).toBe(false);

    held.stop(true);
    expect(await canBind(p, "127.0.0.1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findPortOwner — shells out to lsof; skipped where lsof is unavailable
// ---------------------------------------------------------------------------

const hasLsof = await Bun.$`which lsof`.quiet().nothrow().then((r) => r.exitCode === 0);

describe.skipIf(!hasLsof)("findPortOwner", () => {
  test("reports the pid holding a bound port", async () => {
    const p = port();
    const held = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response() });
    cleanups.push(() => held.stop(true));

    const owner = await findPortOwner(p);
    expect(owner?.pid).toBe(process.pid);
  });

  test("returns undefined for a free port", async () => {
    expect(await findPortOwner(port())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reclaimPort — end to end, including a real subprocess for the kill path
// ---------------------------------------------------------------------------

interface FakeInstance {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
}

/** Spawn the fixture and wait for it to report itself ready and reachable. */
async function spawnFakeInstance(root: string): Promise<FakeInstance> {
  const p = port();
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", FIXTURE, String(p), root],
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!value || !new TextDecoder().decode(value).includes("ready")) {
    proc.kill();
    throw new Error("fixture server did not report ready");
  }

  // The readiness line confirms Bun.serve returned; the route is live
  // immediately after, but poll briefly in case of scheduler jitter.
  for (let i = 0; i < 50; i++) {
    if (!(await canBind(p, "127.0.0.1"))) break;
    await Bun.sleep(20);
  }

  return { proc, port: p };
}

describe("reclaimPort", () => {
  test("already free: no-op", async () => {
    const result = await reclaimPort(port(), "127.0.0.1", "/project/a");
    expect(result.action).toBe("already-free");
  });

  test("reclaims a stale instance of the SAME project and frees the port", async () => {
    const root = "/project/mine";
    const fake = await spawnFakeInstance(root);
    cleanups.push(() => fake.proc.kill());

    expect(await canBind(fake.port, "127.0.0.1")).toBe(false);

    const result = await reclaimPort(fake.port, "127.0.0.1", root, {
      termGraceMs: 1500,
      totalTimeoutMs: 3000,
    });

    expect(result.action).toBe("reclaimed");
    expect(await canBind(fake.port, "127.0.0.1")).toBe(true);
    expect(await fake.proc.exited).toBeTypeOf("number"); // resolved: process is gone
  });

  test("leaves a DIFFERENT project's instance running untouched", async () => {
    const fake = await spawnFakeInstance("/project/someone-elses");
    cleanups.push(() => fake.proc.kill());

    const result = await reclaimPort(fake.port, "127.0.0.1", "/project/mine");

    expect(result.action).toBe("different-project");
    // Still bound — nothing was killed.
    expect(await canBind(fake.port, "127.0.0.1")).toBe(false);
    expect(fake.proc.killed).toBe(false);
  });

  test("leaves an unidentified process running untouched", async () => {
    const p = port();
    // A plain server with no /api/instance route — never confirms as UAssist.
    const plain = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("hi") });
    cleanups.push(() => plain.stop(true));

    const result = await reclaimPort(p, "127.0.0.1", "/project/mine");

    expect(result.action).toBe("unidentified");
    expect(await canBind(p, "127.0.0.1")).toBe(false); // still bound
  });
});

// ---------------------------------------------------------------------------
// pidfile ownership — the race guard in instance.ts
// ---------------------------------------------------------------------------

describe("pidfile ownership", () => {
  test("removeInstanceFile with an expectedPid leaves a file owned by someone else alone", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "uassist-pidfile-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    writeInstanceFile(dir, instanceFor({ pid: 111 }));
    // A different process (pid 222) tries to clean up its own exit and must
    // not delete pid 111's file.
    removeInstanceFile(dir, 222);
    expect(readInstanceFile(dir)?.pid).toBe(111);

    // The actual owner cleans up fine.
    removeInstanceFile(dir, 111);
    expect(readInstanceFile(dir)).toBeUndefined();
  });

  test("pruneDeadInstanceFile clears a pidfile naming a dead pid", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "uassist-pidfile-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // PID 1 is unlikely to be killable/owned by us, but a genuinely
    // unreachable high pid is a cleaner "definitely dead" fixture.
    writeInstanceFile(dir, instanceFor({ pid: 99999999 }));
    await pruneDeadInstanceFile(dir);
    expect(readInstanceFile(dir)).toBeUndefined();
  });

  test("pruneDeadInstanceFile leaves a pidfile naming a live pid alone", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "uassist-pidfile-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    writeInstanceFile(dir, instanceFor({ pid: process.pid }));
    await pruneDeadInstanceFile(dir);
    expect(readInstanceFile(dir)?.pid).toBe(process.pid);
  });
});
