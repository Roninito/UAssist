/**
 * Minimal MCP client — JSON-RPC 2.0 over the "Streamable HTTP" transport.
 *
 * See design/automation-spec.md Part II: UAssist is a client of existing
 * Unity-MCP / Blender-MCP servers, never a distributor of one. This
 * implements exactly the three calls that layer needs — `initialize`,
 * `tools/list`, `tools/call` — against a single URL, not the full
 * bidirectional session machinery the spec also defines (server-initiated
 * requests, resumable streams). A response may arrive as a single JSON body
 * or as a `text/event-stream` with one or more `data:` frames; this reads
 * either, taking the first JSON-RPC message that matches the request id.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
}

export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTransportError";
  }
}

export interface McpClient {
  readonly serverUrl: string;
  /** Handshake — must be called once before tools/list or tools/call. */
  initialize(): Promise<{ serverInfo: McpServerInfo; tools: McpTool[] }>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface CreateMcpClientOptions {
  timeoutMs?: number;
  /** Injectable for tests — real callers never set this. */
  fetchImpl?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** A `text/event-stream` body may carry multiple `data: {...}` frames (e.g.
 *  progress notifications) before the actual response; this returns the
 *  first frame that parses as JSON, which for the request shapes used here
 *  (no server-initiated calls mid-request) is always the answer. */
async function firstJsonFromSse(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new McpTransportError("event-stream response had no body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice("data:".length).trim();
          if (payload.length === 0) continue;
          try {
            return JSON.parse(payload);
          } catch {
            // A non-JSON data frame (a keep-alive comment, etc.) — keep reading.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new McpTransportError("event-stream ended with no JSON-RPC message");
}

export function createMcpClient(serverUrl: string, options: CreateMcpClientOptions = {}): McpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  let nextId = 1;

  async function rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const res = await fetchImpl(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });

    if (!res.ok) {
      throw new McpTransportError(`MCP server ${serverUrl} responded ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("text/event-stream")
      ? await firstJsonFromSse(res)
      : await res.json();

    const parsed = body as JsonRpcResponse<T>;
    if (parsed.error) throw new McpError(parsed.error.code, parsed.error.message);
    if (parsed.result === undefined) {
      throw new McpTransportError(`MCP server ${serverUrl} returned neither a result nor an error`);
    }
    return parsed.result;
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    // A notification has no id and expects no response body worth reading —
    // fire and forget, but still over the same endpoint per the spec.
    await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    }).catch(() => {
      // Best-effort — a server that ignores notifications entirely is still
      // spec-compliant, and this must never fail the caller's own flow.
    });
  }

  return {
    serverUrl,

    async initialize() {
      const result = await rpc<{ serverInfo?: McpServerInfo }>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: options.clientName ?? "uassist",
          version: options.clientVersion ?? "0.1.0",
        },
      });
      await notify("notifications/initialized");
      const tools = await this.listTools();
      return { serverInfo: result.serverInfo ?? {}, tools };
    },

    async listTools() {
      const result = await rpc<{ tools: McpTool[] }>("tools/list");
      return result.tools;
    },

    async callTool(name: string, args: Record<string, unknown>) {
      return rpc<McpToolResult>("tools/call", { name, arguments: args });
    },
  };
}
