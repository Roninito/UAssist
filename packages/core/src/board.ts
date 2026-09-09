/**
 * Board view engine: axis assignments compiled to SQL, cells returned already
 * bucketed.
 *
 * The client renders; it does not group. Keeping the pivot here means the
 * grouping logic is in one place, expressed against the database, and testable
 * without a browser.
 *
 * See design/plan-to-kanban-tool-spec.md Part III.
 */

import type { Store } from "./store.ts";
import type { CardId, MilestoneId } from "./ids.ts";
import type {
  Assignee,
  CardKind,
  HealthItem,
  Priority,
  Status,
} from "./types.ts";
import { CATEGORIES, PRIORITIES, STATUSES } from "./types.ts";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export const AXIS_KINDS = [
  "status",
  "category",
  "milestone",
  "priority",
  "subsystem",
  "assignee",
  "kind",
  "none",
] as const;
export type AxisKind = (typeof AXIS_KINDS)[number];

export interface BoardView {
  id: string;
  name: string;
  columns: AxisKind;
  rows: AxisKind;
  swimlanes: AxisKind;
  filters?: BoardFilters;
}

export interface BoardFilters {
  status?: Status[];
  category?: string[];
  milestoneId?: MilestoneId[];
  priority?: Priority[];
  /** Case-insensitive substring match on the title. */
  search?: string;
}

export interface AxisValue {
  key: string;
  label: string;
  /** Cards in this slice of the axis, after filters. */
  count: number;
}

/** Enough to draw the rectangle. Not the whole record. */
export interface CardSummary {
  id: CardId;
  title: string;
  status: Status;
  category: string;
  subsystem?: string;
  kind: CardKind;
  priority: Priority;
  milestoneId?: MilestoneId;
  assignee: Assignee;
  acceptanceTotal: number;
  acceptanceMet: number;
  blockedByCount: number;
  jobCount: number;
}

export interface BoardCell {
  swimlane: string;
  row: string;
  column: string;
  cards: CardSummary[];
}

export interface BoardResponse {
  view: BoardView;
  axes: {
    columns: AxisValue[];
    rows: AxisValue[];
    swimlanes: AxisValue[];
  };
  cells: BoardCell[];
  /** The pinned lane. Always present, never hideable. */
  health: HealthItem[];
  total: number;
  seq: number;
}

export const PRESET_VIEWS: Record<string, BoardView> = {
  plan: {
    id: "plan",
    name: "Plan",
    columns: "status",
    rows: "category",
    swimlanes: "milestone",
  },
  assignments: {
    id: "assignments",
    name: "Assignments",
    columns: "status",
    rows: "assignee",
    swimlanes: "milestone",
  },
  sprint: {
    id: "sprint",
    name: "Sprint board",
    columns: "status",
    rows: "subsystem",
    swimlanes: "priority",
  },
  risk: {
    id: "risk",
    name: "Risk radar",
    columns: "priority",
    rows: "category",
    swimlanes: "none",
  },
  flat: {
    id: "flat",
    name: "Flat",
    columns: "status",
    rows: "none",
    swimlanes: "none",
  },
};

// ---------------------------------------------------------------------------
// Axis to SQL
// ---------------------------------------------------------------------------

const NONE_KEY = "_";

/**
 * The SQL expression that produces an axis key for a card row.
 *
 * `c` is the cards table. Null-ish keys are folded to a sentinel so a card is
 * never silently dropped from the board for lacking a subsystem or a lane.
 */
function axisExpr(kind: AxisKind): string {
  switch (kind) {
    case "status":
      return "c.status";
    case "category":
      return "COALESCE(NULLIF(c.category, ''), 'Unknown')";
    case "milestone":
      return "COALESCE(c.milestone_id, '_unassigned')";
    case "priority":
      return "c.priority";
    case "subsystem":
      return "COALESCE(NULLIF(c.subsystem, ''), '_none')";
    case "assignee":
      return "COALESCE(json_extract(c.assignee, '$.id'), json_extract(c.assignee, '$.kind'), 'unassigned')";
    case "kind":
      return "c.kind";
    case "none":
      return "'" + NONE_KEY + "'";
  }
}

interface AxisDomain {
  values: AxisValue[];
  /** Whether keys not in `values` should be appended as they appear. */
  open: boolean;
}

/**
 * The ordered set of buckets an axis can produce.
 *
 * Closed axes (status, priority) come from the vocabulary, so an empty column
 * still renders: a board with nothing in `review` should show an empty
 * `review` column, not omit it. Open axes are discovered from the data.
 */
function axisDomain(store: Store, kind: AxisKind): AxisDomain {
  const zero = (key: string, label: string): AxisValue => ({
    key,
    label,
    count: 0,
  });
  switch (kind) {
    case "status":
      return { values: STATUSES.map((s) => zero(s, s)), open: false };
    case "priority":
      return { values: PRIORITIES.map((p) => zero(p, p)), open: false };
    case "category":
      return { values: CATEGORIES.map((c) => zero(c, c)), open: false };
    case "kind":
      return {
        values: ["task", "deliverable", "gate", "decision", "risk"].map((k) =>
          zero(k, k),
        ),
        open: false,
      };
    case "milestone": {
      const values = store.listMilestones().map((m) =>
        zero(
          m.id,
          m.phaseNumber !== undefined
            ? `Phase ${m.phaseNumber} — ${m.title}`
            : m.title,
        ),
      );
      values.push(zero("_unassigned", "Unassigned"));
      return { values, open: false };
    }
    case "none":
      return { values: [zero(NONE_KEY, "")], open: false };
    default:
      // subsystem, assignee: discovered from the data.
      return { values: [], open: true };
  }
}

