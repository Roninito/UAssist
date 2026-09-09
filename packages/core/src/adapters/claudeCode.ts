/**
 * The `claude-code` adapter — Anthropic's Claude Code CLI in non-interactive
 * mode. `--print --output-format stream-json` emits one JSON object per line
 * instead of opencode's plain text, so this adapter gets a `parseLine` that
 * extracts assistant text and cost where the shape is recognized.
 *
 * The exact stream-json field names are the part most likely to drift across
 * CLI versions. Parsing degrades on purpose: an unrecognized shape becomes a
 * passthrough "output" event with the raw line rather than being dropped, so
 * a version mismatch loses formatting, never information.
 */

import { createCliAdapter } from "./cli.ts";
import type { ContextPacket } from "../types.ts";
import type { AgentAdapter, AgentEvent } from "./types.ts";

function promptFor(packet: ContextPacket): string {
  const lines = [packet.objective, ""];
  if (packet.files.length > 0) {
    lines.push("Relevant files:");
    for (const f of packet.files) lines.push(`- ${f.path} (${f.reason})`);
    lines.push("");
  }
  if (packet.acceptance.length > 0) {
    lines.push("Acceptance criteria:");
    for (const a of packet.acceptance) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}

interface StreamJsonContentBlock {
  type?: string;
  text?: string;
}

interface StreamJsonLine {
  type?: string;
  subtype?: string;
  message?: { content?: StreamJsonContentBlock[] };
  total_cost_usd?: number;
  result?: string;
}

function parseStreamJsonLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(trimmed) as StreamJsonLine;
  } catch {
    return [{ kind: "output", text: line }];
  }

  const events: AgentEvent[] = [];

  const textBlocks = parsed.message?.content?.filter((b) => b.type === "text" && b.text);
  if (textBlocks && textBlocks.length > 0) {
    for (const block of textBlocks) events.push({ kind: "output", text: block.text! });
  } else if (parsed.type === "result" && parsed.result) {
    events.push({ kind: "output", text: parsed.result });
  }

  if (typeof parsed.total_cost_usd === "number") {
    events.push({ kind: "cost", amountUsd: parsed.total_cost_usd });
  }

  if (events.length === 0) {
    // A recognized envelope with nothing we extract from (a "system" init
    // event, a tool-use block, etc.) — still surfaced, just untranslated.
    events.push({ kind: "output", text: line });
  }

  return events;
}

export function createClaudeCodeAdapter(): AgentAdapter {
  return createCliAdapter({
    id: "claude-code",
    capabilities: ["code.read", "code.write", "test.run", "editor.tool"],
    command: "claude",
    buildArgs: () => ["--print", "--output-format", "stream-json"],
    stdin: promptFor,
    parseLine: parseStreamJsonLine,
  });
}
