/**
 * Board rendering.
 *
 * Three rules keep a framework-free board from becoming a pile of DOM
 * mutations (design/plan-to-kanban-tool-spec.md Part IV):
 *
 *   1. One store, one snapshot. State is a single immutable object.
 *   2. Render is a pure function of state: (board) => DocumentFragment.
 *   3. The DOM is not the state. Nothing is read back out of it to decide
 *      what to do next.
 */

import type {
  AxisValue,
  BoardResponse,
  CardSummary,
  HealthItem,
} from "@uassist/core";

const NONE = "_";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function assigneeKind(card: CardSummary): string {
  return card.assignee.kind;
}

export function renderCard(card: CardSummary): HTMLElement {
  const node = el("article", "card");
  node.draggable = true;
  node.dataset["cardId"] = card.id;
  node.dataset["assignee"] = assigneeKind(card);
  node.dataset["priority"] = card.priority;
  node.dataset["kind"] = card.kind;
  node.dataset["status"] = card.status;

  node.append(el("div", "card-title", card.title));

  if (card.acceptanceTotal > 0) {
    const bar = el("div", "progress");
    const fill = el("i");
    fill.style.width = `${Math.round((card.acceptanceMet / card.acceptanceTotal) * 100)}%`;
    bar.append(fill);
    node.append(bar);
  }

  const meta = el("div", "card-meta");
  if (card.kind !== "task") {
    meta.append(el("span", `chip kind-${card.kind}`, card.kind));
  }
  if (card.blockedByCount > 0) {
    meta.append(el("span", "chip blocked", `blocked ×${card.blockedByCount}`));
  }
  if (card.acceptanceTotal > 0) {
    meta.append(el("span", undefined, `${card.acceptanceMet}/${card.acceptanceTotal}`));
  }
  if (card.jobCount > 0) {
    meta.append(el("span", undefined, `${card.jobCount} job${card.jobCount === 1 ? "" : "s"}`));
  }
  if (card.subsystem) meta.append(el("span", undefined, card.subsystem));
  if (meta.childElementCount > 0) node.append(meta);

  return node;
}

/** Index cells by "lane row column" so lookup during layout is O(1). */
function indexCells(board: BoardResponse): Map<string, CardSummary[]> {
  const map = new Map<string, CardSummary[]>();
  for (const cell of board.cells) {
    map.set(`${cell.swimlane} ${cell.row} ${cell.column}`, cell.cards);
  }
  return map;
}

function renderLane(
  board: BoardResponse,
  cells: Map<string, CardSummary[]>,
  lane: AxisValue,
  showLaneHead: boolean,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const { columns, rows } = board.axes;
  const hasRowHeads = board.view.rows !== "none";

  if (showLaneHead) {
    const head = el("div", "lane-head");
    head.append(el("span", undefined, lane.label));
    head.append(el("span", "lane-count", `${lane.count}`));
    frag.append(head);
  }

  const grid = el("div", "grid");
  grid.style.gridTemplateColumns = `${hasRowHeads ? "var(--lane-w) " : ""}repeat(${columns.length}, var(--col-w))`;

  if (hasRowHeads) grid.append(el("div", "corner"));
  for (const col of columns) {
    grid.append(el("div", "col-head", `${col.label} · ${col.count}`));
  }

  for (const row of rows) {
    if (hasRowHeads) grid.append(el("div", "row-head", row.label));
    for (const col of columns) {
      const cell = el("div", "cell");
      cell.dataset["lane"] = lane.key;
      cell.dataset["row"] = row.key;
      cell.dataset["column"] = col.key;
      for (const card of cells.get(`${lane.key} ${row.key} ${col.key}`) ?? []) {
        cell.append(renderCard(card));
      }
      grid.append(cell);
    }
  }

  frag.append(grid);
  return frag;
}

export function renderBoard(board: BoardResponse): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (board.total === 0) {
    frag.append(
      el("div", "empty", "No cards match. Import a plan, or clear the search."),
    );
    return frag;
  }

  const cells = indexCells(board);
  const showLaneHead = board.view.swimlanes !== "none";

  for (const lane of board.axes.swimlanes) {
    const section = el("section", "lane");
    section.dataset["lane"] = lane.key;
    section.append(renderLane(board, cells, lane, showLaneHead));
    frag.append(section);
  }

  return frag;
}

export function renderHealthLane(items: HealthItem[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(el("span", "label", "Health"));
  if (items.length === 0) {
    frag.append(el("span", "health-empty", "Nothing broken."));
    return frag;
  }
  for (const item of items) {
    frag.append(el("span", "health-item", item.message));
  }
  return frag;
}

// ---------------------------------------------------------------------------
// Milestone roadmap — design/uassist-spec.md Part XII: a horizontal timeline,
// milestones as bars, colored by status. Distinct from the board grid (it has
// no status/category/swimlane axes to pivot), so it is a separate render
// path rather than another BoardView preset.
// ---------------------------------------------------------------------------

import type { MilestoneWithProgress } from "./api.ts";

export function renderRoadmap(
  milestones: MilestoneWithProgress[],
  onSelect: (milestoneId: string) => void,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (milestones.length === 0) {
    frag.append(el("div", "empty", "No milestones yet. Import a plan first."));
    return frag;
  }

  const wrap = el("div", "roadmap");
  for (const m of milestones) {
    const row = el("div", "roadmap-row");
    row.addEventListener("click", () => onSelect(m.id));

    row.append(el("span", "roadmap-phase", m.phaseNumber !== undefined ? `P${m.phaseNumber}` : ""));
    row.append(el("span", "roadmap-title", m.title));

    const track = el("div", "roadmap-bar-track");
    const fill = el("div", "roadmap-bar-fill");
    fill.dataset["status"] = m.status;
    fill.style.width = `${m.percent}%`;
    track.append(fill);
    row.append(track);

    row.append(el("span", "roadmap-pct", `${m.percent}%`));
    row.append(el("span", "roadmap-meta", `${m.doneCount}/${m.cardCount}`));

    wrap.append(row);
  }
  frag.append(wrap);
  return frag;
}

export { NONE, el };
