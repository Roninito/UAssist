#!/usr/bin/env bun
/**
 * uassist — command-line control.
 *
 * See design/uassist-spec.md Part XVI.
 */

import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";

import {
  applySuggestion,
  ApplySuggestionError,
  bootstrapProject,
  importPlan,
  listRegisteredProjects,
  runValidators,
  scanAndReconcile,
  Store,
  STATUSES,
  SUGGESTION_STATUSES,
  validateBlenderPath,
  validateUnityPath,
  VERSION,
  type AttachAnchorPayload,
  type BootstrapOptions,
  type Card,
  type CreateCardPayload,
  type ImportResult,
  type MilestoneId,
  type Status,
  type SuggestionStatus,
  type UpdateCardStatusPayload,
} from "@uassist/core";
import { probeInstance, type Instance } from "@uassist/server/instance.ts";
import { terminateAndWait } from "@uassist/server/reclaim.ts";
import { ServerBinaryNotFoundError, spawnServer } from "@uassist/server/spawn.ts";

const HELP = `uassist ${VERSION} — project coordination for Unity and Blender

USAGE
  uassist <command> [options]

COMMANDS
  init [--name <name>]           Initialize .uassist/ and set up the workspace.
                                  With no flags, creates a Unity setup task —
                                  a project is never left silently unlinked.
      --unity-path <path>          Link an existing, validated Unity project
      --unity-mode headless|task   Create one headlessly, or via a setup card
      --unity-target <path>        Where headless creation writes (default:
                                    <root>/UnityProject)
      --blender-path <path>        Link an existing Blender source directory
      --blender                    Create a Blender setup task
      --no-bootstrap                Skip the default setup-card safety net
  plan import <file> [--dry-run] Import or re-ingest a Markdown build plan
  cards [--status <s>] [--milestone <id>] [--category <c>]
                                 List cards
  milestones                     List milestones with progress
  workspace scan                 Scan linked Unity/Blender paths into the Asset Catalog
  workspace status                Show workspace link validity and catalog summary
  suggestions [--status <s>]     List the Decisions queue (default: pending)
  suggestions accept <id>        Accept a suggestion — writes the card/anchor it proposes
  suggestions reject <id>        Reject a suggestion — it will not resurface
  suggestions hold <id>          Hold a suggestion for later
  validate                       Run validators (broken anchors, Unity compile) and report health items
  db rebuild                     Drop SQLite and replay the JSON mirror

  start [--port <n>] [--open]    Start the server in the background for this project
  stop                           Stop this project's running server
  open                           Open this project's board in the browser (starts nothing)
  kill                           Stop every UAssist server registered on this machine
  status                         Server status for this project, other known projects, and a project data summary
  version                        Print version

OPTIONS
  -C, --cwd <dir>                Run against another project root
  -h, --help                     Show this help
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: "string" },
    status: { type: "string" },
    milestone: { type: "string" },
    category: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    cwd: { type: "string", short: "C" },
    help: { type: "boolean", short: "h", default: false },
    // init / workspace bootstrap — design/automation-spec.md Part I
    "unity-path": { type: "string" },
    "unity-mode": { type: "string" },
    "unity-target": { type: "string" },
    "blender-path": { type: "string" },
    blender: { type: "boolean", default: false },
    "no-bootstrap": { type: "boolean", default: false },
    // start/stop/open/kill
    port: { type: "string" },
    open: { type: "boolean", default: false },
  },
});

const root = resolve(values.cwd ?? process.cwd());

function die(message: string): never {
  console.error(`uassist: ${message}`);
  process.exit(1);
}

function openStore(): Store {
  try {
    return new Store(root, { mirrorDebounceMs: 0, readOnly: true });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const STATUS_COLOR: Record<Status, string> = {
  open: "\x1b[37m",
  active: "\x1b[36m",
  blocked: "\x1b[31m",
  review: "\x1b[33m",
  done: "\x1b[32m",
};

function statusChip(status: Status): string {
  return `${STATUS_COLOR[status] ?? ""}${status.padEnd(7)}\x1b[0m`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printCard(c: Card): void {
  const accepted = c.acceptance.filter((a) => a.met).length;
  const acc =
    c.acceptance.length > 0 ? dim(` ${accepted}/${c.acceptance.length}`) : "";
  const kind = c.kind === "task" ? "" : dim(` [${c.kind}]`);
  console.log(
    `  ${statusChip(c.status)} ${dim(c.category.padEnd(9))} ${truncate(c.title, 66)}${kind}${acc}`,
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Initialization is prime infrastructure, not an optional step — see
 * design/automation-spec.md Part I. `bootstrapProject` is what makes that
 * true: a project never comes out of `init` silently unlinked with nothing
 * marking the gap. Absent any workspace flag at all, the default is the
 * safe one — a dispatchable Unity setup card, not a guess, not a skip.
 */
async function cmdInit(): Promise<void> {
  const name = values.name ?? basename(root);

  const unityMode = values["unity-mode"];
  if (unityMode !== undefined && unityMode !== "headless" && unityMode !== "task") {
    die(`--unity-mode must be "headless" or "task", got "${unityMode}"`);
  }

  const anyWorkspaceFlag = Boolean(
    values["unity-path"] || unityMode || values["blender-path"] || values.blender,
  );

  let unity: BootstrapOptions["unity"];
  if (values["unity-path"]) {
    unity = { mode: "existing", path: resolve(values["unity-path"]) };
  } else if (unityMode === "headless") {
    unity = {
      mode: "headless",
      targetPath: values["unity-target"] ? resolve(values["unity-target"]) : undefined,
    };
  } else if (unityMode === "task") {
    unity = { mode: "task" };
  } else if (!anyWorkspaceFlag && !values["no-bootstrap"]) {
    // Nothing specified at all: default to the safe, always-available path
    // rather than let the project quietly start with no workspace and no
    // record that anyone should do anything about it.
    unity = { mode: "task" };
  }

  let blender: BootstrapOptions["blender"];
  if (values["blender-path"]) {
    blender = { mode: "existing", path: resolve(values["blender-path"]) };
  } else if (values.blender) {
    blender = { mode: "task" };
  }

  const result = await bootstrapProject({ root, name, unity, blender });

  console.log(`Initialized UAssist project ${bold(result.project.name)}`);
  console.log(dim(`  ${result.store.dir}`));

  if (result.unity) {
    if (result.unity.linked) {
      console.log(`  ${bold("Unity")}    linked and scanned: ${result.unity.path}`);
    } else if (result.unity.error) {
      console.log(`  ${bold("Unity")}    ${result.unity.error}`);
    }
  }
  if (result.blender) {
    if (result.blender.linked) {
      console.log(`  ${bold("Blender")}  linked and scanned: ${result.blender.path}`);
    } else if (result.blender.error) {
      console.log(`  ${bold("Blender")}  ${result.blender.error}`);
    }
  }
  for (const card of result.setupCards) {
    console.log(dim(`  created setup card: "${card.title}" — dispatch it, or complete by hand and link the path.`));
  }

  if (result.workspaceComplete) {
    console.log(dim(`  next: uassist plan import <plan.md>`));
  } else {
    console.log(
      `  ${bold("workspace incomplete")} — no valid Unity or Blender path linked yet. \`uassist workspace status\` shows current state.`,
    );
  }

  result.store.close();
}

