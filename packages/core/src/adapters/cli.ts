/**
 * Generic CLI-spawning adapter.
 *
 * Every real adapter (opencode.ts, claudeCode.ts) is a thin config on top of
 * this: a command, how to turn a ContextPacket into argv/stdin, and how to
 * read one line of output. This module is deliberately the only place that
 * touches Bun.spawn, so process discipline — cwd, env allowlist, budget
 * timeout, stdout/stderr streaming — is enforced once, not once per adapter.
 *
 * See design/uassist-spec.md Part IX.
 */

import type { Budget, ContextPacket } from "../types.ts";
import type { AgentAdapter, AgentEvent, Capability, JobHandle } from "./types.ts";

export interface CliAdapterConfig {
  id: string;
  capabilities: Capability[];
  command: string;
  /** argv after the command, built from the assembled context packet. */
  buildArgs(packet: ContextPacket): string[];
  /** Piped to stdin if provided — some CLIs prefer a prompt over stdin to an
   *  argv string that would show up in `ps`. */
  stdin?(packet: ContextPacket): string | undefined;
  /** Parse one line of stdout into zero or more events. Default: the whole
   *  line becomes one "output" event, which is the right default for a CLI
   *  with no structured event protocol. */
  parseLine?: (line: string) => AgentEvent[];
}

interface RunningJob {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
}

/** Env vars a spawned agent actually needs — never the parent's full env. */
function agentEnv(): Record<string, string> {
  const allow = ["PATH", "HOME", "LANG", "TERM", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Split a stream of chunks into lines, holding back a trailing partial line
 *  until more data (or EOF) completes it. */
async function* toLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function createCliAdapter(config: CliAdapterConfig): AgentAdapter {
  const jobs = new Map<string, RunningJob>();
  let nextHandle = 1;

  return {
    id: config.id,
    capabilities: () => config.capabilities,

    async dispatch(packet: ContextPacket, worktree: string, budget: Budget): Promise<JobHandle> {
      const stdinText = config.stdin?.(packet);
      const proc = Bun.spawn({
        cmd: [config.command, ...config.buildArgs(packet)],
        cwd: worktree,
        env: agentEnv(),
        stdin: stdinText !== undefined ? new TextEncoder().encode(stdinText) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const handle: JobHandle = { id: String(nextHandle++) };
      const running: RunningJob = { proc, timer: undefined, timedOut: false };

      if (budget.maxDurationMs > 0) {
        running.timer = setTimeout(() => {
          running.timedOut = true;
          proc.kill();
        }, budget.maxDurationMs);
        running.timer.unref?.();
      }

      jobs.set(handle.id, running);
      return handle;
    },

    async *events(handle: JobHandle): AsyncIterable<AgentEvent> {
      const running = jobs.get(handle.id);
      if (!running) return;
      const { proc } = running;
      const parseLine = config.parseLine ?? ((line: string) => [{ kind: "output", text: line } as AgentEvent]);

      // stdout and stderr interleave as they arrive; each is read to
      // completion independently and both feed the same event stream.
      const merge = async function* () {
        const queues: AsyncIterable<string>[] = [];
        if (proc.stdout && typeof proc.stdout !== "number") queues.push(toLines(proc.stdout));
        if (proc.stderr && typeof proc.stderr !== "number") queues.push(toLines(proc.stderr));

        const iterators = queues.map((q) => q[Symbol.asyncIterator]());
        const pending = iterators.map((it, i) => it.next().then((r) => ({ i, r })));
        const live = new Set(iterators.map((_, i) => i));

        while (live.size > 0) {
          const { i, r } = await Promise.race(pending.filter((_, idx) => live.has(idx)));
          if (r.done) {
            live.delete(i);
            continue;
          }
          yield r.value;
          const it = iterators[i]!;
          pending[i] = it.next().then((res) => ({ i, r: res }));
        }
      };

      for await (const line of merge()) {
        for (const event of parseLine(line)) yield event;
      }

      const exitCode = await proc.exited;
      if (running.timer) clearTimeout(running.timer);
      jobs.delete(handle.id);
      yield { kind: "done", exitCode, timedOut: running.timedOut };
    },

    async cancel(handle: JobHandle): Promise<void> {
      const running = jobs.get(handle.id);
      if (!running) return;
      if (running.timer) clearTimeout(running.timer);
      running.proc.kill();
    },
  };
}
