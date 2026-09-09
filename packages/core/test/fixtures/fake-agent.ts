/**
 * Test fixture standing in for "any CLI coding agent": reads a prompt from
 * stdin, writes a file into its own cwd (the worktree, when run for real),
 * emits a few progress lines to stdout, and exits 0.
 *
 * Run as a real subprocess (not imported) so cli.ts's actual Bun.spawn /
 * streaming / cwd isolation is exercised, not simulated.
 *
 * Usage: bun run fake-agent.ts [--hang] [--fail]
 */

const args = process.argv.slice(2);

const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const prompt = Buffer.concat(chunks).toString("utf8");

console.log(`received objective: ${prompt.split("\n")[0]}`);
console.error("stderr: starting work");

if (args.includes("--hang")) {
  // Never exits on its own — used to prove the budget timeout kills it.
  await new Promise(() => {});
}

await Bun.write("agent-output.txt", `Wrote by the fake agent.\nPrompt was:\n${prompt}`);
console.log("done writing files");

if (args.includes("--fail")) {
  process.exit(1);
}
process.exit(0);