function reportImport(result: ImportResult, file: string): void {
  const verb = result.applied ? "Imported" : "Dry run";
  console.log(`${verb} ${bold(basename(file))}`);
  console.log(
    `  milestones  ${result.addedMilestones.length} added, ${result.updatedMilestones.length} updated`,
  );
  console.log(
    `  cards       ${result.addedCards.length} added, ${result.updatedCards.length} updated, ${result.renamedCards.length} renamed`,
  );

  for (const { from, to, similarity } of result.renamedCards) {
    console.log(dim(`    rename (${(similarity * 100).toFixed(0)}%)`));
    console.log(dim(`      - ${truncate(from.title, 70)}`));
    console.log(dim(`      + ${truncate(to.title, 70)}`));
  }

  if (result.orphanedCards.length > 0) {
    console.log(
      `  ${bold("orphaned")}    ${result.orphanedCards.length} card(s) in the store are no longer in the plan:`,
    );
    for (const c of result.orphanedCards) {
      console.log(`    ${dim("·")} ${truncate(c.title, 70)}`);
    }
    console.log(dim("    Not deleted. Remove them by hand if the plan is right."));
  }

  for (const w of result.warnings) console.log(`  ${dim("warning:")} ${w}`);
}

async function cmdPlanImport(): Promise<void> {
  const file = positionals[2];
  if (!file) die("plan import needs a file — `uassist plan import plan.md`");
  const path = resolve(file);
  if (!existsSync(path)) die(`no such file: ${file}`);

  const store = openStore();
  const markdown = await Bun.file(path).text();
  const result = importPlan(store, markdown, path, {
    dryRun: values["dry-run"],
  });
  if (result.applied) {
    // Remembered so a later re-import from the web UI (Project Meta page)
    // does not require re-typing the path.
    const project = store.getProject();
    if (project) store.putProject({ ...project, planSourcePath: path });
  }
  reportImport(result, path);
  store.close();
}

