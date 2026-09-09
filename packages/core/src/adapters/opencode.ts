/**
 * The `opencode` adapter — local opencode CLI.
 *
 * opencode has no structured stdout protocol we parse against, so every line
 * becomes an "output" event and the objective is piped over stdin rather than
 * argv (keeps a long objective out of `ps` output). Flags are the plausible
 * shape for a one-shot, non-interactive run in a given directory; this is the
 * first thing to adjust once dispatched against a real installed binary.
 */

import { createCliAdapter } from "./cli.ts";
import type { ContextPacket } from "../types.ts";
import type { AgentAdapter } from "./types.ts";

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
    lines.push("");
  }
  if (packet.conventions.length > 0) {
    lines.push("Project conventions:");
    for (const c of packet.conventions) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

export function createOpencodeAdapter(): AgentAdapter {
  return createCliAdapter({
    id: "opencode",
    capabilities: ["code.read", "code.write", "test.run"],
    command: "opencode",
    buildArgs: () => ["run", "--non-interactive"],
    stdin: promptFor,
  });
}
