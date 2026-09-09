/**
 * Agent adapter contract.
 *
 * See design/uassist-spec.md Part IX and unity-assistant-spec.md Part VI
 * (capabilities). An adapter wraps one CLI agent; the dispatcher (dispatch.ts)
 * is the only thing that talks to adapters directly.
 */

import type { Budget, ContextPacket } from "../types.ts";

export const CAPABILITIES = [
  "code.read",
  "code.write",
  "code.delete",
  "asset.read",
  "asset.write",
  "editor.tool",
  "generate",
  "net",
  "test.run",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface JobHandle {
  /** Opaque to the dispatcher; only the adapter that issued it interprets it. */
  id: string;
}

export type AgentEvent =
  | { kind: "output"; text: string }
  | { kind: "question"; question: string; options?: string[] }
  | { kind: "cost"; amountUsd: number }
  | { kind: "done"; exitCode: number; timedOut: boolean };

export interface AgentAdapter {
  readonly id: string;
  capabilities(): Capability[];
  /** Start the agent in `worktree`, cwd'd there, budget-limited. */
  dispatch(packet: ContextPacket, worktree: string, budget: Budget): Promise<JobHandle>;
  /** Push-streamed events — see design/uassist-spec.md Part IX, "Bun gives us
   *  async iteration over a child's stdout instead of polling." */
  events(handle: JobHandle): AsyncIterable<AgentEvent>;
  cancel(handle: JobHandle): Promise<void>;
}