function cmdCards(): void {
  const store = openStore();

  const status = values.status as Status | undefined;
  if (status && !STATUSES.includes(status)) {
    die(`unknown status "${status}" — one of: ${STATUSES.join(", ")}`);
  }

  const cards = store.listCards({
    status,
    milestoneId: values.milestone as MilestoneId | undefined,
    category: values.category,
  });

  if (cards.length === 0) {
    console.log("No cards match.");
    store.close();
    return;
  }

  // Group under milestone headings so the output reads like the plan.
  const milestones = new Map(store.listMilestones().map((m) => [m.id, m]));
  let lastLane: string | undefined;
  for (const card of cards) {
    let lane = "Unassigned";
    if (card.milestoneId) {
      const m = milestones.get(card.milestoneId);
      if (m) {
        lane =
          m.phaseNumber !== undefined
            ? `Phase ${m.phaseNumber} — ${m.title}`
            : m.title;
      }
    }
    if (lane !== lastLane) {
      console.log(`\n${bold(lane)}`);
      lastLane = lane;
    }
    printCard(card);
  }
  console.log(dim(`\n${cards.length} card(s)`));
  store.close();
}

function cmdMilestones(): void {
  const store = openStore();
  const milestones = store.listMilestones();
  if (milestones.length === 0) {
    console.log("No milestones. Import a plan first.");
    store.close();
    return;
  }

  for (const m of milestones) {
    const cards = store.listCards({ milestoneId: m.id });
    const done = cards.filter((c) => c.status === "done").length;
    const pct = cards.length === 0 ? 0 : Math.round((done / cards.length) * 100);
    const filled = Math.round((pct / 100) * 16);
    const bar = "█".repeat(filled) + "░".repeat(16 - filled);
    const phase = m.phaseNumber !== undefined ? `P${m.phaseNumber}` : "  ";
    const tb = m.timebox
      ? dim(` ${m.timebox.minWeeks}–${m.timebox.maxWeeks}w`)
      : "";
    console.log(
      `${bold(phase)} ${bar} ${String(pct).padStart(3)}%  ${truncate(m.title, 38).padEnd(39)}${dim(`${done}/${cards.length}`)}${tb}`,
    );
    if (m.gateCondition) {
      console.log(dim(`     gate: ${truncate(m.gateCondition, 70)}`));
    }
  }
  store.close();
}

async function cmdStatus(): Promise<void> {
  const store = openStore();
  const project = store.getProject();
  if (!project) die("no project record — run `uassist init`");

  const instance = await findRunningInstance(root);
  if (instance) {
    console.log(`${bold("server")}      running — http://127.0.0.1:${instance.port} (pid ${instance.pid}, v${instance.version})`);
  } else {
    console.log(`${bold("server")}      ${dim("not running")} — \`uassist start\``);
  }

  const counts = store.cardCountsByStatus();
  const total = store.countCards();
  const health = store.listHealthItems();

  console.log(`\n${bold(project.name)}`);
  console.log(dim(`  ${project.rootPath}`));
  console.log(`  milestones  ${store.listMilestones().length}`);
  console.log(`  cards       ${total}`);
  for (const s of STATUSES) {
    const n = counts[s] ?? 0;
    if (n > 0) console.log(`    ${statusChip(s)} ${n}`);
  }
  console.log(`  health      ${health.length} open`);
  console.log(dim(`  event seq   ${store.lastSeq}`));
  store.close();

  const others = listRegisteredProjects().filter((p) => p.root !== root);
  if (others.length > 0) {
    console.log(`\n${bold("other projects on this machine")}`);
    for (const p of others) {
      const other = await findRunningInstance(p.root);
      const state = other ? `running, port ${other.port} (pid ${other.pid})` : dim("not running");
      console.log(`  ${p.name.padEnd(24)} ${state}`);
      console.log(dim(`    ${p.root}`));
    }
  }
}

