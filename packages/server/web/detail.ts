/**
 * Card detail panel: acceptance criteria, anchor, links, source.
 */

import type { Anchor, CardId, Status } from "@uassist/core";
import {
  anchorForAsset,
  api,
  type CardDetail,
  type ChatMessage,
  type ChatThread,
  type Job,
  type WorkspaceAsset,
} from "./api.ts";
import { el } from "./render.ts";

export interface DetailHandlers {
  onOpenCard: (id: CardId) => void;
  onStatusChange: (id: CardId, status: Status) => void;
  onAcceptanceToggle: (id: CardId, index: number, met: boolean) => void;
  onAnchorChange: (id: CardId, anchor: Anchor) => void;
  onChatEvent: (cardId: CardId) => void;
  onError: (message: string) => void;
}

function anchorLabel(anchor: Anchor): string {
  switch (anchor.kind) {
    case "blenderObject":
      return `${anchor.blendFile}#${anchor.objectName}`;
    case "unityGameObject":
      return `${anchor.scene}#${anchor.path}`;
    case "commit":
      return anchor.sha;
    default:
      return anchor.path;
  }
}

const STATUSES: Status[] = ["open", "active", "blocked", "review", "done"];

export class DetailPanel {
  private node: HTMLElement | undefined;
  private openId: CardId | undefined;
  private chatThread: ChatThread | undefined;
  /** jobId -> its live output element, so a streamed jobOutput event knows
   *  where to append without re-rendering the whole panel. */
  private jobOutputEls: Map<string, HTMLElement> = new Map();
  private streaming: boolean = false;
  private streamingText: string = "";

