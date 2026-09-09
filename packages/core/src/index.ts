/**
 * @uassist/core — domain model, store, plan parsing.
 *
 * See design/uassist-spec.md.
 */

export const VERSION = "0.1.0";

export * from "./ids.ts";
export * from "./types.ts";
export * from "./serialize.ts";
export * from "./mirror.ts";
export * from "./store.ts";
export * from "./plan/parse.ts";
export * from "./plan/sourceKey.ts";
export * from "./plan/import.ts";
export { SCHEMA_VERSION } from "./db/schema.ts";
export * from "./board.ts";
export * from "./llm.ts";
export * from "./registry.ts";
export * from "./workspace/types.ts";
export * from "./workspace/scan.ts";
export * from "./worktree.ts";
export * from "./packet.ts";
export * from "./dispatch.ts";
export * from "./adapters/types.ts";
export * from "./adapters/cli.ts";
export * from "./adapters/registry.ts";
export { createOpencodeAdapter } from "./adapters/opencode.ts";
export { createClaudeCodeAdapter } from "./adapters/claudeCode.ts";
export * from "./unity/bootstrap.ts";
export * from "./unity/spawn.ts";
export * from "./unity/verify.ts";
export * from "./bootstrap.ts";
export * from "./mcp/client.ts";
export * from "./reconcile.ts";
export * from "./scheduler.ts";
export * from "./validate.ts";
