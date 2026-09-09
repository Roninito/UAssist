/**
 * In-app help / documentation panel.
 *
 * A single-file documentation set rendered as a slide-over panel. The first page
 * is an overview that links to detailed pages. Styling borrows from the
 * clean, readable Claude/docs theme: warm neutral palette, serif headings,
 * sans body, generous line-height, and a two-pane layout (sidebar nav + content).
 */

import { el } from "./render.ts";

export type HelpPageId =
  | "overview"
  | "getting-started"
  | "project-setup"
  | "board"
  | "cards"
  | "ai-chat"
  | "ai-config"
  | "plans"
  | "agents"
  | "validators"
  | "roadmap"
  | "workspace-docs"
  | "assets"
  | "keyboard";

interface HelpPage {
  id: HelpPageId;
  title: string;
  body: (string | HTMLElement)[];
}

function mdBlock(...lines: string[]): HTMLElement {
  const p = el("p");
  for (const line of lines) p.append(line, el("br"));
  if (p.lastChild) p.removeChild(p.lastChild);
  return p;
}

function section(title: string, ...children: (string | HTMLElement)[]): HTMLElement {
  const node = el("section");
  node.append(el("h2", undefined, title));
  for (const child of children) node.append(typeof child === "string" ? el("p", undefined, child) : child);
  return node;
}

function list(...items: (string | HTMLElement)[]): HTMLElement {
  const ul = el("ul");
  for (const item of items) {
    const li = el("li");
    li.append(typeof item === "string" ? document.createTextNode(item) : item);
    ul.append(li);
  }
  return ul;
}

function code(text: string): HTMLElement {
  return el("code", undefined, text);
}

function link(id: HelpPageId, label: string): HTMLElement {
  const a = el("a", "help-link", label);
  a.href = `#${id}`;
  a.dataset["page"] = id;
  return a;
}

