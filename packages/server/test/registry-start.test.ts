import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject, registerProject, unregisterProject } from "@uassist/core";
import { startServer } from "../src/index.ts";

/**
 * POST /api/registry/:id/start — the web UI's "start another project's
 * server from here" action (project.ts's registry section). This registers
 * a real (but temporary, always unregistered again in afterAll) entry in
 * the *real* ~/.uassist/registry.json, because that is exactly what the
 * endpoint under test reads — there is no test-only override for it, by
 * design: a running server should see every real registered project on
 * this machine, the same way `uassist status`/`uassist kill` do.
 */

let rootA: string; // the server making the request
let rootB: string; // the project being started, initially not running
let idB: string;
let baseUrlA: string;
let stopA: () => void;
let stopB: (() => void) | undefined;

beforeAll(async () => {
  rootA = mkdtempSync(join(tmpdir(), "uassist-registry-start-a-"));
  const initA = initProject(rootA, "RegistryStartA");
  initA.store.close();
  registerProject({ id: initA.project.id, name: initA.project.name, root: rootA });

  rootB = mkdtempSync(join(tmpdir(), "uassist-registry-start-b-"));
  const initB = initProject(rootB, "RegistryStartB");
  initB.store.close();
  idB = initB.project.id;
  registerProject({ id: idB, name: initB.project.name, root: rootB });

  const { server } = await startServer({ root: rootA, port: 58950 });
  baseUrlA = `http://127.0.0.1:${server.port}`;
  stopA = () => server.stop(true);
});

afterAll(() => {
  stopA?.();
  stopB?.();
  unregisterProject(rootA);
  unregisterProject(rootB);
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe("POST /api/registry/:id/start", () => {
  test("404s on an id that isn't registered", async () => {
    const res = await fetch(`${baseUrlA}/api/registry/project_nonexistent/start`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("starts a registered-but-not-running project's server", async () => {
    const res = await fetch(`${baseUrlA}/api/registry/${idB}/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const instanceRes = await fetch(`${body.url}/api/instance`);
    const instance = await instanceRes.json();
    expect(instance.root).toBe(rootB);

    // Registered so afterAll's cleanup can reach it even if a later
    // assertion in this file throws.
    stopB = () => {
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch {
        // already gone
      }
    };
  });

  test("calling it again reports already running, without spawning a second process", async () => {
    const res = await fetch(`${baseUrlA}/api/registry/${idB}/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(false);
    expect(body.reachable).toBe(true);
  });

  test("GET /api/registry reflects both as reachable", async () => {
    const res = await fetch(`${baseUrlA}/api/registry`);
    const body = await res.json();
    const entryA = body.projects.find((p: { root: string }) => p.root === rootA);
    const entryB = body.projects.find((p: { root: string }) => p.root === rootB);
    expect(entryA.self).toBe(true);
    expect(entryA.reachable).toBe(true);
    expect(entryB.reachable).toBe(true);
  });
});
