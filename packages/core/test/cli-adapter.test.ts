import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliAdapter } from "../src/adapters/cli.ts";
import type { AgentEvent } from "../src/adapters/types.ts";
import type { ContextPacket } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "uassist-cli-adapter-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const packet: ContextPacket = {
  objective: "Add an Electric ammo type.",
  anchorState: {},
  files: [{ path: "Assets/Scripts/AmmoDatabase.cs", reason: "test" }],
  conventions: [],
  priorJobs: [],
  acceptance: ["Compiles"],
  constraints: [],
};

function adapter(extraArgs: string[] = []) {
  return createCliAdapter({
    id: "fake",
    capabilities: ["code.write"],
    command: process.execPath,
    buildArgs: () => ["run", FIXTURE, ...extraArgs],
    stdin: (p) => p.objective,
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("createCliAdapter", () => {
  test("streams stdout as output events and terminates with done", async () => {
    const worktree = scratch();
    const a = adapter();
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    const events = await collect(a.events(handle));

    const done = events.find((e) => e.kind === "done");
    expect(done).toEqual({ kind: "done", exitCode: 0, timedOut: false });

    const outputs = events.filter((e) => e.kind === "output").map((e) => (e as { text: string }).text);
    expect(outputs.some((t) => t.includes("received objective"))).toBe(true);
    expect(outputs.some((t) => t.includes("done writing files"))).toBe(true);
  });

  test("stdin actually reaches the child — the objective round-trips", async () => {
    const worktree = scratch();
    const a = adapter();
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    const events = await collect(a.events(handle));
    const outputs = events.filter((e) => e.kind === "output").map((e) => (e as { text: string }).text);
    expect(outputs.some((t) => t.includes(packet.objective))).toBe(true);
  });

  test("runs with cwd set to the worktree — the agent's file write lands there, nowhere else", async () => {
    const worktree = scratch();
    const a = adapter();
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    await collect(a.events(handle));

    const written = join(worktree, "agent-output.txt");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("Wrote by the fake agent");
  });

  test("stderr is captured too, not dropped", async () => {
    const worktree = scratch();
    const a = adapter();
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    const events = await collect(a.events(handle));
    const outputs = events.filter((e) => e.kind === "output").map((e) => (e as { text: string }).text);
    expect(outputs.some((t) => t.includes("starting work"))).toBe(true);
  });

  test("a non-zero exit is reported, not swallowed", async () => {
    const worktree = scratch();
    const a = adapter(["--fail"]);
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    const events = await collect(a.events(handle));
    const done = events.find((e) => e.kind === "done");
    expect(done).toEqual({ kind: "done", exitCode: 1, timedOut: false });
  });

  test("the budget's maxDurationMs actually kills a hung agent", async () => {
    const worktree = scratch();
    const a = adapter(["--hang"]);
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 300, maxAttempts: 1 });

    const start = Date.now();
    const events = await collect(a.events(handle));
    const elapsed = Date.now() - start;

    const done = events.find((e) => e.kind === "done") as { timedOut: boolean } | undefined;
    expect(done?.timedOut).toBe(true);
    // Generous upper bound — this asserts "killed near the budget," not an
    // exact timing, since CI/sandbox scheduling jitter is real.
    expect(elapsed).toBeLessThan(3000);
  });

  test("cancel() stops a running job before it would finish on its own", async () => {
    const worktree = scratch();
    const a = adapter(["--hang"]);
    const handle = await a.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });

    // Give the child a moment to actually start before cancelling.
    await Bun.sleep(100);
    await a.cancel(handle);

    const events = await collect(a.events(handle));
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
  });

  test("parseLine can translate structured output into typed events", async () => {
    const worktree = scratch();
    const structured = createCliAdapter({
      id: "structured",
      capabilities: [],
      command: process.execPath,
      buildArgs: () => ["run", FIXTURE],
      stdin: (p) => p.objective,
      parseLine: (line) =>
        line.includes("done writing")
          ? [{ kind: "cost", amountUsd: 0.02 }]
          : [{ kind: "output", text: line }],
    });

    const handle = await structured.dispatch(packet, worktree, { maxCostUsd: 1, maxDurationMs: 0, maxAttempts: 1 });
    const events = await collect(structured.events(handle));
    const cost = events.find((e) => e.kind === "cost");
    expect(cost).toEqual({ kind: "cost", amountUsd: 0.02 });
  });
});
