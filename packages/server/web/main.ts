/**
 * UAssist board — entry point.
 *
 * Holds the single state snapshot, the WebSocket connection, and the
 * drag-and-drop wiring. Rendering lives in render.ts; the detail panel in
 * detail.ts; server access in api.ts.
 */

import type { BoardResponse, CardId, Status } from "@uassist/core";
import { api, ApiError, type MilestoneWithProgress, type ProjectSummary, type ViewSummary } from "./api.ts";
import { AiConfigPanel } from "./aiConfig.ts";
import { DetailPanel } from "./detail.ts";
import { HelpPanel } from "./help.ts";
import { el, renderBoard, renderHealthLane, renderRoadmap } from "./render.ts";

// ---------------------------------------------------------------------------
// State — one immutable snapshot. Nothing mutates in place.
// ---------------------------------------------------------------------------

interface State {
  project?: ProjectSummary;
  views: ViewSummary[];
  board?: BoardResponse;
  view: string;
  search: string;
  seq: number;
  connection: "online" | "syncing" | "offline";
  /** "roadmap" replaces the grid with the milestone timeline — a different
   *  shape (no status/category axes), not another board view preset. */
  mode: "board" | "roadmap";
}

let state: State = {
  views: [],
  view: localStorage.getItem("uassist.view") ?? "plan",
  search: "",
  seq: 0,
  connection: "syncing",
  mode: "board",
};

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
}

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

const boardHost = $("#board");
const healthHost = $("#health");
const viewSelect = $<HTMLSelectElement>("#view");
const searchInput = $<HTMLInputElement>("#search");
const roadmapToggle = $<HTMLButtonElement>("#roadmap-toggle");
const projectName = $("#project-name");
const countsLabel = $("#counts");
const connDot = $("#conn");
const aiConfigButton = $("#ai-config");
const helpButton = $("#help");
const decisionsBadge = $("#decisions-badge");

const aiConfigPanel = new AiConfigPanel();
const helpPanel = new HelpPanel();

aiConfigButton.addEventListener("click", () => {
  aiConfigPanel.open();
});

