/**
 * Markdown build-plan parser.
 *
 * A hand-written line scanner, not a Markdown AST. The grammar we care about is
 * a dozen line shapes, and a scanner gives us exact source line numbers for
 * free — which is what SourceRange needs to make re-ingest work.
 *
 * See design/uassist-spec.md Part V.
 *
 * ---------------------------------------------------------------------------
 * Ported from the v0.1 Rust parser (crates/uassist_core/src/plan.rs) with four
 * bugs fixed. The Rust version, run against the colony plan, produced 10
 * milestones and 17 cards; 3 of those milestones and at least 1 card were
 * wrong, and 12 exit conditions were silently dropped:
 *
 *   1. Every `## ` heading became a milestone, so "What Unity provides",
 *      "What we build in C#" and "What the assistant builds" — prose sections
 *      under Part V — became phases. Fixed: only `## Phase N` is a milestone.
 *
 *   2. With no milestone gating, bullets anywhere in the document became
 *      cards, including the Cut list. "Open world / streaming world (use
 *      discrete sectors)" — an explicit non-goal — was imported as a task.
 *      Fixed: bullets outside a phase section are ignored.
 *
 *   3. Exit conditions were matched as `*Exit gate.*` (italic) but the
 *      document writes `**Exit gate.**` (bold), so all 12 gate/demo lines were
 *      missed, no gate or deliverable cards were created, and every card had
 *      an empty acceptance list. Fixed: both forms match.
 *
 *   4. A `looks_like_task` heuristic (imperative-verb allowlist, or a colon
 *      and under 80 chars) dropped 24 of 42 real phase bullets — "Cargo window
 *      UI...", "Health, medkits, food." and so on. Fixed: the heuristic is
 *      gone. Inside a phase section a bullet *is* a task; that is what the
 *      document means by a bullet. Only structural non-tasks (table rows,
 *      rules) are skipped.
 * ---------------------------------------------------------------------------
 */

import { newId } from "../ids.ts";
import type {
  AcceptanceCriterion,
  Card,
  Category,
  Estimate,
  Milestone,
} from "../types.ts";
import { newCardDefaults } from "../types.ts";
import { cardSourceKey, milestoneSourceKey } from "./sourceKey.ts";

export interface ParsedPlan {
  milestones: Milestone[];
  cards: Card[];
  /** The plan text, retained verbatim so a later import can diff against it. */
  source: string;
  sourceFile: string;
  warnings: string[];
}