function cmdWorkspaceScan(): void {
  const store = openStore();
  const project = store.getProject();
  if (!project) die("no project record — run `uassist init`");

  if (!project.unityProjectPath && !project.blenderSourcePath) {
    console.log("No workspace linked yet. Set unityProjectPath / blenderSourcePath first —");
    console.log(dim(`  the Project Meta page (/project), or PATCH /api/project.`));
    store.close();
    return;
  }

  if (project.unityProjectPath) {
    const link = validateUnityPath(project.unityProjectPath);
    if (!link.valid) {
      console.log(`${bold("Unity")}    ${link.reason}`);
    } else {
      const { assets, durationMs, warnings, proposed } = scanAndReconcile(store, "unity", project.unityProjectPath);
      console.log(
        `${bold("Unity")}    ${assets.length} asset(s) in ${durationMs.toFixed(0)}ms` +
          (proposed.length > 0 ? `, ${proposed.length} new suggestion(s)` : ""),
      );
      for (const w of warnings) console.log(dim(`  warning: ${w}`));
    }
  }

  if (project.blenderSourcePath) {
    const link = validateBlenderPath(project.blenderSourcePath);
    if (!link.valid) {
      console.log(`${bold("Blender")}  ${link.reason}`);
    } else {
      const { assets, durationMs, warnings, proposed } = scanAndReconcile(store, "blender", project.blenderSourcePath);
      console.log(
        `${bold("Blender")}  ${assets.length} asset(s) in ${durationMs.toFixed(0)}ms` +
          (proposed.length > 0 ? `, ${proposed.length} new suggestion(s)` : ""),
      );
      for (const w of warnings) console.log(dim(`  warning: ${w}`));
    }
  }

  if (project.unityProjectPath || project.blenderSourcePath) {
    console.log(dim(`  \`uassist suggestions\` to review the Decisions queue.`));
  }

  store.close();
}

function cmdWorkspaceStatus(): void {
  const store = openStore();
  const project = store.getProject();
  if (!project) die("no project record — run `uassist init`");

  const describe = (label: string, path: string | undefined, validate: (p: string) => { valid: boolean; reason?: string }) => {
    if (!path) {
      console.log(`${bold(label)}  ${dim("not linked")}`);
      return;
    }
    const result = validate(path);
    console.log(`${bold(label)}  ${path}  ${result.valid ? "✓" : `✗ ${result.reason}`}`);
  };

  describe("Unity  ", project.unityProjectPath, validateUnityPath);
  describe("Blender", project.blenderSourcePath, validateBlenderPath);

  const { total, byKind } = store.workspaceAssetCounts();
  console.log(`\nCatalog: ${total} asset(s)`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(18)} ${n}`);
  }
  store.close();
}

function describeSuggestionPayload(kind: string, payload: Record<string, unknown>): string {
  if (kind === "create_card") {
    const p = payload as unknown as CreateCardPayload;
    return `create "${p.title}" (${p.category}) → ${p.anchor.kind}`;
  }
  if (kind === "attach_anchor") {
    const p = payload as unknown as AttachAnchorPayload;
    return `attach ${p.anchor.kind} anchor to card ${p.cardId}`;
  }
  if (kind === "update_card_status") {
    const p = payload as unknown as UpdateCardStatusPayload;
    return `move card ${p.cardId} → ${p.toStatus}`;
  }
  return JSON.stringify(payload);
}

function cmdSuggestionsList(): void {
  const store = openStore();
  const project = store.getProject();
  if (!project) die("no project record — run `uassist init`");

  const status = values.status;
  if (status !== undefined && !(SUGGESTION_STATUSES as readonly string[]).includes(status)) {
    die(`--status must be one of: ${SUGGESTION_STATUSES.join(", ")}`);
  }

  const suggestions = store.listSuggestions({ status: (status as SuggestionStatus | undefined) ?? "pending" });
  if (suggestions.length === 0) {
    console.log(dim(`No ${status ?? "pending"} suggestions.`));
    store.close();
    return;
  }

  for (const s of suggestions) {
    console.log(`${bold(s.id)}  ${dim(s.kind)}`);
    console.log(`  ${describeSuggestionPayload(s.kind, s.payload)}`);
    console.log(`  ${dim(s.rationale)}`);
  }
  console.log(dim(`\n\`uassist suggestions accept|reject|hold <id>\` to decide.`));
  store.close();
}

