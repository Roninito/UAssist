/**
 * Asset Tracker page.
 *
 * Shows coverage, kind/source breakdown, and a filterable list of scanned
 * workspace assets. Each asset links to its anchored cards and health items.
 */

import { api, type AssetSummary } from "./api.ts";
import { el } from "./render.ts";

type AssetListItem = {
  source: string;
  path: string;
  kind: string;
  sizeBytes: number;
  mtimeMs: number;
  classNames?: string[];
  cardCount: number;
  openHealthCount: number;
};

interface State {
  summary?: AssetSummary;
  assets: AssetListItem[];
  source: string;
  kind: string;
  uncoveredOnly: boolean;
  q: string;
  loading: boolean;
}

const state: State = {
  assets: [],
  source: "",
  kind: "",
  uncoveredOnly: false,
  q: "",
  loading: false,
};

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

const summaryHost = $("#assets-summary");
const controlsHost = $("#assets-controls");
const listHost = $("#assets-list");

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function renderSummary(): void {
  const s = state.summary;
  summaryHost.replaceChildren();
  if (!s) {
    summaryHost.append(el("p", "placeholder", "Loading summary…"));
    return;
  }

  const grid = el("div", "summary-grid");

  grid.append(makeSummaryCard(String(s.totalAssets), "Total assets", ""));
  grid.append(makeSummaryCard(String(s.uncoveredCount), "Uncovered", s.uncoveredCount > 0 ? "warn" : ""));
  grid.append(makeSummaryCard(String(s.orphanedCardCount), "Orphaned cards", s.orphanedCardCount > 0 ? "warn" : ""));
  grid.append(makeSummaryCard(String(s.openHealthCount), "Open health items", s.openHealthCount > 0 ? "warn" : ""));

  if (s.lastScannedAt) {
    grid.append(makeSummaryCard(formatDate(s.lastScannedAt), "Last scan", ""));
  }

  summaryHost.append(grid);

  const breakdown = el("div", "breakdown");
  breakdown.append(el("h3", undefined, "By source"));
  const sourceList = el("ul", "breakdown-list");
  for (const [k, v] of Object.entries(s.bySource).sort((a, b) => b[1] - a[1])) {
    sourceList.append(el("li", undefined, `${k}: ${v}`));
  }
  breakdown.append(sourceList);

  breakdown.append(el("h3", undefined, "By kind"));
  const kindList = el("ul", "breakdown-list");
  for (const [k, v] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    kindList.append(el("li", undefined, `${k}: ${v}`));
  }
  breakdown.append(kindList);

  summaryHost.append(breakdown);
}

function makeSummaryCard(number: string, label: string, tone: "" | "warn"): HTMLElement {
  const card = el("div", `summary-card ${tone}`);
  card.append(el("div", "summary-number", number));
  card.append(el("div", "summary-label", label));
  return card;
}

function renderControls(): void {
  controlsHost.replaceChildren();
  const form = el("form", "assets-form");
  form.addEventListener("submit", (e) => e.preventDefault());

  const source = el("select");
  source.className = "filter-select";
  const allOpt = el("option", undefined, "All sources");
  allOpt.value = "";
  source.append(allOpt);
  for (const s of ["unity", "blender"]) {
    const opt = el("option", undefined, s);
    opt.value = s;
    if (state.source === s) opt.selected = true;
    source.append(opt);
  }
  source.addEventListener("change", () => {
    state.source = source.value;
    void loadAssets();
  });

  const kind = el("input");
  kind.className = "filter-input";
  kind.placeholder = "Filter by kind";
  kind.value = state.kind;
  kind.addEventListener("input", () => {
    state.kind = kind.value;
    void loadAssets();
  });

  const q = el("input");
  q.className = "filter-input";
  q.type = "search";
  q.placeholder = "Search path…";
  q.value = state.q;
  q.addEventListener("input", () => {
    state.q = q.value;
    void loadAssets();
  });

  const uncovered = el("label", "filter-check inline");
  const uncoveredBox = el("input");
  uncoveredBox.type = "checkbox";
  uncoveredBox.checked = state.uncoveredOnly;
  uncoveredBox.addEventListener("change", () => {
    state.uncoveredOnly = uncoveredBox.checked;
    void loadAssets();
  });
  uncovered.append(uncoveredBox, "Uncovered only");

  const refresh = el("button", "secondary", "Refresh");
  refresh.addEventListener("click", () => {
    void loadSummary();
    void loadAssets();
  });

  form.append(source, kind, q, uncovered, refresh);
  controlsHost.append(form);
}

