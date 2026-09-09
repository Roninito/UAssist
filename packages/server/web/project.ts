/**
 * Project Meta page — identity, workspace links, Asset Catalog summary, and
 * the registry of other known UAssist projects on this machine.
 *
 * See design/workspace-spec.md Parts II–IV.
 */

import type { ImportResult, Project } from "@uassist/core";
import {
  api,
  ApiError,
  ENGINE_INTEGRATION_METHODS,
  type EngineIntegrationConfig,
  type EngineIntegrationMethod,
  type EngineMethodConfig,
  type ProjectSummary,
  type RegistryEntry,
  type WorkspaceStatus,
} from "./api.ts";
import { el } from "./render.ts";

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

const meta = $("#meta");
const projectName = $("#project-name");
const connDot = $("#conn");

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Workspace section
// ---------------------------------------------------------------------------

function renderWorkspaceRow(
  label: string,
  key: "unityProjectPath" | "blenderSourcePath",
  link: WorkspaceStatus["unity"] | WorkspaceStatus["blender"],
  currentPath: string | undefined,
): HTMLElement {
  const row = el("div", "workspace-row");
  row.append(el("label", undefined, label));

  const input = el("input");
  input.type = "text";
  input.placeholder = key === "unityProjectPath" ? "/path/to/UnityProject" : "/path/to/blender-source";
  input.value = currentPath ?? "";
  row.append(input);

  const badge = el(
    "span",
    `badge ${link ? (link.valid ? "badge-ok" : "badge-bad") : "badge-off"}`,
    link ? (link.valid ? "linked" : link.reason ?? "invalid") : "not linked",
  );
  row.append(badge);

  const save = el("button", undefined, "Save");
  save.addEventListener("click", async () => {
    const value = input.value.trim();
    try {
      await api.patchProject({ [key]: value.length > 0 ? value : null });
      await paint();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  row.append(save);

  return row;
}

function renderCatalog(status: WorkspaceStatus): HTMLElement {
  const section = el("div", "catalog-summary");
  section.append(
    el(
      "span",
      undefined,
      `${status.totalAssets} asset${status.totalAssets === 1 ? "" : "s"}` +
        (status.lastScannedAt ? ` · scanned ${fmtAgo(status.lastScannedAt)}` : " · never scanned"),
    ),
  );

  const chips = el("div", "catalog-counts");
  for (const [kind, count] of Object.entries(status.assetCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    chips.append(el("span", "catalog-chip", `${kind} ${count}`));
  }
  section.append(chips);

  const scanBtn = el("button", "primary", "Rescan");
  scanBtn.addEventListener("click", async () => {
    scanBtn.textContent = "Scanning…";
    scanBtn.setAttribute("disabled", "true");
    try {
      const { results } = await api.scanWorkspace();
      for (const [source, r] of Object.entries(results)) {
        if ("error" in r) toast(`${source}: ${r.error}`);
      }
      await paint();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      scanBtn.textContent = "Rescan";
      scanBtn.removeAttribute("disabled");
    }
  });
  section.append(scanBtn);

  return section;
}

// ---------------------------------------------------------------------------
// Engine integration — how dispatched jobs and the assistant talk to Unity
// and Blender (CLI batch-mode, a live MCP server, or both). Zero-config
// default is CLI-only; this is the UI half of the PATCH /api/project
// engineIntegration field workspace.ts has handled since Phase 3.5. See
// design/automation-spec.md Part II.
// ---------------------------------------------------------------------------

const ENGINE_METHOD_LABELS: Record<EngineIntegrationMethod, string> = {
  cli: "CLI only",
  mcp: "MCP only",
  both: "CLI + MCP",
};

function renderEngineIntegrationRow(
  label: string,
  engine: "unity" | "blender",
  project: Project,
): HTMLElement {
  const current: EngineMethodConfig | undefined = project.engineIntegration?.[engine];

  const row = el("div", "workspace-row");
  row.append(el("label", undefined, label));

  const select = el("select");
  for (const method of ENGINE_INTEGRATION_METHODS) {
    const opt = el("option", undefined, ENGINE_METHOD_LABELS[method]);
    opt.value = method;
    select.append(opt);
  }
  select.value = current?.method ?? "cli";
  row.append(select);

  const urlInput = el("input");
  urlInput.type = "text";
  urlInput.placeholder = "MCP server URL, e.g. http://127.0.0.1:6060";
  urlInput.value = current?.mcpServerUrl ?? "";
  const syncUrlVisibility = () => {
    urlInput.hidden = select.value === "cli";
  };
  syncUrlVisibility();
  select.addEventListener("change", syncUrlVisibility);
  row.append(urlInput);

  const save = el("button", undefined, "Save");
  save.addEventListener("click", async () => {
    const method = select.value as EngineIntegrationMethod;
    const mcpServerUrl = urlInput.value.trim();
    if (method !== "cli" && mcpServerUrl.length === 0) {
      toast(`${label}: an MCP server URL is required for "${ENGINE_METHOD_LABELS[method]}"`);
      return;
    }
    // The server replaces engineIntegration wholesale on PATCH — merge with
    // the other engine's config here so saving Unity never clobbers an
    // already-configured Blender integration, and vice versa.
    const merged: EngineIntegrationConfig = {
      ...project.engineIntegration,
      [engine]: { method, mcpServerUrl: method === "cli" ? undefined : mcpServerUrl },
    };
    try {
      await api.patchProject({ engineIntegration: merged });
      await paint();
      toast(`${label} integration saved.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  row.append(save);

  return row;
}

function renderEngineIntegrationSection(project: Project): HTMLElement {
  const section = el("section", "meta-section");
  section.append(el("h2", undefined, "Engine integration"));
  section.append(
    el(
      "p",
      "hint",
      "How dispatched jobs and the assistant reach Unity and Blender. CLI-only needs no setup and is the default; MCP adds a live connection for real-time queries (\"what's in the current scene\") when a server is running.",
    ),
  );
  section.append(renderEngineIntegrationRow("Unity", "unity", project));
  section.append(renderEngineIntegrationRow("Blender", "blender", project));
  return section;
}

// ---------------------------------------------------------------------------
// Plan re-ingest section — same diff the CLI's `--dry-run` reports, reviewed
// here instead of in a terminal. See design/uassist-spec.md Part V.
// ---------------------------------------------------------------------------

function renderCardList(label: string, cards: { title: string }[]): HTMLElement | undefined {
  if (cards.length === 0) return undefined;
  const wrap = el("div");
  wrap.style.marginTop = "8px";
  wrap.append(el("strong", undefined, `${label} (${cards.length})`));
  const ul = el("ul", "link-list");
  for (const c of cards.slice(0, 30)) {
    ul.append(el("li", undefined, `· ${c.title}`));
  }
  if (cards.length > 30) ul.append(el("li", undefined, `… and ${cards.length - 30} more`));
  wrap.append(ul);
  return wrap;
}

function renderImportDiff(result: ImportResult & { fileName: string; applied: boolean }): HTMLElement {
  const box = el("div");
  box.style.marginTop = "10px";
  box.style.padding = "10px 12px";
  box.style.border = "1px solid var(--border)";
  box.style.borderRadius = "var(--radius)";
  box.style.fontSize = "12.5px";

  const verb = result.applied ? "Imported" : "Dry run";
  box.append(el("strong", undefined, `${verb}: ${result.fileName}`));

  const counts = el("p", "hint");
  counts.textContent =
    `milestones: ${result.addedMilestones.length} added, ${result.updatedMilestones.length} updated  ·  ` +
    `cards: ${result.addedCards.length} added, ${result.updatedCards.length} updated, ${result.renamedCards.length} renamed`;
  box.append(counts);

  const added = renderCardList("Added", result.addedCards);
  if (added) box.append(added);

  if (result.renamedCards.length > 0) {
    const wrap = el("div");
    wrap.style.marginTop = "8px";
    wrap.append(el("strong", undefined, `Renamed (${result.renamedCards.length})`));
    const ul = el("ul", "link-list");
    for (const r of result.renamedCards.slice(0, 20)) {
      ul.append(el("li", undefined, `· ${r.from.title} → ${r.to.title} (${Math.round(r.similarity * 100)}%)`));
    }
    wrap.append(ul);
    box.append(wrap);
  }

  if (result.orphanedCards.length > 0) {
    const wrap = el("div");
    wrap.style.marginTop = "8px";
    wrap.append(
      el(
        "strong",
        undefined,
        `Orphaned (${result.orphanedCards.length}) — in the board, no longer in the plan. Not deleted.`,
      ),
    );
    const ul = el("ul", "link-list");
    for (const c of result.orphanedCards.slice(0, 20)) ul.append(el("li", undefined, `· ${c.title}`));
    wrap.append(ul);
    box.append(wrap);
  }

  for (const w of result.warnings) box.append(el("p", "hint", `warning: ${w}`));

  return box;
}

function renderPlanSection(project: ProjectSummary): HTMLElement {
  const section = el("section", "meta-section");
  section.append(el("h2", undefined, "Plan"));
  section.append(
    el(
      "p",
      "hint",
      "Import or re-ingest a Markdown build plan. A re-import diffs against current cards — nothing with history is ever silently deleted.",
    ),
  );

  const row = el("div", "workspace-row");
  row.append(el("label", undefined, "File"));
  const input = el("input");
  input.type = "text";
  input.placeholder = "/path/to/build-plan.md";
  input.value = project.project.planSourcePath ?? "";
  row.append(input);
  section.append(row);

  const resultHost = el("div");

  const run = async (dryRun: boolean) => {
    const path = input.value.trim();
    if (path.length === 0) {
      toast("Enter a plan file path first.");
      return;
    }
    try {
      const result = await api.importPlan(path, dryRun);
      resultHost.replaceChildren(renderImportDiff(result));
      if (result.applied) await paint();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const actions = el("div");
  actions.style.marginTop = "6px";
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const dryBtn = el("button", undefined, "Preview diff");
  dryBtn.addEventListener("click", () => void run(true));
  const importBtn = el("button", "primary", "Import");
  importBtn.addEventListener("click", () => void run(false));
  actions.append(dryBtn, importBtn);
  section.append(actions);
  section.append(resultHost);

  return section;
}

// ---------------------------------------------------------------------------
// Registry section
// ---------------------------------------------------------------------------

function renderRegistryRow(entry: RegistryEntry): HTMLElement {
  const row = el("li", "registry-row");
  const dot = el("span", "dot");
  dot.dataset["reachable"] = String(entry.reachable);
  row.append(dot);
  row.append(el("span", "name", entry.name + (entry.self ? " (this project)" : "")));
  row.append(el("span", "root", entry.root));
  if (entry.url && !entry.self) {
    const link = el("a", undefined, "Open board →");
    link.href = `${entry.url}/board`;
    link.target = "_blank";
    link.rel = "noopener";
    row.append(link);
  } else if (!entry.self && entry.reachable) {
    row.append(el("span", "badge badge-off", "reachable"));
  } else if (!entry.self) {
    const start = el("button", undefined, "Start");
    start.addEventListener("click", async () => {
      start.disabled = true;
      start.textContent = "Starting…";
      try {
        const result = await api.startRegistryProject(entry.id);
        if (result.url) {
          const link = el("a", undefined, "Open board →");
          link.href = `${result.url}/board`;
          link.target = "_blank";
          link.rel = "noopener";
          start.replaceWith(link);
        } else {
          await paint();
        }
      } catch (err) {
        start.disabled = false;
        start.textContent = "Start";
        toast(`Could not start "${entry.name}": ${err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)}`);
      }
    });
    row.append(start);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Boot / paint
// ---------------------------------------------------------------------------

async function paint(): Promise<void> {
  let project: ProjectSummary;
  let workspace: WorkspaceStatus;
  try {
    [project, { workspace }] = await Promise.all([api.project(), api.workspace()]);
  } catch (err) {
    meta.replaceChildren(
      el(
        "div",
        "empty",
        err instanceof ApiError && err.status === 404
          ? "No UAssist project here. Run `uassist init` first."
          : `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return;
  }

  projectName.textContent = project.project.name;
  connDot.dataset["state"] = "online";

  const banner = workspace.complete
    ? undefined
    : (() => {
        const b = el("div", "incomplete-banner");
        b.append(
          el(
            "span",
            undefined,
            "Workspace incomplete — no valid Unity or Blender path linked yet. Cards and agent context can't reference real project artifacts until one is.",
          ),
        );
        const jump = el("a", undefined, "Set up now ↓");
        jump.href = "#workspace-section";
        b.append(jump);
        return b;
      })();

  const identity = el("section", "meta-section");
  identity.append(el("h2", undefined, "Project"));
  const dl = el("dl");
  const field = (term: string, value: string) => {
    dl.append(el("dt", undefined, term));
    dl.append(el("dd", undefined, value));
  };
  dl.style.display = "grid";
  dl.style.gridTemplateColumns = "auto 1fr";
  dl.style.gap = "4px 12px";
  dl.style.fontSize = "12.5px";
  field("Name", project.project.name);
  field("Root", project.project.rootPath);
  field("Cards", `${project.total}`);
  field("Milestones", `${project.milestones.length}`);
  field("Created", fmtTime(project.project.createdAt));
  identity.append(dl);

  const workspaceSection = el("section", "meta-section");
  workspaceSection.id = "workspace-section";
  workspaceSection.append(el("h2", undefined, "Workspace"));
  workspaceSection.append(
    el(
      "p",
      "hint",
      "Link the real Unity and/or Blender project this UAssist project coordinates. Cards anchor to what gets scanned here — not to typed guesses.",
    ),
  );
  workspaceSection.append(
    renderWorkspaceRow("Unity", "unityProjectPath", workspace.unity, project.project.unityProjectPath),
  );
  workspaceSection.append(
    renderWorkspaceRow("Blender", "blenderSourcePath", workspace.blender, project.project.blenderSourcePath),
  );
  workspaceSection.append(renderCatalog(workspace));

  const engineIntegrationSection = renderEngineIntegrationSection(project.project);
  const planSection = renderPlanSection(project);

  meta.replaceChildren(
    ...(banner ? [banner] : []),
    identity,
    workspaceSection,
    engineIntegrationSection,
    planSection,
  );

  const registrySection = el("section", "meta-section");
  registrySection.append(el("h2", undefined, "Other projects on this machine"));
  try {
    const { projects } = await api.registry();
    if (projects.length <= 1) {
      registrySection.append(el("p", "hint", "No other UAssist projects registered yet."));
    } else {
      const list = el("ul", "registry-list");
      for (const entry of projects) list.append(renderRegistryRow(entry));
      registrySection.append(list);
    }
  } catch {
    registrySection.append(el("p", "hint", "Could not load the project registry."));
  }
  meta.append(registrySection);
}

void paint();