const PAGES: HelpPage[] = [
  {
    id: "overview",
    title: "UAssist Help",
    body: [
      mdBlock(
        "UAssist is a local project coordination and asset-development tracker for games built in Unity and Blender. It turns a Markdown build plan into a living kanban board, anchors work to real files and objects, and lets you chat with an AI assistant about any task.",
      ),
      section(
        "What UAssist is",
        list(
          "A living project map for Unity + Blender games.",
          "A plan importer that converts Markdown build plans into milestones and cards.",
          "A kanban board with status, category, milestone, and assignee axes.",
          "An AI coordination surface for discussion, breakdowns, and agent dispatch.",
          "A validator runner that writes the health backlog for you.",
        ),
      ),
      section(
        "What UAssist is not",
        list(
          "A game engine, or a replacement for Unity, Blender, Git, or your IDE.",
          "A hosted service. It runs on localhost and reads your project directory.",
          "A runtime component of the shipped game.",
        ),
      ),
      section(
        "Core doctrine",
        list(
          "Tasks anchor to objects — a card about a weapon links to its .blend, prefab, and C# script.",
          "The backlog writes itself — validators and agents emit work items.",
          "Split work by verifiability — agents write code; humans run it and look at the result.",
          "Agents never touch the working tree — results arrive as reviewable diffs in isolated git worktrees.",
          "Ship the game — every feature must name the in-game thing it unblocks.",
          "The database is a cache; the JSON mirror is the source — you can rebuild the DB from .uassist/ at any time.",
        ),
      ),
      section(
        "Help topics",
        list(
          link("getting-started", "Getting started"),
          link("project-setup", "Project and workspace setup"),
          link("board", "Using the board"),
          link("cards", "Working with cards"),
          link("assets", "Asset catalog and anchors"),
          link("ai-chat", "AI chat on tasks"),
          link("workspace-docs", "Workspace documents"),
          link("ai-config", "Configuring AI providers"),
          link("plans", "Importing and updating plans"),
          link("agents", "Dispatching agents"),
          link("validators", "Validators and health lane"),
          link("roadmap", "Roadmap view"),
          link("keyboard", "Keyboard shortcuts"),
        ),
      ),
    ],
  },

  {
    id: "getting-started",
    title: "Getting started",
    body: [
      section(
        "1. Initialize a project",
        mdBlock("Open a terminal in your Unity/Blender project root and run:"),
        code("uassist init"),
        mdBlock("This creates a .uassist/ directory next to your source files.",
          "Project state lives in .uassist/ as deterministic, git-tracked JSON files plus a rebuildable SQLite cache.",
        ),
      ),
      section(
        "2. Import a build plan",
        mdBlock("Point UAssist at a Markdown plan with phase headings and task bullets:"),
        code("uassist plan import design/unity-colony-build-plan.md"),
        mdBlock("The importer creates milestones from ## Phase N — Name headings and cards from each bullet inside a phase.",
          "Re-importing later produces a reviewable diff rather than overwriting everything.",
        ),
      ),
      section(
        "3. Link the workspace",
        mdBlock("Open the Project page from the top nav and set the Unity and/or Blender project paths. Then click Rescan to build the asset catalog. This lets cards anchor to real files instead of typed guesses.",
        ),
      ),
      section(
        "4. Open the board",
        mdBlock("Start the server and open the web UI:"),
        code("uassist board"),
        mdBlock("Or run the server in the foreground with:"),
        code("uassist serve"),
        mdBlock("By default the server binds to 127.0.0.1:7373. If that port is taken, UAssist probes upward and writes the live port to .uassist/port.",
        ),
      ),
      section(
        "5. Common CLI commands",
        list(
          code("uassist status") as unknown as string + " — project summary",
          code("uassist cards --status blocked") as unknown as string + " — list cards",
          code("uassist milestones") as unknown as string + " — milestone progress",
          code("uassist db rebuild") as unknown as string + " — rebuild SQLite from the JSON mirror",
          code("uassist health") as unknown as string + " — run validators",
        ),
      ),
    ],
  },

  {
    id: "project-setup",
    title: "Project and workspace setup",
    body: [
      section(
        "Project page",
        mdBlock("Click Project in the top nav to open the project meta page. It shows the project identity, workspace links, asset catalog summary, plan re-import controls, and a registry of other UAssist projects on this machine.",
        ),
      ),
      section(
        "Linking Unity and Blender",
        mdBlock("Enter the absolute path to the Unity project folder and/or the Blender source directory, then click Save. A badge shows whether the path is valid on disk. Until at least one workspace is linked, cards cannot anchor to real assets and the catalog will be empty.",
        ),
      ),
      section(
        "Asset catalog",
        mdBlock("Click Rescan to crawl the linked Unity and Blender directories. The scan discovers scripts, prefabs, scenes, .blend files, and other assets. Results are stored in the rebuildable SQLite cache and summarized by kind on the Project page.",
        ),
      ),
      section(
        "Re-importing plans from the UI",
        mdBlock("The Plan section on the Project page lets you preview or apply a plan import without using the terminal. Enter the plan file path, choose Preview diff to see what would change, or Import to apply it. Orphaned cards are reported, never silently deleted.",
        ),
      ),
      section(
        "Project registry",
        mdBlock("The Other projects on this machine section lists every UAssist project the current process knows about, with a live reachability dot and a link to open each board in a new tab.",
        ),
      ),
    ],
  },

  {
    id: "board",
    title: "Using the board",
    body: [
      section(
        "Default view",
        mdBlock("The default Plan view is a matrix:"),
        list(
          "Columns = Status (open → active → blocked → review → done)",
          "Rows = Category (Systems, Gameplay, AI, UI, Audio, Art, Narrative, Infra)",
          "Swimlanes = Milestone",
        ),
      ),
      section(
        "Top navigation",
        mdBlock("The header has three top-level pages: Board, Project, and Docs. Board is the kanban. Project is workspace setup, plan re-import, asset catalog, and the project registry. Docs is a workspace notebook where you can view, edit, and discuss Markdown documents.",
        ),
      ),
      section(
        "Switching views",
        mdBlock("Use the view dropdown in the header to switch presets such as Assignments, Risk radar, Sprint board, or Flat view. The server groups cards into cells; the client only renders them.",
        ),
      ),
      section(
        "Roadmap toggle",
        mdBlock("Click the Roadmap button to switch the main area to a milestone timeline, then click it again (now labeled Board) to return to the kanban. Clicking a roadmap row scrolls the board to that milestone's swimlane.",
        ),
      ),
      section(
        "Dragging cards",
        mdBlock("Drag a card to change its status, priority, or category, depending on which axis the columns are bound to. The move is optimistic: the card node moves immediately, then the server confirms or reverts it.",
        ),
      ),
      section(
        "Health lane",
        mdBlock("A fixed lane at the bottom shows validator output. It cannot be hidden. Items dedupe by fingerprint and auto-close when the underlying problem goes away.",
        ),
      ),
      section(
        "Search",
        mdBlock("Type in the search box to filter by title substring. The board refetches after a short debounce.",
        ),
      ),
    ],
  },

  {
    id: "cards",
    title: "Working with cards",
    body: [
      section(
        "Opening a card",
        mdBlock("Click any card to open the detail panel. It shows status, kind, category, priority, assignee, owner, milestone, acceptance criteria, related cards, anchors, source range, and the assistant chat thread.",
        ),
      ),
      section(
        "Status and acceptance",
        mdBlock("Change status from the detail panel or by dragging. Toggle acceptance checkboxes to mark criteria as met. A progress bar on the card reflects the acceptance ratio.",
        ),
      ),
      section(
        "Card signals",
        list(
          "Human-owned cards have a cyan left border.",
          "Agent-owned cards have an amber left border.",
          "AI-coordinated cards have an amber outline.",
          "Blockers are tinted red and show a blocked badge.",
          "Gate and deliverable cards use a dashed border.",
        ),
      ),
      section(
        "Anchors",
        mdBlock("A card can anchor to real objects: .blend files, Unity prefabs, scenes, GameObjects, scripts, data tables, or git commits. Open a card, scroll to the Anchor section, and click Attach anchor or Change anchor to search the asset catalog rather than typing a path.",
        ),
      ),
      section(
        "Anchor resolution badge",
        mdBlock("When a workspace is linked and scanned, the anchor shows a small badge: found means the path exists in the catalog; not in catalog means it has not been scanned or the file has moved.",
        ),
      ),
    ],
  },

  {
    id: "ai-chat",
    title: "AI chat on tasks",
    body: [
      section(
        "Per-card chat",
        mdBlock("Every card has its own chat thread. Open a card and scroll to the Assistant chat section. Type a message and press Enter (or Shift+Enter for a newline) to send.",
        ),
      ),
      section(
        "Document chat",
        mdBlock("The Docs page also has a chat panel for every workspace document. Use it to ask about design notes, architecture decisions, or the imported plan without leaving the doc.",
        ),
      ),
      section(
        "What the assistant knows",
        mdBlock("The assistant receives the project system prompt plus the card title, description, category, and kind. It does not automatically read files unless you paste paths or context into the message.",
        ),
      ),
      section(
        "Streaming replies",
        mdBlock("Replies stream token-by-token over the same WebSocket that keeps the board live. A streaming indicator shows while the model is generating. The completed message is saved to the thread and mirrored to .uassist/chat_threads.json.",
        ),
      ),
      section(
        "Model context",
        mdBlock("The project AI config limits how many messages are kept as context. Older messages are dropped from the tail, but the system prompt is always preserved. Adjust this in the AI settings panel.",
        ),
      ),
    ],
  },

  {
    id: "assets",
    title: "Asset catalog and anchors",
    body: [
      section(
        "What the catalog is",
        mdBlock("The asset catalog is UAssist's view of the real files in your Unity and Blender projects. It is built by scanning the linked workspace directories on the Project page, and it is what makes anchors reliable.",
        ),
      ),
      section(
        "Scanning",
        mdBlock("On the Project page, link a Unity project path and/or a Blender source path, then click Rescan. The scan skips ignored directories and classifies assets by kind (script, prefab, scene, blend, mesh, texture, and so on).",
        ),
      ),
      section(
        "Attaching anchors",
        mdBlock("Open any card, go to the Anchor section, and click Attach anchor or Change anchor. A search field queries the catalog; picking a result sets the anchor to a path that has just been confirmed to exist.",
        ),
      ),
      section(
        "Anchor kinds",
        list(
          "Script → a C# script file.",
          "Prefab → a Unity prefab.",
          "Scene → a Unity scene.",
          "Asset / blend → a Blender file or generic asset.",
          "Unity asset → any other Unity asset.",
          "Commit → a git SHA.",
        ),
      ),
    ],
  },

  {
    id: "workspace-docs",
    title: "Workspace documents",
    body: [
      section(
        "Docs page",
        mdBlock("Click Docs in the top nav to open the workspace notebook. It lists every Markdown document in .uassist/docs/, including the imported build plan. Select a document from the sidebar to view or edit it.",
        ),
      ),
      section(
        "Creating and editing",
        mdBlock("Click + New document in the sidebar, enter a file name, and UAssist creates a Markdown file in .uassist/docs/. Non-plan documents can be edited inline and saved; the imported plan is read-only from the UI — edit it on disk and re-import it from the Project page.",
        ),
      ),
      section(
        "Discussing a document",
        mdBlock("Every document has its own chat thread below the viewer. Use it to ask the assistant to explain, summarize, or propose changes based on the document content. Chat history is stored per document.",
        ),
      ),
      section(
        "Live updates",
        mdBlock("When a document is saved, a docChanged WebSocket event refreshes the sidebar for all connected clients, so team members (or multiple tabs) see the new title immediately.",
        ),
      ),
    ],
  },

  {
    id: "ai-config",
    title: "Configuring AI providers",
    body: [
      section(
        "Supported providers",
        mdBlock("UAssist uses the OpenAI-compatible /v1/chat/completions endpoint, so it works out of the box with:"),
        list(
          "Ollama (http://127.0.0.1:11434/v1)",
          "LM Studio (http://127.0.0.1:1234/v1)",
          "OpenAI and other OpenAI-compatible endpoints",
        ),
      ),
      section(
        "Opening the settings",
        mdBlock("Click the ⚙ AI button in the header, or open a card and choose a provider from the chat panel. The settings panel lets you add, remove, enable, and select providers.",
        ),
      ),
      section(
        "Provider fields",
        list(
          "Name — a display label such as Ollama or LM Studio.",
          "Kind — ollama, lmstudio, or openai.",
          "Base URL — the /v1 root. Include the trailing /v1.",
          "Model — the model id to send in chat requests.",
          "API key — optional for local providers, required for OpenAI.",
          "Enabled — disabled providers are skipped when choosing the active one.",
        ),
      ),
      section(
        "Global settings",
        mdBlock("The same panel controls the system prompt, max tokens, temperature, and the maximum number of context messages kept per thread.",
        ),
      ),
      section(
        "Security note",
        mdBlock("API keys are stored in project.json inside .uassist/. That directory should be git-ignored by default, but avoid sharing keys in team settings. UAssist never sends prompts or keys anywhere other than the configured base URL.",
        ),
      ),
    ],
  },

  {
    id: "plans",
    title: "Importing and updating plans",
    body: [
      section(
        "Plan format",
        mdBlock("UAssist expects Markdown with this shape:"),
        code("## Phase 1 — Survival and items\n\n*3–4 weeks.*\n\n- Data model: Item, Weapon, Ammo.\n- Cargo window UI.\n- Equipment slots.\n\n**Exit gate.** Build runs. No compile errors."),
      ),
      section(
        "What becomes what",
        list(
          "## Phase N — Title → milestone",
          "*duration* → milestone timebox",
          "### Subsystem heading → category hint and subsystem label",
          "- bullet → task card",
          "**Exit gate.** → gate card with acceptance criteria",
          "**Exit demo.** → deliverable card with acceptance criteria",
        ),
      ),
      section(
        "Re-import safely",
        mdBlock("Edit the plan, then run the import again. UAssist computes a structural diff:"),
        list(
          "New cards are added.",
          "Renamed cards are matched by stable sourceKey and fuzzy title similarity.",
          "Orphaned cards (in the store but no longer in the plan) are reported, never silently deleted.",
        ),
        mdBlock("Use --dry-run to preview the diff without writing anything:"),
        code("uassist plan import plan.md --dry-run"),
      ),
    ],
  },

  {
    id: "agents",
    title: "Dispatching agents",
    body: [
      section(
        "Agent adapters",
        mdBlock("UAssist can dispatch a card to a local CLI agent such as opencode or Claude Code. Each job runs in a fresh git worktree under .uassist/worktrees/ so the agent never touches your working tree directly.",
        ),
      ),
      section(
        "Dispatch from the card detail panel",
        list(
          "Open a card and scroll to Agent jobs.",
          "Select an adapter from the dropdown.",
          "Optionally override the objective — leave it blank to use the card's title and description.",
          "Set a max cost in USD and a max duration in minutes.",
          "Click Dispatch.",
          "Watch live output stream in the job row.",
          "When the job returns, click Review diff to see the changes, then Accept or Reject.",
        ),
      ),
      section(
        "Accept and reject",
        mdBlock("Accepting applies the diff as a reviewed commit to the main working tree and removes the worktree. Rejecting leaves the worktree for inspection and marks the job rejected. Both actions update the card status and clear the worktree on the next cleanup.",
        ),
      ),
      section(
        "Cost ledger",
        mdBlock("Every job writes to a cost ledger. Daily and total caps are hard stops: dispatch is refused if a cap would be exceeded, and a runaway job is killed mid-flight if it crosses a cap.",
        ),
      ),
    ],
  },

  {
    id: "validators",
    title: "Validators and health lane",
    body: [
      section(
        "Self-writing backlog",
        mdBlock("Validators inspect project state and emit health items. Each item carries a stable fingerprint, which lets UAssist dedupe and auto-close items when the problem disappears.",
        ),
      ),
      section(
        "MVP validators",
        list(
          "compile_errors — Unity or C# compile fails.",
          "missing_licence — imported asset has no licence entry.",
          "missing_reference — prefab/script field is unassigned.",
          "navmesh_bake — scene has NavMesh agents but no baked data.",
          "scene_lint — duplicate IDs, unreachable interactables.",
          "asset_stage — asset stuck in progress without an active card.",
          "budget — scene exceeds tri/draw-call target.",
          "save_smoke — save/load round-trip fails.",
          "stale_branch — worktree base drift exceeds threshold.",
          "plan_gate — milestone gate condition not met by target date.",
        ),
      ),
      section(
        "Running validators",
        mdBlock("Click the health item itself for details, or run all validators from the CLI:"),
        code("uassist health"),
        mdBlock("In CI, use --fail-on blocker to block a merge on blocker-severity items:"),
        code("uassist health --fail-on blocker"),
      ),
    ],
  },

  {
    id: "roadmap",
    title: "Roadmap view",
    body: [
      section(
        "Milestone timeline",
        mdBlock("The roadmap shows each milestone as a horizontal bar with phase number, timebox, and completion percentage. Colors indicate status: planned grey, active cyan, done green, at-risk amber, slipped red.",
        ),
      ),
      section(
        "Interacting",
        mdBlock("Click a milestone bar to zoom into its slice of the kanban. Completion is derived from the status of its cards.",
        ),
      ),
    ],
  },

  {
    id: "keyboard",
    title: "Keyboard shortcuts",
    body: [
      section(
        "Global",
        list(
          "? — open this help panel",
          "Esc — close any open panel",
        ),
      ),
      section(
        "Board",
        list(
          "Roadmap button — toggle between kanban and milestone timeline",
        ),
      ),
      section(
        "Card detail",
        list(
          "Esc — close detail panel",
          "Click a related card link — open that card",
          "Click Attach/Change anchor — search the asset catalog",
        ),
      ),
      section(
        "Chat (cards and docs)",
        list(
          "Enter — send message",
          "Shift+Enter — newline in chat input",
        ),
      ),
    ],
  },
];