function renderList(): void {
  listHost.replaceChildren();
  if (state.loading) {
    listHost.append(el("p", "placeholder", "Loading assets…"));
    return;
  }
  if (state.assets.length === 0) {
    listHost.append(el("p", "placeholder", "No assets match the current filters. Run a workspace scan to populate the catalog."));
    return;
  }

  const table = el("table", "assets-table");
  const thead = el("thead");
  const headerRow = el("tr");
  for (const h of ["Path", "Source", "Kind", "Size", "Modified", "Cards", "Health"]) {
    headerRow.append(el("th", undefined, h));
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = el("tbody");
  for (const a of state.assets) {
    const tr = el("tr");
    if (a.openHealthCount > 0) tr.classList.add("has-health");
    const key = encodeURIComponent(`${a.source}:${a.path}`);
    const pathCell = el("td");
    const link = el("a", "asset-link", a.path);
    link.href = `/assets?detail=${key}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      void renderDetail(a);
    });
    pathCell.append(link);
    tr.append(pathCell);
    tr.append(el("td", undefined, a.source));
    tr.append(el("td", undefined, a.kind));
    tr.append(el("td", "num", formatBytes(a.sizeBytes)));
    tr.append(el("td", "date", formatDate(a.mtimeMs)));
    tr.append(el("td", "num", String(a.cardCount)));
    const healthCell = el("td", "num");
    if (a.openHealthCount > 0) {
      const badge = el("span", "badge badge-bad", String(a.openHealthCount));
      healthCell.append(badge);
    } else {
      healthCell.textContent = "—";
    }
    tr.append(healthCell);
    tbody.append(tr);
  }
  table.append(tbody);
  listHost.append(table);
}

async function renderDetail(asset: AssetListItem): Promise<void> {
  const key = encodeURIComponent(`${asset.source}:${asset.path}`);
  const detail = await api.assetDetail(key);
  const panel = el("aside", "asset-detail-panel");

  const head = el("div", "panel-head");
  head.append(el("h2", undefined, asset.path));
  const close = el("button", "close", "✕");
  close.title = "Close (Esc)";
  close.addEventListener("click", () => panel.remove());
  head.append(close);
  panel.append(head);

  panel.append(el("p", undefined, `Source: ${asset.source} · Kind: ${asset.kind} · Size: ${formatBytes(asset.sizeBytes)}`));
  panel.append(el("p", undefined, `Modified: ${formatDate(asset.mtimeMs)}`));
  if (detail.asset.classNames?.length) {
    panel.append(el("p", undefined, `Classes: ${detail.asset.classNames.join(", ")}`));
  }

  const meta = el("div", "asset-meta");
  meta.append(el("span", "chip", asset.source));
  meta.append(el("span", "chip", asset.kind));
  meta.append(el("span", undefined, formatBytes(asset.sizeBytes)));
  meta.append(el("span", undefined, formatDate(asset.mtimeMs)));
  panel.append(meta);

  if (detail.asset.classNames?.length) {
    const classes = el("p", "asset-classes", `Classes: ${detail.asset.classNames.join(", ")}`);
    panel.append(classes);
  }

  panel.append(el("h3", undefined, `Cards (${detail.cards.length})`));
  if (detail.cards.length === 0) {
    panel.append(el("p", "placeholder", "No cards anchored to this asset."));
  } else {
    const list = el("ul", "link-list");
    for (const c of detail.cards) {
      const item = el("li");
      const a = el("a", undefined, c.title);
      a.href = `/board?card=${c.id}`;
      item.append(a);
      item.append(el("span", "muted", ` · ${c.status} · ${c.priority}`));
      list.append(item);
    }
    panel.append(list);
  }

  panel.append(el("h3", undefined, `Health (${detail.health.length})`));
  if (detail.health.length === 0) {
    panel.append(el("p", "placeholder", "No health items for this asset."));
  } else {
    const list = el("ul", "health-list");
    for (const h of detail.health) {
      const item = el("li", h.resolved ? "resolved" : "");
      const severity = el("span", `severity-${h.severity}`, h.severity);
      item.append(severity, ` ${h.message}${h.resolved ? " (resolved)" : ""}`);
      list.append(item);
    }
    panel.append(list);
  }

  if (detail.related.length > 0) {
    panel.append(el("h3", undefined, `Related in same folder (${detail.related.length})`));
    const list = el("ul", "link-list");
    for (const r of detail.related.slice(0, 20)) {
      list.append(el("li", undefined, r.path));
    }
    panel.append(list);
  }

  document.body.append(panel);
}

async function loadSummary(): Promise<void> {
  const res = await api.assetSummary();
  state.summary = res.summary;
  renderSummary();
}

async function loadAssets(): Promise<void> {
  state.loading = true;
  renderList();
  const params = new URLSearchParams();
  if (state.source) params.set("source", state.source);
  if (state.kind) params.set("kind", state.kind);
  if (state.q) params.set("q", state.q);
  if (state.uncoveredOnly) params.set("uncovered", "1");
  const res = await api.assets(params.toString());
  state.assets = res.assets;
  state.loading = false;
  renderList();
}

async function init(): Promise<void> {
  renderControls();
  await Promise.all([loadSummary(), loadAssets()]);
}

void init();