  constructor(private readonly handlers: DetailHandlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  get currentId(): CardId | undefined {
    return this.openId;
  }

  async open(id: CardId): Promise<void> {
    this.openId = id;
    try {
      const detail = await api.card(id);
      // A slower earlier request must not overwrite a newer one.
      if (this.openId !== id) return;
      this.render(detail);
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err));
      this.close();
    }
  }

  /** Re-fetch if this card is the one on screen. */
  refreshIfOpen(id: CardId): void {
    if (this.openId === id) void this.open(id);
  }

  /** Refresh chat panel only without rebuilding the whole detail view. */
  refreshChatIfOpen(id: CardId): void {
    if (this.openId !== id) return;
    void this.loadChat(id);
  }

  close(): void {
    this.openId = undefined;
    this.jobOutputEls.clear();
    this.node?.remove();
    this.node = undefined;
  }

  private render(detail: CardDetail): void {
    const { card, milestone, links } = detail;
    this.jobOutputEls.clear();

    const panel = el("aside", "detail");
    const close = el("button", "close", "✕");
    close.title = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    panel.append(close);

    panel.append(el("h2", undefined, card.title));

    if (card.description && card.description !== card.title) {
      panel.append(el("p", undefined, card.description));
    }

    // --- fields
    const dl = el("dl");
    const field = (term: string, value: Node | string) => {
      dl.append(el("dt", undefined, term));
      const dd = el("dd");
      dd.append(typeof value === "string" ? document.createTextNode(value) : value);
      dl.append(dd);
    };

    const select = el("select");
    for (const s of STATUSES) {
      const option = el("option", undefined, s);
      option.value = s;
      if (s === card.status) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      this.handlers.onStatusChange(card.id, select.value as Status);
    });
    field("Status", select);

    field("Kind", card.kind);
    field("Category", card.category);
    if (card.subsystem) field("Subsystem", card.subsystem);
    field("Priority", card.priority);
    field(
      "Assignee",
      card.assignee.kind === "unassigned"
        ? "unassigned"
        : "name" in card.assignee
          ? card.assignee.name
          : card.assignee.kind,
    );
    if (card.owner) field("Owner", card.owner);
    if (milestone) {
      field(
        "Milestone",
        milestone.phaseNumber !== undefined
          ? `Phase ${milestone.phaseNumber} — ${milestone.title}`
          : milestone.title,
      );
    }
    if (card.timeSpentHours > 0) field("Time spent", `${card.timeSpentHours}h`);
    field("Version", String(card.version));
    panel.append(dl);

    // --- acceptance
    if (card.acceptance.length > 0) {
      panel.append(el("h3", undefined, "Acceptance"));
      const list = el("ul", "acceptance");
      card.acceptance.forEach((criterion, index) => {
        const li = el("li", criterion.met ? "met" : undefined);
        const box = el("input");
        box.type = "checkbox";
        box.checked = criterion.met;
        box.addEventListener("change", () => {
          this.handlers.onAcceptanceToggle(card.id, index, box.checked);
        });
        li.append(box, el("span", undefined, criterion.text));
        list.append(li);
      });
      panel.append(list);
    }

    // --- links
    const linkGroups: [string, typeof links.dependencies][] = [
      ["Blocked by", links.blockedBy],
      ["Depends on", links.dependencies],
      ["Related", links.related],
    ];
    for (const [label, group] of linkGroups) {
      if (group.length === 0) continue;
      panel.append(el("h3", undefined, label));
      const ul = el("ul", "link-list");
      for (const link of group) {
        const li = el("li");
        const button = el("button", undefined, `${link.title} · ${link.status}`);
        button.addEventListener("click", () => this.handlers.onOpenCard(link.id));
        li.append(button);
        ul.append(li);
      }
      panel.append(ul);
    }

    // --- anchor and provenance
    panel.append(el("h3", undefined, "Anchor"));
    panel.append(this.renderAnchorSection(card.id, card.anchor));
    if (card.source) {
      panel.append(el("h3", undefined, "Source"));
      panel.append(
        el(
          "div",
          "source",
          `${card.source.file}:${card.source.startLine}`,
        ),
      );
    }

    // --- jobs / dispatch
    panel.append(el("h3", undefined, "Agent jobs"));
    const jobsHost = el("div");
    panel.append(jobsHost);
    void this.loadJobs(card.id, jobsHost);

    // --- chat
    const chatHeader = el("h3", undefined, "Assistant chat");
    panel.append(chatHeader);
    const chatHost = el("div", "chat-host");
    panel.append(chatHost);

    const composer = el("div", "chat-composer");
    const chatInput = el("textarea") as HTMLTextAreaElement;
    chatInput.placeholder = "Ask about this task...";
    chatInput.rows = 2;
    const sendBtn = el("button", "primary", "Send");

    const doSend = () => {
      const text = chatInput.value.trim();
      if (!text || this.streaming) return;
      chatInput.value = "";
      this.appendLocalMessage(chatHost, { role: "user", content: text, createdAt: Date.now() });
      this.streaming = true;
      this.streamingText = "";
      this.appendStreamingBubble(chatHost);
      void this.sendMessage(card.id, text);
    };

    sendBtn.addEventListener("click", doSend);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    composer.append(chatInput, sendBtn);
    panel.append(composer);

    void this.loadChat(card.id, chatHost);

    this.node?.remove();
    this.node = panel;
    document.body.append(panel);
  }

  /**
   * The anchor picker (design/workspace-spec.md Part IV): search the real
   * Asset Catalog instead of typing a path and hoping. Selecting a result
   * PATCHes the card's anchor to something that was just confirmed to exist.
   */
  private renderAnchorSection(cardId: CardId, anchor: Anchor | undefined): HTMLElement {
    const section = el("div");

    if (anchor) {
      const row = el("div", "source");
      row.textContent = `${anchor.kind}: ${anchorLabel(anchor)}`;
      section.append(row);
      void this.checkAnchorResolves(anchor, row);
    } else {
      section.append(el("p", "hint", "No anchor set. This card describes the plan, not yet a real artifact."));
    }

    const changeBtn = el("button", undefined, anchor ? "Change anchor" : "Attach anchor");
    changeBtn.style.marginTop = "6px";
    changeBtn.addEventListener("click", () => this.openAnchorPicker(cardId, section));
    section.append(changeBtn);

    return section;
  }

  private async checkAnchorResolves(anchor: Anchor, row: HTMLElement): Promise<void> {
    if (anchor.kind === "commit") return; // nothing in the catalog to check this against
    try {
      const path = anchorLabel(anchor);
      const { assets } = await api.searchAssets({ q: path, limit: 10 });
      const resolved = assets.some((a) => a.path === path);
      row.append(
        el("span", `badge ${resolved ? "badge-ok" : "badge-bad"}`, resolved ? " found" : " not in catalog"),
      );
    } catch {
      // Workspace not linked / not scanned yet — silently skip the badge
      // rather than implying the anchor is broken when we just can't check.
    }
  }

  private openAnchorPicker(cardId: CardId, host: HTMLElement): void {
    if (host.querySelector(".anchor-picker")) return; // already open

    const picker = el("div", "anchor-picker");
    picker.style.marginTop = "8px";
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search the asset catalog…";
    input.style.width = "100%";
    const results = el("div");
    results.style.marginTop = "4px";
    picker.append(input, results);
    host.append(picker);
    input.focus();

    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length === 0) {
          results.replaceChildren();
          return;
        }
        try {
          const { assets } = await api.searchAssets({ q, limit: 12 });
          this.renderAnchorResults(assets, results, cardId, picker);
        } catch (err) {
          this.handlers.onError(err instanceof Error ? err.message : String(err));
        }
      }, 150);
    });
  }

  private renderAnchorResults(
    assets: WorkspaceAsset[],
    host: HTMLElement,
    cardId: CardId,
    picker: HTMLElement,
  ): void {
    host.replaceChildren();
    if (assets.length === 0) {
      host.append(el("p", "hint", "No matches. Has the workspace been scanned on the Project page?"));
      return;
    }
    const list = el("ul", "link-list");
    for (const asset of assets) {
      const li = el("li");
      const button = el("button", undefined, `${asset.path}  ·  ${asset.kind}`);
      button.addEventListener("click", () => {
        this.handlers.onAnchorChange(cardId, anchorForAsset(asset));
        picker.remove();
      });
      li.append(button);
      list.append(li);
    }
    host.append(list);
  }

  // ---------------------------------------------------------------------
  // Jobs / dispatch — design/uassist-spec.md Part IX. Propose-then-apply:
  // a job's output only ever reaches the working tree through accept,
  // triggered here by a human looking at a diff.
  // ---------------------------------------------------------------------

  private async loadJobs(cardId: CardId, host: HTMLElement): Promise<void> {
    try {
      const { jobs } = await api.cardJobs(cardId);
      host.replaceChildren();
      for (const job of jobs) host.append(this.renderJobRow(job));
      host.append(this.renderDispatchForm(cardId));
    } catch (err) {
      host.replaceChildren(el("p", "hint", `Could not load jobs: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private renderJobRow(job: Job): HTMLElement {
    const row = el("div");

    const head = el("div", "job-row");
    const badge = el("span", "job-state", job.state.replace("_", " "));
    badge.dataset["state"] = job.state;
    head.append(badge);
    head.append(el("span", "job-agent", job.agent));
    if (job.costUsd > 0) head.append(el("span", "job-cost", `$${job.costUsd.toFixed(3)}`));
    row.append(head);

    if (job.state === "dispatched" || job.state === "running") {
      const output = el("div", "job-output", "");
      row.append(output);
      this.jobOutputEls.set(job.id, output);
    }

    if (job.state === "returned" || job.state === "review") {
      const reviewBtn = el("button", undefined, "Review diff");
      reviewBtn.addEventListener("click", () => void this.openDiffReview(job, row, reviewBtn));
      row.append(reviewBtn);
    }

    if (job.attempts.length > 0) {
      const lastNote = job.attempts.at(-1)?.note;
      if (lastNote) row.append(el("p", "hint", lastNote));
    }

    return row;
  }

  private async openDiffReview(job: Job, host: HTMLElement, trigger: HTMLButtonElement): Promise<void> {
    trigger.setAttribute("disabled", "true");
    trigger.textContent = "Loading diff…";
    try {
      const { diff, stat } = await api.jobDiff(job.id);
      trigger.remove();

      host.append(
        el(
          "p",
          "hint",
          `${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} changed, +${stat.insertions} −${stat.deletions}`,
        ),
      );
      host.append(this.renderDiff(diff));

      const actions = el("div");
      actions.style.marginTop = "6px";
      actions.style.display = "flex";
      actions.style.gap = "8px";

      const acceptBtn = el("button", "primary", "Accept");
      acceptBtn.addEventListener("click", async () => {
        try {
          await api.acceptJob(job.id);
          this.refreshIfOpen(job.cardId);
        } catch (err) {
          this.handlers.onError(err instanceof Error ? err.message : String(err));
        }
      });

      const rejectBtn = el("button", "danger", "Reject");
      rejectBtn.addEventListener("click", async () => {
        try {
          await api.rejectJob(job.id);
          this.refreshIfOpen(job.cardId);
        } catch (err) {
          this.handlers.onError(err instanceof Error ? err.message : String(err));
        }
      });

      actions.append(acceptBtn, rejectBtn);
      host.append(actions);
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err));
      trigger.removeAttribute("disabled");
      trigger.textContent = "Review diff";
    }
  }

  /** A minimal unified-diff colorizer — +/- lines and @@ hunks only, no
   *  syntax highlighting. Proportionate to what a review needs here; a real
   *  side-by-side diff viewer is a bigger UI this project does not have yet
   *  for any content type. */
  private renderDiff(diff: string): HTMLElement {
    const pre = el("pre", "diff-view");
    for (const line of diff.split("\n")) {
      const span = document.createElement("span");
      if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
      else if (line.startsWith("@@")) span.className = "diff-hunk";
      span.textContent = line + "\n";
      pre.append(span);
    }
    return pre;
  }

  private renderDispatchForm(cardId: CardId): HTMLElement {
    const form = el("div", "dispatch-form");

    const agentLabel = el("label", undefined, "Agent");
    const agentSelect = el("select");
    form.append(agentLabel, agentSelect);
    void api
      .adapters()
      .then(({ adapters }) => {
        agentSelect.replaceChildren(
          ...adapters.map((id) => {
            const option = el("option", undefined, id);
            option.value = id;
            return option;
          }),
        );
      })
      .catch(() => {
        agentSelect.replaceChildren(el("option", undefined, "(no adapters available)"));
      });

    const objLabel = el("label", undefined, "Objective (optional override)");
    const objInput = el("textarea") as HTMLTextAreaElement;
    objInput.rows = 2;
    objInput.placeholder = "Leave blank to use the card's title and description.";
    form.append(objLabel, objInput);

    const budgetRow = el("div", "dispatch-budget-row");
    const costWrap = el("div");
    costWrap.append(el("label", undefined, "Max cost (USD)"));
    const costInput = el("input");
    costInput.type = "number";
    costInput.step = "0.1";
    costInput.value = "2";
    costWrap.append(costInput);

    const durWrap = el("div");
    durWrap.append(el("label", undefined, "Max minutes"));
    const durInput = el("input");
    durInput.type = "number";
    durInput.value = "10";
    durWrap.append(durInput);

    budgetRow.append(costWrap, durWrap);
    form.append(budgetRow);

    const dispatchBtn = el("button", "primary", "Dispatch");
    dispatchBtn.addEventListener("click", async () => {
      dispatchBtn.setAttribute("disabled", "true");
      dispatchBtn.textContent = "Dispatching…";
      try {
        await api.dispatch(cardId, {
          agentId: agentSelect.value,
          objectiveOverride: objInput.value.trim() || undefined,
          maxCostUsd: Number(costInput.value) || undefined,
          maxDurationMs: Number(durInput.value) ? Number(durInput.value) * 60_000 : undefined,
        });
        this.refreshIfOpen(cardId);
      } catch (err) {
        this.handlers.onError(err instanceof Error ? err.message : String(err));
      } finally {
        dispatchBtn.removeAttribute("disabled");
        dispatchBtn.textContent = "Dispatch";
      }
    });
    form.append(dispatchBtn);

    return form;
  }

  /** Called by main.ts when a jobOutput event arrives over the WebSocket. */
  handleJobOutput(jobId: string, text: string): void {
    const el = this.jobOutputEls.get(jobId);
    if (!el) return;
    el.textContent += (el.textContent ? "\n" : "") + text;
    el.scrollTop = el.scrollHeight;
  }

  /** Called by main.ts when a jobUpdated event arrives for the open card.
   *  Reloads the jobs list — small enough that this beats patching one row
   *  in place, and it is what picks up a job that just moved into review. */
  handleJobUpdated(cardId: CardId): void {
    void this.refreshJobsSection(cardId);
  }

  private async refreshJobsSection(cardId: CardId): Promise<void> {
    if (this.openId !== cardId || !this.node) return;
    const heading = [...this.node.querySelectorAll("h3")].find((h) => h.textContent === "Agent jobs");
    const host = heading?.nextElementSibling;
    if (host instanceof HTMLElement) void this.loadJobs(cardId, host);
  }

  private async loadChat(cardId: CardId, host?: HTMLElement): Promise<void> {
    try {
      const { thread, messages, cardId: returnedId } = await api.chat(cardId);
      this.chatThread = thread ?? (returnedId ? { cardId: returnedId as CardId, messages: messages ?? [], updatedAt: Date.now() } : undefined);
      const target = host ?? this.node?.querySelector(".chat-host") ?? undefined;
      if (!target) return;
      target.replaceChildren();
      for (const m of this.chatThread?.messages ?? []) {
        target.append(this.renderMessage(m));
      }
      target.scrollTop = target.scrollHeight;
    } catch (err) {
      // Non-fatal: chat may be offline.
    }
  }

  private renderMessage(m: ChatMessage): HTMLElement {
    const node = el("div", `chat-message chat-message-${m.role}`);
    const meta = el("div", "chat-meta", m.role === "assistant" ? (m.name ?? "Assistant") : "You");
    const content = el("div", "chat-content", m.content);
    node.append(meta, content);
    return node;
  }

  private appendLocalMessage(host: HTMLElement, m: ChatMessage): void {
    host.append(this.renderMessage(m));
    host.scrollTop = host.scrollHeight;
  }

  private appendStreamingBubble(host: HTMLElement): HTMLElement {
    const node = el("div", "chat-message chat-message-assistant streaming");
    const meta = el("div", "chat-meta", "Assistant");
    const content = el("div", "chat-content", "");
    node.append(meta, content);
    host.append(node);
    host.scrollTop = host.scrollHeight;
    return content;
  }

  private appendStreamingToken(token: string): void {
    const content = this.node?.querySelector(".chat-host .streaming .chat-content");
    if (!content) return;
    this.streamingText += token;
    content.textContent = this.streamingText;
    const host = this.node?.querySelector(".chat-host");
    if (host) host.scrollTop = host.scrollHeight;
  }

  private finishStreaming(): void {
    const bubble = this.node?.querySelector(".chat-host .streaming");
    bubble?.classList.remove("streaming");
    this.streaming = false;
    this.streamingText = "";
  }

  private async sendMessage(cardId: CardId, text: string): Promise<void> {
    try {
      await api.sendChat(cardId, text);
    } catch (err) {
      this.finishStreaming();
      this.handlers.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Called by main.ts when a chatToken event arrives over the WebSocket. */
  handleToken(cardId: CardId, token: string, done: boolean): void {
    if (this.openId !== cardId) return;
    this.appendStreamingToken(token);
    if (done) this.finishStreaming();
  }

  /** Called by main.ts when a chatMessageAdded event arrives. */
  handleMessage(cardId: CardId): void {
    if (this.openId !== cardId) return;
    void this.loadChat(cardId);
  }
}