export class HelpPanel {
  private node: HTMLElement | undefined;
  private current: HelpPageId = "overview";

  open(page: HelpPageId = "overview"): void {
    this.current = page;
    this.render();
  }

  close(): void {
    this.node?.remove();
    this.node = undefined;
  }

  private render(): void {
    const panel = el("aside", "help-panel");

    const header = el("div", "panel-head");
    header.append(el("h1", undefined, "UAssist Help"));
    const close = el("button", "close", "✕");
    close.title = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    header.append(close);
    panel.append(header);

    const layout = el("div", "help-layout");

    // Sidebar
    const sidebar = el("nav", "help-sidebar");
    const ul = el("ul");
    for (const page of PAGES) {
      const li = el("li");
      const a = el("a", page.id === this.current ? "active" : undefined, page.title);
      a.href = `#${page.id}`;
      a.dataset["page"] = page.id;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.navigate(page.id);
      });
      li.append(a);
      ul.append(li);
    }
    sidebar.append(ul);

    // Content
    const content = el("article", "help-content");
    const page = PAGES.find((p) => p.id === this.current) ?? PAGES[0]!;
    content.append(el("h2", undefined, page.title));
    for (const block of page.body) {
      content.append(typeof block === "string" ? el("p", undefined, block) : block);
    }

    // Wire all in-content help links
    content.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
      if (target && target.dataset["page"]) {
        e.preventDefault();
        this.navigate(target.dataset["page"] as HelpPageId);
      }
    });

    layout.append(sidebar, content);
    panel.append(layout);

    this.close();
    this.node = panel;
    document.body.append(panel);
  }

  private navigate(id: HelpPageId): void {
    this.current = id;
    this.render();
  }
}
