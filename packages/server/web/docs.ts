/**
 * Docs page — list, view, edit `.uassist/docs/*.md`, and chat with the
 * assistant about the selected document.
 *
 * See design/workspace-spec.md Part V.
 */

import type { ChatMessage } from "@uassist/core";
import { api, ApiError, type DocSummary } from "./api.ts";
import { el } from "./render.ts";

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

const sidebar = $("#docs-sidebar");
const mainPane = $("#docs-main");
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

let docs: DocSummary[] = [];
let currentPath: string | undefined;
let editing = false;
let streaming = false;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function paintSidebar(): void {
  sidebar.replaceChildren();
  if (docs.length === 0) {
    sidebar.append(el("p", "hint", "No documents yet."));
  }
  for (const doc of docs) {
    const item = el("button", "docs-sidebar-item", doc.title);
    if (doc.isPlan) item.append(el("span", "plan-badge", "plan"));
    item.dataset["path"] = doc.path;
    if (doc.path === currentPath) item.setAttribute("aria-current", "true");
    item.addEventListener("click", () => void openDoc(doc.path));
    sidebar.append(item);
  }

  const newBtn = el("button", "docs-sidebar-item", "+ New document");
  newBtn.style.marginTop = "8px";
  newBtn.style.color = "var(--accent)";
  newBtn.addEventListener("click", async () => {
    const name = prompt("File name (e.g. architecture-notes.md):");
    if (!name) return;
    const path = name.endsWith(".md") ? name : `${name}.md`;
    try {
      await api.saveDoc(path, `# ${path.replace(/\.md$/, "")}\n\n`);
      await refreshDocs();
      await openDoc(path);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  sidebar.append(newBtn);
}

async function refreshDocs(): Promise<void> {
  const { docs: list } = await api.docs();
  docs = list;
  paintSidebar();
}

// ---------------------------------------------------------------------------
// Main pane: viewer / editor
// ---------------------------------------------------------------------------

function simpleMarkdownToText(md: string): string {
  // Deliberately not a Markdown renderer — a monospace pre-wrap view of the
  // raw text is honest about what a plain textarea editor produces, and
  // matches this project's stance against pulling in a rendering dependency
  // for a small, legible surface. Headings still read fine as plain text.
  return md;
}

async function openDoc(path: string): Promise<void> {
  currentPath = path;
  editing = false;
  paintSidebar();

  try {
    const doc = await api.doc(path);
    renderDoc(doc.path, doc.title, doc.content, doc.isPlan);
    void loadChat(path);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

function renderDoc(path: string, title: string, content: string, isPlan: boolean): void {
  mainPane.replaceChildren();

  const toolbar = el("div", "docs-toolbar");
  toolbar.append(el("h2", undefined, title));
  if (isPlan) toolbar.append(el("span", "badge badge-off", "imported plan"));

  if (!isPlan) {
    const editBtn = el("button", undefined, editing ? "View" : "Edit");
    editBtn.addEventListener("click", () => {
      editing = !editing;
      renderDoc(path, title, content, isPlan);
    });
    toolbar.append(editBtn);
  }
  mainPane.append(toolbar);

  if (editing && !isPlan) {
    const textarea = el("textarea", "docs-editor") as HTMLTextAreaElement;
    textarea.value = content;
    mainPane.append(textarea);

    const saveBtn = el("button", "primary", "Save");
    saveBtn.style.marginTop = "10px";
    saveBtn.addEventListener("click", async () => {
      try {
        const saved = await api.saveDoc(path, textarea.value);
        content = textarea.value;
        editing = false;
        await refreshDocs();
        renderDoc(path, saved.title, content, isPlan);
        toast("Saved.");
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    });
    mainPane.append(saveBtn);
  } else {
    mainPane.append(el("div", "docs-view", simpleMarkdownToText(content)));
    if (isPlan) {
      const hint = el(
        "p",
        "hint",
        "This is the imported build plan. Edit it on disk and re-import with `uassist plan import` to update cards.",
      );
      mainPane.append(hint);
    }
  }

  // --- chat
  const chatSection = el("div", "docs-chat");
  chatSection.append(el("h3", undefined, "Discuss this document"));
  const chatHost = el("div", "chat-host");
  chatSection.append(chatHost);

  const composer = el("div", "chat-composer");
  const chatInput = el("textarea") as HTMLTextAreaElement;
  chatInput.placeholder = "Ask about this document...";
  chatInput.rows = 2;
  const sendBtn = el("button", "primary", "Send");

  const doSend = () => {
    const text = chatInput.value.trim();
    if (!text || streaming) return;
    chatInput.value = "";
    appendLocalMessage(chatHost, { role: "user", content: text, createdAt: Date.now() });
    streaming = true;
    appendStreamingBubble(chatHost);
    void sendChatMessage(path, text);
  };
  sendBtn.addEventListener("click", doSend);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  composer.append(chatInput, sendBtn);
  chatSection.append(composer);
  mainPane.append(chatSection);
}

// ---------------------------------------------------------------------------
// Chat — mirrors the card detail panel's pattern (detail.ts), pointed at
// /api/docs/:path/chat instead of /api/cards/:id/chat.
// ---------------------------------------------------------------------------

function renderMessage(m: ChatMessage): HTMLElement {
  const node = el("div", `chat-message chat-message-${m.role}`);
  node.append(el("div", "chat-meta", m.role === "assistant" ? (m.name ?? "Assistant") : "You"));
  node.append(el("div", "chat-content", m.content));
  return node;
}

function appendLocalMessage(host: HTMLElement, m: ChatMessage): void {
  host.append(renderMessage(m));
  host.scrollTop = host.scrollHeight;
}

function appendStreamingBubble(host: HTMLElement): void {
  const node = el("div", "chat-message chat-message-assistant streaming");
  node.append(el("div", "chat-meta", "Assistant"));
  node.append(el("div", "chat-content", ""));
  host.append(node);
  host.scrollTop = host.scrollHeight;
}

async function loadChat(path: string): Promise<void> {
  try {
    const { thread, messages } = await api.docChat(path);
    const host = mainPane.querySelector<HTMLElement>(".chat-host");
    if (!host) return;
    host.replaceChildren();
    for (const m of thread?.messages ?? messages ?? []) host.append(renderMessage(m));
    host.scrollTop = host.scrollHeight;
  } catch {
    // Non-fatal: chat may be offline.
  }
}

async function sendChatMessage(path: string, text: string): Promise<void> {
  try {
    await api.sendDocChat(path, text);
  } catch (err) {
    streaming = false;
    toast(err instanceof Error ? err.message : String(err));
  }
}

function handleDocChatToken(path: string, token: string, done: boolean): void {
  if (currentPath !== path) return;
  const bubble = mainPane.querySelector<HTMLElement>(".chat-host .streaming .chat-content");
  if (bubble) bubble.textContent += token;
  const host = mainPane.querySelector<HTMLElement>(".chat-host");
  if (host) host.scrollTop = host.scrollHeight;
  if (done) {
    mainPane.querySelector(".chat-host .streaming")?.classList.remove("streaming");
    streaming = false;
  }
}

function handleDocChatMessage(path: string): void {
  if (currentPath !== path) return;
  void loadChat(path);
}

// ---------------------------------------------------------------------------
// Live updates — a minimal connection scoped to what this page needs.
// ---------------------------------------------------------------------------

let socket: WebSocket | undefined;
let reconnectDelay = 500;

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.addEventListener("open", () => {
    reconnectDelay = 500;
    connDot.dataset["state"] = "online";
    socket?.send(JSON.stringify({ kind: "hello" }));
  });

  socket.addEventListener("message", (event) => {
    let msg: { kind: string; docPath?: string; token?: string; done?: boolean; path?: string };
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    switch (msg.kind) {
      case "docChatToken":
        if (msg.docPath) handleDocChatToken(msg.docPath, msg.token ?? "", msg.done ?? false);
        break;
      case "docChatMessageAdded":
        if (msg.docPath) handleDocChatMessage(msg.docPath);
        break;
      case "docChanged":
        void refreshDocs();
        break;
      default:
        break;
    }
  });

  const drop = () => {
    connDot.dataset["state"] = "offline";
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
    const project = await api.project();
    projectName.textContent = project.project.name;
    await refreshDocs();
    if (docs.length > 0) await openDoc(docs[0]!.path);
    else mainPane.append(el("div", "empty", "No documents yet — create one from the sidebar."));
    connect();
  } catch (err) {
    mainPane.replaceChildren(
      el(
        "div",
        "empty",
        err instanceof ApiError && err.status === 404
          ? "No UAssist project here. Run `uassist init` first."
          : `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

void boot();