helpButton.addEventListener("click", () => {
  helpPanel.open("overview");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    helpPanel.open("overview");
  }
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Phase 1 refetches the board on every change rather than patching cells in
 * place. At this data size the query is well under a millisecond and the
 * correctness is free; the trigger to write an incremental path is a measured
 * frame drop, not a hunch. Scroll position is preserved so it does not read as
 * a reload.
 */
function paintBoard(): void {
  const board = state.board;
  if (!board) return;

  const { scrollTop, scrollLeft } = boardHost;
  boardHost.replaceChildren(renderBoard(board));
  boardHost.scrollTop = scrollTop;
  boardHost.scrollLeft = scrollLeft;

  healthHost.replaceChildren(renderHealthLane(board.health));
  countsLabel.textContent = `${board.total} card${board.total === 1 ? "" : "s"}`;
}

async function paintRoadmap(): Promise<void> {
  try {
    const { milestones } = await api.milestones();
    boardHost.replaceChildren(renderRoadmap(milestones, onRoadmapSelect));
    countsLabel.textContent = `${milestones.length} milestone${milestones.length === 1 ? "" : "s"}`;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

/** Clicking a roadmap row jumps to that milestone's lane on the board — the
 *  board needs a milestone-swimlaned view to have a lane to jump to. */
function onRoadmapSelect(milestoneId: string): void {
  const needsMilestoneLanes = !["plan", "assignments"].includes(state.view);
  if (needsMilestoneLanes) {
    setState({ view: "plan" });
    localStorage.setItem("uassist.view", "plan");
  }
  setState({ mode: "board" });
  paintChrome();
  void refreshBoard().then(() => {
    boardHost.querySelector(`.lane[data-lane="${milestoneId}"]`)?.scrollIntoView({ block: "start" });
  });
}

function paintChrome(): void {
  const summary = state.project;
  if (summary) projectName.textContent = summary.project.name;

  if (viewSelect.childElementCount !== state.views.length) {
    viewSelect.replaceChildren(
      ...state.views.map((v) => {
        const option = el("option", undefined, v.name);
        option.value = v.id;
        return option;
      }),
    );
  }
  viewSelect.value = state.view;
  connDot.dataset["state"] = state.connection;
  connDot.title = `Live updates: ${state.connection} (seq ${state.seq})`;

  const inRoadmap = state.mode === "roadmap";
  roadmapToggle.textContent = inRoadmap ? "Board" : "Roadmap";
  roadmapToggle.setAttribute("aria-pressed", String(inRoadmap));
  viewSelect.hidden = inRoadmap;
  searchInput.hidden = inRoadmap;
}

async function refreshBoard(): Promise<void> {
  if (state.mode === "roadmap") {
    await paintRoadmap();
    paintChrome();
    return;
  }
  try {
    const board = await api.board({ view: state.view, search: state.search });
    setState({ board, seq: Math.max(state.seq, board.seq) });
    paintBoard();
    paintChrome();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

/** Coalesce bursts of events into one refetch. */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshBoard(), 60);
}

async function refreshDecisionsBadge(): Promise<void> {
  try {
    const { suggestions } = await api.suggestions("pending");
    const count = suggestions.length;
    decisionsBadge.textContent = count > 99 ? "99+" : String(count);
    decisionsBadge.hidden = count === 0;
  } catch {
    // Non-critical chrome; a failed count fetch just leaves the badge as-is.
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function patchCard(
  id: CardId,
  patch: Record<string, unknown>,
  optimistic?: () => () => void,
): Promise<void> {
  const revert = optimistic?.();
  try {
    const result = await api.patchCard(id, patch);
    setState({ seq: Math.max(state.seq, result.seq) });
    detail.refreshIfOpen(id);
    // The WebSocket echo triggers the authoritative repaint. Schedule one
    // anyway so a dropped socket does not leave the board stale.
    scheduleRefresh();
  } catch (err) {
    revert?.();
    const message = err instanceof ApiError ? err.message : String(err);
    toast(`Could not update card: ${message}`);
    void refreshBoard();
  }
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

const detail = new DetailPanel({
  onOpenCard: (id) => void detail.open(id),
  onStatusChange: (id, status) => void patchCard(id, { status }),
  onAcceptanceToggle: (id, index, met) =>
    void patchCard(id, { acceptanceMet: { index, met } }),
  onAnchorChange: (id, anchor) => void patchCard(id, { anchor }),
  onError: (message) => toast(message),
  onChatEvent: (cardId) => {
    // Chat events arrive over the same WebSocket; no special action needed
    // here because the panel refreshes itself when it sees a matching event.
    detail.refreshChatIfOpen(cardId);
  },
});

// ---------------------------------------------------------------------------
// Drag and drop — native HTML5 DnD, card id in dataTransfer
// ---------------------------------------------------------------------------

let dragged: { id: CardId; node: HTMLElement } | undefined;

boardHost.addEventListener("dragstart", (e) => {
  const node = (e.target as HTMLElement).closest<HTMLElement>(".card");
  if (!node) return;
  const id = node.dataset["cardId"] as CardId | undefined;
  if (!id) return;
  dragged = { id, node };
  node.classList.add("dragging");
  e.dataTransfer?.setData("text/plain", id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

boardHost.addEventListener("dragend", () => {
  dragged?.node.classList.remove("dragging");
  document
    .querySelectorAll(".drop-target")
    .forEach((n) => n.classList.remove("drop-target"));
  dragged = undefined;
});

boardHost.addEventListener("dragover", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell");
  if (!cell || !dragged) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (!cell.classList.contains("drop-target")) {
    document
      .querySelectorAll(".drop-target")
      .forEach((n) => n.classList.remove("drop-target"));
    cell.classList.add("drop-target");
  }
});

boardHost.addEventListener("drop", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell");
  if (!cell || !dragged) return;
  e.preventDefault();
  cell.classList.remove("drop-target");

  const board = state.board;
  if (!board) return;

  // Which field the move edits depends on what the column axis is bound to.
  const axis = board.view.columns;
  const target = cell.dataset["column"];
  if (!target) return;

  const patch: Record<string, unknown> = {};
  if (axis === "status") patch["status"] = target as Status;
  else if (axis === "priority") patch["priority"] = target;
  else if (axis === "category") patch["category"] = target;
  else {
    toast(`Dragging is not supported on a "${axis}" column axis yet.`);
    return;
  }

  const { id, node } = dragged;
  const origin = node.parentElement;
  const nextSibling = node.nextSibling;
  if (origin === cell) return;

  // Optimistic: move the node now, revert it if the write fails.
  node.classList.add("pending");
  cell.append(node);

  void patchCard(id, patch, () => () => {
    node.classList.remove("pending");
    if (origin) origin.insertBefore(node, nextSibling);
  }).then(() => node.classList.remove("pending"));
});

boardHost.addEventListener("click", (e) => {
  const node = (e.target as HTMLElement).closest<HTMLElement>(".card");
  const id = node?.dataset["cardId"] as CardId | undefined;
  if (id) void detail.open(id);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

viewSelect.addEventListener("change", () => {
  setState({ view: viewSelect.value });
  localStorage.setItem("uassist.view", viewSelect.value);
  void refreshBoard();
});

roadmapToggle.addEventListener("click", () => {
  setState({ mode: state.mode === "roadmap" ? "board" : "roadmap" });
  paintChrome();
  void refreshBoard();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setState({ search: searchInput.value });
    void refreshBoard();
  }, 180);
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

let socket: WebSocket | undefined;
let reconnectDelay = 500;

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.addEventListener("open", () => {
    reconnectDelay = 500;
    setState({ connection: "online" });
    paintChrome();
    // Tell the server where we left off; it replays the gap or tells us to
    // resync. Without this, a closed laptop lid leaves a board that looks
    // correct and is wrong.
    socket?.send(JSON.stringify({ kind: "hello", lastSeq: state.seq }));
  });

  socket.addEventListener("message", (event) => {
    let msg: { kind: string; seq?: number; id?: string };
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    switch (msg.kind) {
      case "welcome":
        setState({ seq: msg.seq ?? state.seq });
        break;
      case "replay":
        setState({ seq: msg.seq ?? state.seq });
        scheduleRefresh();
        break;
      case "resync":
        setState({ seq: msg.seq ?? state.seq });
        void refreshBoard();
        break;
      case "pong":
        break;
      case "chatToken": {
        const cast = msg as { cardId?: string; token?: string; done?: boolean };
        if (cast.cardId) {
          detail.handleToken(cast.cardId as CardId, cast.token ?? "", cast.done ?? false);
        }
        break;
      }
      case "chatMessageAdded": {
        const cast = msg as { cardId?: string };
        if (cast.cardId) detail.handleMessage(cast.cardId as CardId);
        break;
      }
      case "jobOutput": {
        const cast = msg as { id?: string; text?: string };
        if (cast.id) detail.handleJobOutput(cast.id, cast.text ?? "");
        break;
      }
      case "jobUpdated": {
        const cast = msg as { cardId?: string };
        // The board picks up the card's status change (syncCardStatus on the
        // server) via the usual refresh. The panel gets a lighter, in-place
        // reload of just the jobs section — a full re-render here would also
        // clear jobOutputEls mid-stream for any other job still running.
        if (msg.seq !== undefined) setState({ seq: msg.seq });
        scheduleRefresh();
        if (cast.cardId) detail.handleJobUpdated(cast.cardId as CardId);
        break;
      }
      case "suggestionsChanged":
        if (msg.seq !== undefined) setState({ seq: msg.seq });
        void refreshDecisionsBadge();
        break;
      default:
        // Any domain event invalidates the board.
        if (msg.seq !== undefined) setState({ seq: msg.seq });
        scheduleRefresh();
        if (msg.kind === "cardChanged" && msg.id) {
          detail.refreshIfOpen(msg.id as CardId);
        }
    }
    paintChrome();
  });

  const drop = () => {
    setState({ connection: "offline" });
    paintChrome();
    socket = undefined;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };

  socket.addEventListener("close", drop);
  socket.addEventListener("error", () => socket?.close());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  try {
    const [project, views] = await Promise.all([api.project(), api.views()]);
    setState({ project, views, seq: project.seq });
    paintChrome();
    await refreshBoard();
    void refreshDecisionsBadge();
    connect();
  } catch (err) {
    boardHost.replaceChildren(
      el(
        "div",
        "empty",
        err instanceof ApiError && err.status === 404
          ? "No UAssist project here. Run `uassist init` and `uassist plan import <plan.md>`."
          : `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

void boot();