const PHASE_HEADING = /^##\s+Phase\s+(\d+)\s*[—–\-:]\s*(.+?)\s*$/i;
/** `*3–4 weeks.*`, `*2 weeks.*`, `*Ongoing, 3–6 months.*` — italic meta line. */
const META_LINE = /^\*(.+)\*$/;
const DURATION = /([\d.]+)\s*(?:[—–-]\s*([\d.]+))?\s*(weeks?|months?)/i;
/** Bold or italic, `Exit gate.` or `Exit gate:`. */
const EXIT_LINE = /^(?:\*\*|\*)Exit\s+(gate|demo)[.:]?(?:\*\*|\*)\s*(.*)$/i;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;
const PART_HEADING = /^#\s+/;
const BULLET = /^[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;

/**
 * Category hints, scored rather than first-match.
 *
 * First-match gets this wrong on the common case: "Data model: `Item`,
 * `Weapon`, `Ammo`…" hits a Gameplay keyword (weapon) before a Systems one,
 * and lands in Gameplay when it is plainly a data-model task. Counting hits
 * per category and taking the highest gets it right, because that bullet
 * carries two Systems words and one Gameplay word.
 */
const CATEGORY_HINTS: [Category, RegExp[]][] = [
  ["UI", [/\bui\b/i, /\bhud\b/i, /\bmenu\b/i, /\bwindow\b/i, /\binterface\b/i, /\bscreen\b/i]],
  ["Audio", [/\baudio\b/i, /\bsound\b/i, /\bmusic\b/i, /\bsfx\b/i, /\bvo\b/i, /\bvoice[- ]?over\b/i, /\bambient\b/i]],
  ["AI", [/\bai\b/i, /\bbehaviou?r\b/i, /\bperception\b/i, /\bnavmesh\b/i, /\bpatrol\b/i, /\bguard\b/i, /\benemy\b/i, /\bturret\b/i]],
  ["Art", [/\bart\b/i, /\btexture\b/i, /\bmaterial\b/i, /\blighting\b/i, /\bmesh\b/i, /\bgreybox\b/i, /\bprop\b/i, /\bdressed?\b/i, /\bpost[- ]processing\b/i]],
  ["Narrative", [/\bnarrative\b/i, /\bstory\b/i, /\bdialogue\b/i, /\bnpc\b/i, /\blogs?\b/i, /\bcollectible\b/i]],
  ["Infra", [/\binfra\b/i, /\bbuild\b/i, /\bpipeline\b/i, /\bci\b/i, /\btooling\b/i, /\bsteamworks\b/i, /\boptimi[sz]ation\b/i, /\bcompile\b/i]],
  ["Gameplay", [/\bgameplay\b/i, /\bcombat\b/i, /\bmovement\b/i, /\bplayer\b/i, /\bweapons?\b/i, /\bmotor\b/i, /\bcamera\b/i, /\bjump\b/i, /\bstealth\b/i, /\bhacking\b/i, /\bencounter\b/i, /\binteract/i]],
  ["Systems", [/\bsystems?\b/i, /\bdata\b/i, /\bsave\b/i, /\binventory\b/i, /\bitems?\b/i, /\bmodel\b/i, /\bserial/i, /\bstate\b/i, /\bslots?\b/i, /\bzones?\b/i, /\bhealth\b/i]],
];

/**
 * Score `text` against every category and return the strongest signal.
 * Ties break toward the earlier entry, which orders specific surfaces (UI,
 * Audio) ahead of the catch-alls (Gameplay, Systems).
 */
function categoryFor(text: string): Category {
  let best: Category = "Unknown";
  let bestScore = 0;
  for (const [category, patterns] of CATEGORY_HINTS) {
    let score = 0;
    for (const re of patterns) if (re.test(text)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return best;
}

/**
 * Split an exit condition into one criterion per sentence.
 *
 * "Build runs. No compile errors. Play mode smoke test passes." is three
 * things to verify, not one. Splitting them makes the acceptance progress bar
 * mean something.
 */
export function splitAcceptance(text: string): AcceptanceCriterion[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z“"`(])/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0)
    .map((s) => ({ text: s, met: false }));
}

interface MetaLine {
  timebox?: Estimate;
  /** "*Ongoing, 3–6 months.*" — a duration, but not a commitment. */
  ongoing: boolean;
}

/**
 * Parse an italic meta line under a phase heading.
 *
 * Returns a result even when no duration is found, so the caller knows the
 * line was structural and should not fall through to become the milestone
 * description — which is how "*Ongoing, 3–6 months.*" ended up as Phase 6's
 * description on the first pass.
 */
function parseMetaLine(line: string): MetaLine | undefined {
  const meta = META_LINE.exec(line);
  if (!meta) return undefined;
  const inner = meta[1]!;
  const ongoing = /\bongoing\b/i.test(inner);

  const d = DURATION.exec(inner);
  if (!d) return ongoing ? { ongoing } : undefined;

  const scale = /^month/i.test(d[3]!) ? 4.345 : 1; // weeks per month
  const min = Number(d[1]) * scale;
  const max = (d[2] === undefined ? Number(d[1]) : Number(d[2])) * scale;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ongoing };

  const round = (n: number) => Math.round(n * 10) / 10;
  return { timebox: { minWeeks: round(min), maxWeeks: round(max) }, ongoing };
}

/**
 * A bullet inside a phase section is a task. The only things skipped are lines
 * that are not prose at all.
 */
function isStructuralNonTask(text: string): boolean {
  if (text.length === 0) return true;
  if (text.startsWith("|")) return true; // table row
  if (/^-{3,}$/.test(text)) return true; // horizontal rule
  return false;
}

export function parsePlan(input: string, sourceFile: string): ParsedPlan {
  const lines = input.split("\n");
  const milestones: Milestone[] = [];
  const cards: Card[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  let current: Milestone | undefined;
  let subsystem: string | undefined;
  let category: Category = "Unknown";

  const pushMilestone = () => {
    if (current) milestones.push(current);
    current = undefined;
    subsystem = undefined;
    category = "Unknown";
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    const lineNo = i + 1;

    if (line.length === 0) continue;

    // A `# Part …` heading ends the current phase. This is what keeps the Cut
    // list and the Division-of-labour prose from becoming cards.
    if (PART_HEADING.test(line)) {
      pushMilestone();
      continue;
    }

    const phase = PHASE_HEADING.exec(line);
    if (phase) {
      pushMilestone();
      const phaseNumber = Number(phase[1]);
      const title = phase[2]!;
      current = {
        id: newId("milestone"),
        title,
        phaseNumber,
        description: "",
        status: "planned",
        source: { file: sourceFile, startLine: lineNo, endLine: lineNo },
        sourceKey: milestoneSourceKey({ phaseNumber, title }),
        createdAt: now,
        updatedAt: now,
      };
      continue;
    }

    // Any other `## ` heading is prose, not a phase. Explicitly not a
    // milestone — this is fix (1).
    if (line.startsWith("## ")) {
      pushMilestone();
      continue;
    }

    if (!current) continue;

    const meta = parseMetaLine(line);
    if (meta) {
      if (meta.timebox && !meta.ongoing) current.timebox = meta.timebox;
      current.source!.endLine = lineNo;
      continue;
    }

    const sub = SUBSECTION_HEADING.exec(line);
    if (sub) {
      subsystem = sub[1];
      category = categoryFor(sub[1]!);
      continue;
    }

    const exit = EXIT_LINE.exec(line);
    if (exit) {
      const which = exit[1]!.toLowerCase();
      const text = exit[2]!.replace(/^[\s—–-]+/, "").trim();
      if (text.length === 0) {
        warnings.push(`${sourceFile}:${lineNo}: empty exit ${which}`);
        continue;
      }
      const acceptance = splitAcceptance(text);
      if (which === "gate") {
        current.gateCondition = text;
        cards.push({
          ...newCardDefaults(now),
          id: newId("card"),
          title: `Gate: ${current.title}`,
          description: text,
          milestoneId: current.id,
          category: "Infra",
          kind: "gate",
          priority: "high",
          acceptance,
          source: { file: sourceFile, startLine: lineNo, endLine: lineNo },
          sourceKey: cardSourceKey({
            milestone: current.title,
            title: current.title,
            kind: "gate",
          }),
        });
      } else {
        current.demoCondition = text;
        cards.push({
          ...newCardDefaults(now),
          id: newId("card"),
          title: `Demo: ${current.title}`,
          description: text,
          milestoneId: current.id,
          category: "Gameplay",
          kind: "deliverable",
          priority: "high",
          acceptance,
          source: { file: sourceFile, startLine: lineNo, endLine: lineNo },
          sourceKey: cardSourceKey({
            milestone: current.title,
            title: current.title,
            kind: "demo",
          }),
        });
      }
      current.source!.endLine = lineNo;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const text = bullet[1]!.trim();
      if (isStructuralNonTask(text)) continue;
      cards.push({
        ...newCardDefaults(now),
        id: newId("card"),
        title: text,
        milestoneId: current.id,
        // A `###` heading is the strongest signal when the plan has them. The
        // colony plan does not, so fall back to the bullet's own wording —
        // otherwise every card lands in Unknown and the board's category rows
        // carry no information.
        category: category !== "Unknown" ? category : categoryFor(text),
        subsystem,
        source: { file: sourceFile, startLine: lineNo, endLine: lineNo },
        sourceKey: cardSourceKey({
          milestone: current.title,
          subsystem,
          title: text,
        }),
      });
      current.source!.endLine = lineNo;
      continue;
    }

    // The first line of prose under a phase heading becomes the description.
    // Structural lines (rules, tables, leftover emphasis) are not prose.
    if (
      current.description.length === 0 &&
      !line.startsWith("#") &&
      !isStructuralNonTask(line) &&
      !line.startsWith("*") &&
      !line.startsWith(">")
    ) {
      current.description = line;
      current.source!.endLine = lineNo;
    }
  }

  pushMilestone();

  // Duplicate source keys mean two cards would collide on re-import.
  const seen = new Map<string, string>();
  for (const card of cards) {
    if (!card.sourceKey) continue;
    const prior = seen.get(card.sourceKey);
    if (prior) {
      warnings.push(
        `duplicate source key: "${card.title}" collides with "${prior}"`,
      );
    } else {
      seen.set(card.sourceKey, card.title);
    }
  }

  return { milestones, cards, source: input, sourceFile, warnings };
}