function labelFor(kind: AxisKind, key: string): string {
  if (kind === "subsystem" && key === "_none") return "No subsystem";
  if (kind === "assignee" && key === "unassigned") return "Unassigned";
  return key;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  title: string;
  status: string;
  category: string;
  subsystem: string | null;
  kind: string;
  priority: string;
  milestone_id: string | null;
  assignee: string;
  acceptance: string;
  col_key: string;
  row_key: string;
  lane_key: string;
  blocked_by_count: number;
  job_count: number;
}

function buildFilters(filters: BoardFilters | undefined): {
  clause: string;
  args: (string | number)[];
} {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!filters) return { clause: "", args };

  const inClause = (column: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => "?").join(",")})`);
    args.push(...values);
  };

  inClause("c.status", filters.status);
  inClause("c.category", filters.category);
  inClause("c.milestone_id", filters.milestoneId);
  inClause("c.priority", filters.priority);

  if (filters.search && filters.search.trim().length > 0) {
    where.push("LOWER(c.title) LIKE ?");
    args.push(`%${filters.search.trim().toLowerCase()}%`);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export function buildBoard(store: Store, view: BoardView): BoardResponse {
  const { clause, args } = buildFilters(view.filters);

  const rows = store.db
    .query<BoardRow, (string | number)[]>(
      `SELECT
         c.id, c.title, c.status, c.category, c.subsystem, c.kind, c.priority,
         c.milestone_id, c.assignee, c.acceptance,
         ${axisExpr(view.columns)}   AS col_key,
         ${axisExpr(view.rows)}      AS row_key,
         ${axisExpr(view.swimlanes)} AS lane_key,
         (SELECT COUNT(*) FROM card_links l
            WHERE l.from_id = c.id AND l.rel = 'blocked_by') AS blocked_by_count,
         (SELECT COUNT(*) FROM jobs j WHERE j.card_id = c.id) AS job_count
       FROM cards c
       LEFT JOIN milestones m ON m.id = c.milestone_id
       ${clause}
       ORDER BY m.phase_number IS NULL, m.phase_number, c.created_at`,
    )
    .all(...args);

  const columns = axisDomain(store, view.columns);
  const rowAxis = axisDomain(store, view.rows);
  const lanes = axisDomain(store, view.swimlanes);

  const index = (domain: AxisDomain, kind: AxisKind) => {
    const map = new Map(domain.values.map((v, i) => [v.key, i]));
    return (key: string): AxisValue => {
      let i = map.get(key);
      if (i === undefined) {
        // Open axis, or a value the vocabulary does not know about. Append it
        // rather than dropping the card.
        i = domain.values.length;
        domain.values.push({ key, label: labelFor(kind, key), count: 0 });
        map.set(key, i);
      }
      return domain.values[i]!;
    };
  };

  const col = index(columns, view.columns);
  const row = index(rowAxis, view.rows);
  const lane = index(lanes, view.swimlanes);

  const cells = new Map<string, BoardCell>();

  for (const r of rows) {
    const acceptance = JSON.parse(r.acceptance) as { met: boolean }[];
    const summary: CardSummary = {
      id: r.id as CardId,
      title: r.title,
      status: r.status as Status,
      category: r.category,
      subsystem: r.subsystem ?? undefined,
      kind: r.kind as CardKind,
      priority: r.priority as Priority,
      milestoneId: (r.milestone_id ?? undefined) as MilestoneId | undefined,
      assignee: JSON.parse(r.assignee) as Assignee,
      acceptanceTotal: acceptance.length,
      acceptanceMet: acceptance.filter((a) => a.met).length,
      blockedByCount: r.blocked_by_count,
      jobCount: r.job_count,
    };

    col(r.col_key).count++;
    row(r.row_key).count++;
    lane(r.lane_key).count++;

    const key = `${r.lane_key} ${r.row_key} ${r.col_key}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        swimlane: r.lane_key,
        row: r.row_key,
        column: r.col_key,
        cards: [],
      };
      cells.set(key, cell);
    }
    cell.cards.push(summary);
  }

  // Drop empty buckets on axes discovered from data, and on milestone lanes
  // that hold nothing: an empty "Unassigned" lane is noise. Vocabulary axes
  // keep their empty buckets so the board shape stays stable as cards move.
  const prune = (domain: AxisDomain, kind: AxisKind) =>
    kind === "milestone" || domain.open
      ? domain.values.filter((v) => v.count > 0)
      : domain.values;

  return {
    view,
    axes: {
      columns: prune(columns, view.columns),
      rows: prune(rowAxis, view.rows),
      swimlanes: prune(lanes, view.swimlanes),
    },
    cells: [...cells.values()],
    health: store.listHealthItems(),
    total: rows.length,
    seq: store.lastSeq,
  };
}

export function resolveView(
  name: string | undefined,
  filters?: BoardFilters,
): BoardView {
  const preset = PRESET_VIEWS[name ?? "plan"] ?? PRESET_VIEWS["plan"]!;
  return filters ? { ...preset, filters } : preset;
}

/** Card ids in a cell, used by tests and by the client's optimistic move. */
export function cardIdsAt(
  board: BoardResponse,
  lane: string,
  row: string,
  column: string,
): CardId[] {
  const cell = board.cells.find(
    (c) => c.swimlane === lane && c.row === row && c.column === column,
  );
  return cell ? cell.cards.map((c) => c.id) : [];
}
