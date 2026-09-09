/**
 * Test fixture: a standalone process that answers `/api/instance` exactly as
 * a real UAssist server would, for a given port and project root.
 *
 * Run as a real child process (not imported) so reclaim.test.ts can exercise
 * an actual SIGTERM against an actual separate pid — the thing that matters
 * for "does the kill path work" cannot be faked in-process, since a test
 * cannot SIGTERM itself.
 *
 * Deliberately registers no SIGTERM handler: the default runtime behavior is
 * to terminate on SIGTERM, which is the general case reclaim.ts has to work
 * against (most processes, not just graceful ones).
 *
 * Usage: bun run fake-instance-server.ts <port> <root> [version]
 */

const port = Number(process.argv[2]);
const root = process.argv[3];
const version = process.argv[4] ?? "0.0.0-test";

if (!Number.isFinite(port) || !root) {
  console.error("usage: fake-instance-server.ts <port> <root> [version]");
  process.exit(2);
}

const startedAt = Date.now();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  routes: {
    "/api/instance": () =>
      Response.json({
        name: "uassist-server",
        version,
        pid: process.pid,
        port,
        root,
        startedAt,
      }),
  },
  fetch: () => new Response("not found", { status: 404 }),
});

// Signal readiness on stdout; the test waits for this line rather than
// polling immediately, since Bun.serve above is synchronous but the parent
// still needs a deterministic "go" signal over the pipe.
console.log("ready");
