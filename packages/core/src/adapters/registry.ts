/**
 * Adapter lookup by id. Dispatch never constructs an adapter directly, so a
 * test-only adapter can be registered without touching production code paths.
 */

import { createClaudeCodeAdapter } from "./claudeCode.ts";
import { createOpencodeAdapter } from "./opencode.ts";
import type { AgentAdapter } from "./types.ts";

const builtins = new Map<string, () => AgentAdapter>([
  ["opencode", createOpencodeAdapter],
  ["claude-code", createClaudeCodeAdapter],
]);

const extra = new Map<string, AgentAdapter>();

export function getAdapter(id: string): AgentAdapter | undefined {
  const existing = extra.get(id);
  if (existing) return existing;
  const factory = builtins.get(id);
  return factory ? factory() : undefined;
}

export function listAdapterIds(): string[] {
  return [...new Set([...builtins.keys(), ...extra.keys()])];
}

/** For tests, and eventually for user-defined/local adapters. */
export function registerAdapter(adapter: AgentAdapter): void {
  extra.set(adapter.id, adapter);
}

export function unregisterAdapter(id: string): void {
  extra.delete(id);
}