function cmdSuggestionsDecide(action: "accept" | "reject" | "hold", id: string | undefined): void {
  if (!id) die(`usage: uassist suggestions ${action} <id>`);

  const store = openStore();
  const suggestion = store.getSuggestion(id);
  if (!suggestion) die(`no such suggestion: ${id}`);
  if (suggestion.status !== "pending") die(`suggestion is already ${suggestion.status}`);

  if (action === "accept") {
    try {
      const result = applySuggestion(store, suggestion);
      console.log(`${result.created ? "Created" : "Updated"} card ${result.cardId}.`);
    } catch (err) {
      const message = err instanceof ApplySuggestionError ? err.message : err instanceof Error ? err.message : String(err);
      die(message);
    }
  }

  const statusByAction: Record<typeof action, Exclude<SuggestionStatus, "pending">> = {
    accept: "accepted",
    reject: "rejected",
    hold: "held",
  };
  store.decideSuggestion(id, statusByAction[action]);
  console.log(`Suggestion ${id} marked ${statusByAction[action]}.`);
  store.close();
}

function cmdValidate(): void {
  const store = openStore();
  const project = store.getProject();
  if (!project) die("no project record — run `uassist init`");

  console.log(dim("Running validators (broken anchors, and a real Unity compile if CLI integration is configured)..."));
  void runValidators(store).then((result) => {
    if (result.created.length > 0) {
      for (const item of result.created) {
        console.log(`${bold(item.severity)}  ${item.message}`);
      }
    } else {
      console.log(dim("No new health items."));
    }
    if (result.closed > 0) {
      console.log(dim(`${result.closed} previously open item(s) closed — no longer reproduce.`));
    }
    const open = store.listHealthItems();
    console.log(dim(`\n${open.length} open health item(s) total. \`uassist status\` for a summary.`));
    store.close();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle — start/stop/open/kill/status.
//
// Identity is never trusted from a pidfile or a process name alone — the
// same doctrine reclaim.ts already established for port reclamation.
// findRunningInstance reads .uassist/port only to know *where to ask*; the
// answer that actually counts is the live HTTP probe (instance.ts), and
// only a response whose `root` matches this exact project is treated as
// "ours."
// ---------------------------------------------------------------------------

async function findRunningInstance(projectRoot: string): Promise<Instance | undefined> {
  const portFile = join(projectRoot, ".uassist", "port");
  if (!existsSync(portFile)) return undefined;
  const port = Number(readFileSync(portFile, "utf8").trim());
  if (!Number.isFinite(port)) return undefined;
  const instance = await probeInstance(port);
  return instance && instance.root === projectRoot ? instance : undefined;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", '""', url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    console.log(dim(`  (could not open a browser automatically — visit ${url})`));
  }
}

async function cmdStart(): Promise<void> {
  const dir = join(root, ".uassist");
  if (!existsSync(dir)) die(`no UAssist project at ${root} — run \`uassist init\` first`);

  const already = await findRunningInstance(root);
  if (already) {
    console.log(`Already running: v${already.version} on port ${already.port} (pid ${already.pid}).`);
    if (values.open) openBrowser(`http://127.0.0.1:${already.port}/board`);
    return;
  }

  if (values.port !== undefined && !Number.isFinite(Number(values.port))) {
    die(`--port must be a number, got "${values.port}"`);
  }

  const logPath = join(dir, "server.log");
  let logFd: number | undefined;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = undefined; // stdout/stderr fall back to "ignore" below
  }

  let proc: Bun.Subprocess;
  try {
    proc = spawnServer({
      root,
      port: values.port !== undefined ? Number(values.port) : undefined,
      stdio: logFd,
    });
  } catch (err) {
    die(err instanceof ServerBinaryNotFoundError ? err.message : err instanceof Error ? err.message : String(err));
  }

  console.log(dim(`Starting UAssist (pid ${proc.pid})${logFd !== undefined ? `, logging to ${logPath}` : ""}...`));

  const deadline = Date.now() + 10_000;
  let confirmed: Instance | undefined;
  while (Date.now() < deadline && !confirmed) {
    await Bun.sleep(200);
    confirmed = await findRunningInstance(root);
  }

  if (!confirmed) die(`server did not come up within 10s — check ${logPath}`);

  console.log(`${bold("UAssist")} running at http://127.0.0.1:${confirmed.port} (pid ${confirmed.pid})`);
  if (values.open) openBrowser(`http://127.0.0.1:${confirmed.port}/board`);
}

async function cmdStop(): Promise<void> {
  if (!existsSync(join(root, ".uassist"))) die(`no UAssist project at ${root}`);

  const instance = await findRunningInstance(root);
  if (!instance) {
    console.log(dim("Not running."));
    return;
  }

  console.log(dim(`Stopping pid ${instance.pid} (port ${instance.port})...`));
  const ok = await terminateAndWait(instance, "127.0.0.1", {});
  if (ok) console.log("Stopped.");
  else die(`pid ${instance.pid} did not stop within the timeout — it may need a manual kill`);
}

async function cmdOpen(): Promise<void> {
  const instance = await findRunningInstance(root);
  if (!instance) die("not running for this project — `uassist start` first (or `uassist start --open`)");
  openBrowser(`http://127.0.0.1:${instance.port}/board`);
  console.log(dim(`Opened http://127.0.0.1:${instance.port}/board`));
}

/**
 * Stops every server for a *registered* project (~/.uassist/registry.json)
 * that answers a live identity probe — the same "ask, don't assume" check
 * as everywhere else in this file. A server for a project that was never
 * registered (registration happens automatically at `uassist init`/bootstrap
 * time) is outside what this can find; that is a real limitation, not a
 * silent gap — reported in the summary line below.
 */
async function cmdKill(): Promise<void> {
  const projects = listRegisteredProjects();
  if (projects.length === 0) {
    console.log(dim("No registered projects on this machine."));
    return;
  }

  let stopped = 0;
  let failed = 0;
  for (const p of projects) {
    const instance = await findRunningInstance(p.root);
    if (!instance) continue;
    console.log(dim(`Stopping "${p.name}" (${p.root}), pid ${instance.pid}, port ${instance.port}...`));
    const ok = await terminateAndWait(instance, "127.0.0.1", {});
    if (ok) {
      stopped++;
      console.log("  stopped.");
    } else {
      failed++;
      console.log("  did not stop within the timeout — may need a manual kill.");
    }
  }

  if (stopped === 0 && failed === 0) {
    console.log(dim("No running UAssist servers found among registered projects."));
  } else {
    console.log(dim(`\n${stopped} stopped, ${failed} did not respond.`));
  }
}

function cmdDbRebuild(): void {
  if (!existsSync(resolve(root, ".uassist"))) {
    die(`no UAssist project at ${root}`);
  }
  const counts = Store.rebuild(root);
  console.log(
    `Rebuilt SQLite from the JSON mirror: ${counts.milestones} milestone(s), ${counts.cards} card(s), ${counts.health} health item(s).`,
  );
}

// ---------------------------------------------------------------------------

const command = positionals[0];
const sub = positionals[1];

if (values.help || command === undefined || command === "help") {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "plan":
    if (sub !== "import") die(`unknown plan subcommand "${sub ?? ""}"`);
    await cmdPlanImport();
    break;
  case "cards":
    cmdCards();
    break;
  case "milestones":
    cmdMilestones();
    break;
  case "status":
    await cmdStatus();
    break;
  case "workspace":
    if (sub === "scan") cmdWorkspaceScan();
    else if (sub === "status") cmdWorkspaceStatus();
    else die(`unknown workspace subcommand "${sub ?? ""}"`);
    break;
  case "suggestions":
    if (sub === undefined) cmdSuggestionsList();
    else if (sub === "accept" || sub === "reject" || sub === "hold") cmdSuggestionsDecide(sub, positionals[2]);
    else die(`unknown suggestions subcommand "${sub}"`);
    break;
  case "validate":
    cmdValidate();
    break;
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "open":
    await cmdOpen();
    break;
  case "kill":
    await cmdKill();
    break;
  case "db":
    if (sub !== "rebuild") die(`unknown db subcommand "${sub ?? ""}"`);
    cmdDbRebuild();
    break;
  case "version":
    console.log(`uassist ${VERSION}`);
    break;
  default:
    die(`unknown command "${command}" — try \`uassist --help\``);
}
