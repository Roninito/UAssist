/**
 * Decisions page — the queue reconciliation proposes into, and the human
 * says yes / no / hold to. See design/automation-spec.md Part IV.
 */

import type { Suggestion, SuggestionStatus } from "./api.ts";
import { api, ApiError } from "./api.ts";
import { el } from "./render.ts";

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

const host = $("#decisions");
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

const TABS: { status: SuggestionStatus; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "accepted", label: "Accepted" },
  { status: "rejected", label: "Rejected" },
  { status: "held", label: "Held" },
];

let activeTab: SuggestionStatus = "pending";

function summarize(s: Suggestion): string {
  const p = s.payload as Record<string, unknown>;
  if (s.kind === "create_card") {
    return `Create card "${String(p["title"] ?? "?")}"`;
  }
  if (s.kind === "attach_anchor") {
    const anchor = p["anchor"] as { kind?: string } | undefined;
    return `Attach ${anchor?.kind ?? "an"} anchor to an existing card`;
  }
  if (s.kind === "update_card_status") {
    return `Move a card to ${String(p["toStatus"] ?? "review")}`;
  }
  return s.kind;
}

function renderRow(s: Suggestion, onDecided: () => void): HTMLElement {
  const row = el("div", "suggestion-row");

  const head = el("div", "suggestion-head");
  head.append(el("span", "badge", s.kind));
  head.append(el("span", "suggestion-summary", summarize(s)));
  row.append(head);

  row.append(el("p", "suggestion-rationale", s.rationale));

  if (s.status === "pending") {
    const actions = el("div", "suggestion-actions");
    const decide = async (action: "accept" | "reject" | "hold") => {
      try {
        if (action === "accept") await api.acceptSuggestion(s.id);
        else if (action === "reject") await api.rejectSuggestion(s.id);
        else await api.holdSuggestion(s.id);
        onDecided();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      }
    };

    const accept = el("button", "accept", "Accept");
    accept.addEventListener("click", () => void decide("accept"));
    const reject = el("button", "reject", "Reject");
    reject.addEventListener("click", () => void decide("reject"));
    const hold = el("button", undefined, "Hold");
    hold.addEventListener("click", () => void decide("hold"));

    actions.append(accept, reject, hold);
    row.append(actions);
  } else {
    const badgeClass = s.status === "accepted" ? "badge-ok" : s.status === "rejected" ? "badge-bad" : "badge-off";
    row.append(el("span", `badge ${badgeClass}`, s.status));
  }

  return row;
}

async function paint(): Promise<void> {
  const tabs = el("div", "decisions-tabs");
  for (const tab of TABS) {
    const button = el("button", undefined, tab.label);
    button.setAttribute("aria-pressed", String(tab.status === activeTab));
    button.addEventListener("click", () => {
      activeTab = tab.status;
      void paint();
    });
    tabs.append(button);
  }

  let suggestions: Suggestion[];
  try {
    ({ suggestions } = await api.suggestions(activeTab));
  } catch (err) {
    host.replaceChildren(
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

  connDot.dataset["state"] = "online";

  const list = el("div", "decisions-list");
  if (suggestions.length === 0) {
    list.append(el("p", "hint", `No ${activeTab} suggestions.`));
  } else {
    for (const s of suggestions) list.append(renderRow(s, () => void paint()));
  }

  host.replaceChildren(tabs, list);
}

async function boot(): Promise<void> {
  try {
    const project = await api.project();
    projectName.textContent = project.project.name;
  } catch {
    // paint() below reports the same failure with a proper empty state.
  }
  await paint();
}

void boot();
