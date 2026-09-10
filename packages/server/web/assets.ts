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

  const totalCard = el("div", "summary-card");
  totalCard.append(el("div", "summary-number", String(s.totalAssets)));
  totalCard.append(el("div", "summary-label", "Total assets"));
  grid.append(totalCard);

  const uncoveredCard = el("div", "summary-card");
  uncoveredCard.append(el("div", "summary-number", String(s.uncoveredCount)));
  uncoveredCard.append(el("div", "summary-label", "Uncovered"));
  grid.append(uncoveredCard);

  const orphanedCard = el("div", "summary-card");
  orphanedCard.append(el("div", "summary-number", String(s.orphanedCardCount)));
  orphanedCard.append(el("div", "summary-label", "Orphaned cards"));
  grid.append(orphanedCard);

  const healthCard = el("div", "summary-card");
  healthCard.append(el("div", "summary-number", String(s.openHealthCount)));
  healthCard.append(el("div", "summary-label", "Open health items"));
  grid.append(healthCard);

  if (s.lastScannedAt) {
    const scanCard = el("div", "summary-card");
    scanCard.append(el("div", "summary-number", formatDate(s.lastScannedAt)));
    scanCard.append(el("div", "summary-label", "Last scan"));
    grid.append(scanCard);
  }

  summaryHost.append(grid);

  const breakdown = el("div", "breakdown");
  breakdown.append(el("h3", undefined, "By source"));
  const sourceList = el("ul");
  for (const [k, v] of Object.entries(s.bySource).sort((a, b) => b[1] - a[1])) {
    sourceList.append(el("li", undefined, `${k}: ${v}`));
  }
  breakdown.append(sourceList);

  breakdown.append(el("h3", undefined, "By kind"));
  const kindList = el("ul");
  for (const [k, v] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    kindList.append(el("li", undefined, `${k}: ${v}`));
  }
  breakdown.append(kindList);

  summaryHost.append(breakdown);
}

function renderControls(): void {
  controlsHost.replaceChildren();
  const form = el("form", "assets-form");
  form.addEventListener("submit", (e) => e.preventDefault());

  const source = el("select");
  source.append(el("option", undefined, "All sources"));
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
  kind.placeholder = "Filter by kind";
  kind.value = state.kind;
  kind.addEventListener("input", () => {
    state.kind = kind.value;
    void loadAssets();
  });

  const q = el("input");
  q.type = "search";
  q.placeholder = "Search path…";
  q.value = state.q;
  q.addEventListener("input", () => {
    state.q = q.value;
    void loadAssets();
  });

  const uncovered = el("label", "inline", "Uncovered only");
  const uncoveredBox = el("input");
  uncoveredBox.type = "checkbox";
  uncoveredBox.checked = state.uncoveredOnly;
  uncoveredBox.addEventListener("change", () => {
    state.uncoveredOnly = uncoveredBox.checked;
    void loadAssets();
  });
  uncovered.append(uncoveredBox);

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
    const key = encodeURIComponent(`${a.source}:${a.path}`);
    const pathCell = el("td");
    const link = el("a", undefined, a.path);
    link.href = `/assets?detail=${key}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      renderDetail(a);
    });
    pathCell.append(link);
    tr.append(pathCell);
    tr.append(el("td", undefined, a.source));
    tr.append(el("td", undefined, a.kind));
    tr.append(el("td", undefined, formatBytes(a.sizeBytes)));
    tr.append(el("td", undefined, formatDate(a.mtimeMs)));
    tr.append(el("td", undefined, String(a.cardCount)));
    tr.append(el("td", undefined, a.openHealthCount > 0 ? String(a.openHealthCount) : "—"));
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

  panel.append(el("h3", undefined, `Cards (${detail.cards.length})`));
  if (detail.cards.length === 0) {
    panel.append(el("p", "placeholder", "No cards anchored to this asset."));
  } else {
    const list = el("ul");
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
    const list = el("ul");
    for (const h of detail.health) {
      const item = el("li", h.resolved ? "resolved" : "");
      item.textContent = `${h.severity}: ${h.message}${h.resolved ? " (resolved)" : ""}`;
      list.append(item);
    }
    panel.append(list);
  }

  if (detail.related.length > 0) {
    panel.append(el("h3", undefined, `Related in same folder (${detail.related.length})`));
    const list = el("ul");
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
