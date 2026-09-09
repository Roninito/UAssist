import { afterEach, describe, expect, test } from "bun:test";

import { createMcpClient, McpError, McpTransportError } from "../src/mcp/client.ts";

/**
 * A real MCP server, speaking real JSON-RPC 2.0 over HTTP — spun up
 * in-process per test via Bun.serve, the same pattern reclaim.test.ts uses
 * for canBind. The client is exercised against this real wire protocol, not
 * a mocked fetch — the thing worth verifying is the actual request/response
 * shapes, including the text/event-stream path a real "Streamable HTTP"
 * server is allowed to use instead of plain JSON.
 */

interface FakeServerOptions {
  /** "json" | "sse" — which response shape the server answers with. */
  mode?: "json" | "sse";
  /** Extra per-method behavior, e.g. delaying to test timeouts. */
  delayMs?: number;
}

const TOOLS = [
  { name: "get_scene_info", description: "Returns the active scene's hierarchy" },
  { name: "get_selected_object", description: "Returns the currently selected GameObject" },
];

function startFakeMcpServer(options: FakeServerOptions = {}) {
  const mode = options.mode ?? "json";

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const body = (await req.json()) as { id?: number | string; method: string; params?: any };

      if (options.delayMs) await Bun.sleep(options.delayMs);

      // A notification (no id) — no response body expected.
      if (body.id === undefined) return new Response(null, { status: 202 });

      let result: unknown;
      let error: { code: number; message: string } | undefined;

      switch (body.method) {
        case "initialize":
          result = { serverInfo: { name: "fake-unity-mcp", version: "0.0.1" } };
          break;
        case "tools/list":
          result = { tools: TOOLS };
          break;
        case "tools/call": {
          const name = body.params?.name;
          if (name === "get_scene_info") {
            result = { content: [{ type: "text", text: "Scene: Corridor (3 root objects)" }] };
          } else if (name === "boom") {
            error = { code: -32000, message: "tool execution failed: boom" };
          } else {
            error = { code: -32601, message: `unknown tool: ${name}` };
          }
          break;
        }
        default:
          error = { code: -32601, message: `unknown method: ${body.method}` };
      }

      const rpcBody = { jsonrpc: "2.0", id: body.id, ...(error ? { error } : { result }) };

      if (mode === "sse") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(rpcBody)}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(rpcBody);
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe.each([["json"], ["sse"]] as const)("createMcpClient — %s transport", (mode) => {
  test("initialize returns server info and the tool list", async () => {
    const { url, stop } = startFakeMcpServer({ mode });
    cleanups.push(stop);

    const client = createMcpClient(url);
    const { serverInfo, tools } = await client.initialize();

    expect(serverInfo.name).toBe("fake-unity-mcp");
    expect(tools.map((t) => t.name).sort()).toEqual(["get_scene_info", "get_selected_object"]);
  });

  test("listTools works standalone, without a prior initialize call", async () => {
    const { url, stop } = startFakeMcpServer({ mode });
    cleanups.push(stop);

    const client = createMcpClient(url);
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
  });

  test("callTool round-trips a real result", async () => {
    const { url, stop } = startFakeMcpServer({ mode });
    cleanups.push(stop);

    const client = createMcpClient(url);
    const result = await client.callTool("get_scene_info", {});

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Corridor");
  });

  test("a JSON-RPC error response becomes a typed McpError, not a silent failure", async () => {
    const { url, stop } = startFakeMcpServer({ mode });
    cleanups.push(stop);

    const client = createMcpClient(url);
    await expect(client.callTool("boom", {})).rejects.toBeInstanceOf(McpError);
    await expect(client.callTool("boom", {})).rejects.toThrow("boom");
  });

  test("an unknown tool name reports the specific error, not a generic one", async () => {
    const { url, stop } = startFakeMcpServer({ mode });
    cleanups.push(stop);

    const client = createMcpClient(url);
    await expect(client.callTool("not_a_real_tool", {})).rejects.toThrow(/unknown tool/);
  });
});

describe("createMcpClient — transport-level failures", () => {
  test("a non-2xx HTTP response is a McpTransportError, not swallowed", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    cleanups.push(() => server.stop(true));

    const client = createMcpClient(`http://127.0.0.1:${server.port}`);
    await expect(client.listTools()).rejects.toBeInstanceOf(McpTransportError);
  });

  test("an unreachable server rejects rather than hanging forever", async () => {
    // Port with (almost certainly) nothing listening.
    const client = createMcpClient("http://127.0.0.1:1");
    await expect(client.listTools()).rejects.toThrow();
  });

  test("timeoutMs is honored against a slow server", async () => {
    const { url, stop } = startFakeMcpServer({ delayMs: 2000 });
    cleanups.push(stop);

    const client = createMcpClient(url, { timeoutMs: 200 });
    const start = Date.now();
    await expect(client.listTools()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1500);
  });
});
