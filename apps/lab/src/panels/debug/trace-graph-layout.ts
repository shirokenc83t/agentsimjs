import type { TraceRecord } from "@agentsim/trace";
import { summary } from "./log-rows.ts";
import { flagRole, isFailure, markOf } from "./marks.ts";
import type { TraceTree, TreeNode } from "./trace-tree.ts";

// The layout of the trace graph: deterministic and never force-directed, so a node is where it was the last time. Parents and causes are on the left (parent edges solid, cause edges
// dashed), the record in the middle, its effects on the right (dashed). What the record did, its children, happen in time order and are drawn as one vertical time line, a lane: a rail with
// a dot a step, the time on the left and the gap to the step before where it matters, ordered by time and sequence number and ending at the `end` record. Runs of the same kind · op
// fold into one row (the order is kept), and a long middle collapses into a row that opens a page at a time. Pure: the panel only draws it.

export const NODE_W = 270;
export const NODE_H = 44;
export const GAP_X = 110;
export const GAP_Y = 14;
/** The lane: the width of the gutter that carries the time and the rail, the room between steps, the indent of a level, and how tall the lane is before it scrolls. */
export const RAIL_W = 84;
export const LANE_GAP_Y = 16;
export const LANE_INDENT = 16;
export const LANE_VIEW_MAX = 520;
/** A row folded from this many records of the same kind · op in a row. */
export const RUN_MIN = 3;
/** A lane of more rows than this shows the first `LANE_HEAD` and the last `LANE_TAIL` and one row for the middle, which opens `LANE_PAGE` rows at a time. */
export const LANE_ROWS = 24;
export const LANE_HEAD = 8;
export const LANE_TAIL = 3;
export const LANE_PAGE = 20;
/** The gap to the step before is said from this long. */
export const GAP_SHOWN_S = 0.1;
/** A column of effects of more records than this shows the first `HEAD` of them and a group node for the rest. */
export const COLUMN_LIMIT = 12;
export const HEAD = 6;
/** What a click on a group node shows more of. */
export const PAGE = 10;

export type Side = "parents" | "causes" | "children" | "effects";

export interface GraphOptions {
  readonly depth: 1 | 2 | 3;
  readonly sides: Readonly<Record<Side, boolean>>;
  /** Fold runs of the same kind · op in the lane into one row. */
  readonly foldRuns: boolean;
  /** How many records (a column of effects) or rows (the lane's middle) have been expanded, by the key of the group; a run is open when it has an entry. */
  readonly expanded: ReadonlyMap<string, number>;
}

export interface GraphNode {
  readonly key: string;
  /** Column: negative on the left of the record, 0 for it, 1 for the lane (or the first column of effects when there is none), then the effects. */
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly record?: TraceRecord;
  /** A row that stands for records not shown one by one: its label, how many it holds still hidden, the key a click expands, and which kind it is. */
  readonly group?: { readonly label: string; readonly hidden: number; readonly key: string; readonly kind: "more" | "run" | "gap"; readonly detail?: string };
  readonly center: boolean;
  readonly failed: boolean;
  /** A step of the lane: its level under the record (1 for a child), its time, and the gap to the step before when it matters. */
  readonly lane?: { readonly level: number; readonly time: string; readonly gap?: string; readonly ok: boolean };
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** `parent`: solid; `cause`: dashed. */
  readonly relation: "parent" | "cause";
  readonly failed: boolean;
}

export interface GraphLane {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** What the lane shows, and the height of what it holds (it scrolls when that is more). */
  readonly viewH: number;
  readonly contentH: number;
  /** The records under the record, however many are folded. */
  readonly total: number;
}

export interface GraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly lane?: GraphLane;
  readonly width: number;
  readonly height: number;
}

/** `phase · transitions`: what a record is, as the Log's summary column says it, for folding and for the label of a run. */
export const kindOp = (r: TraceRecord): string => summary(r);

/** The outcome glyph of a record, when it has one: ▶ a start, ✓ a success, ✕ a failure, ▲ a refusal or a preemption. */
export function outcomeGlyph(r: TraceRecord): string | undefined {
  if (r.kind !== "action") return undefined;
  const m = markOf(r);
  if (isFailure(m)) return "✕";
  if (m.op === "rejected" || m.status === "preempted") return "▲";
  if (m.op === "end" && m.status === "succeeded") return "✓";
  if (m.op === "start") return "▶";
  return undefined;
}

const byTime = (a: TraceRecord, b: TraceRecord): number => a.simTime - b.simTime || a.seq - b.seq;
const failedRecord = (r: TraceRecord): boolean => flagRole(markOf(r)) === "alarm";
const succeeded = (r: TraceRecord): boolean => r.kind === "action" && markOf(r).op === "end" && markOf(r).status === "succeeded";
const seconds = (s: number): string => `${s.toFixed(2)} s`;

/** A short description of what is in a list of records: `phase ×5, predrive ×1` (most first). */
function summaryOf(records: readonly TraceRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(kindOpShort(r), (counts.get(kindOpShort(r)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ×${n}`).join(", ");
}
/** The op of a record when it has one (`start`, `phase`), else its kind. */
export const kindOpShort = (r: TraceRecord): string => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown }) : {};
  return typeof p.op === "string" ? p.op : r.kind;
};

interface Pending {
  readonly col: number;
  readonly record?: TraceRecord;
  readonly group?: GraphNode["group"];
  readonly key: string;
  /** The nodes this one hangs from, and how. */
  readonly via: readonly { readonly from: string; readonly relation: "parent" | "cause" }[];
}

/** A row of the lane before it is placed: a step, a run of steps folded, or the collapsed middle. */
interface Row {
  readonly key: string;
  readonly kind: "step" | "run" | "gap";
  readonly level: number;
  readonly records: readonly TraceRecord[];
  readonly h: number;
}

/** The records under the record, to the depth asked, in time order, each with its level. */
function laneItems(children: readonly TreeNode[], depth: number): { record: TraceRecord; level: number }[] {
  const out: { record: TraceRecord; level: number }[] = [];
  const walk = (nodes: readonly TreeNode[], level: number): void => {
    if (level > depth) return;
    for (const n of nodes) {
      out.push({ record: n.record, level });
      walk(n.below, level + 1);
    }
  };
  walk(children, 1);
  return out.sort((a, b) => byTime(a.record, b.record));
}

/** The rows of the lane: runs of the same kind · op folded (unless opened), then a long middle collapsed into one row that opens a page at a time. */
function laneRows(items: readonly { record: TraceRecord; level: number }[], o: GraphOptions): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i] as { record: TraceRecord; level: number };
    let j = i + 1;
    if (o.foldRuns && !failedRecord(first.record) && !succeeded(first.record)) while (j < items.length && (items[j] as { level: number }).level === first.level && kindOp((items[j] as { record: TraceRecord }).record) === kindOp(first.record) && !failedRecord((items[j] as { record: TraceRecord }).record)) j++;
    const run = items.slice(i, j);
    if (run.length >= RUN_MIN && !o.expanded.has(`run:${first.record.seq}`)) rows.push({ key: `run:${first.record.seq}`, kind: "run", level: first.level, records: run.map((x) => x.record), h: NODE_H });
    else for (const x of run) rows.push({ key: `r${x.record.seq}`, kind: "step", level: x.level, records: [x.record], h: NODE_H });
    i = j;
  }
  if (rows.length <= LANE_ROWS) return rows;
  const opened = Math.min(o.expanded.get("lane:gap") ?? 0, rows.length - LANE_HEAD - LANE_TAIL);
  const head = rows.slice(0, LANE_HEAD + opened);
  const tail = rows.slice(rows.length - LANE_TAIL);
  const middle = rows.slice(LANE_HEAD + opened, rows.length - LANE_TAIL);
  if (middle.length === 0) return rows;
  return [...head, { key: "lane:gap", kind: "gap", level: 1, records: middle.flatMap((r) => r.records), h: 30 }, ...tail];
}

/**
 * The layout of a tree. A record that is both an ancestor and a cause is one node with two edges. Nothing here depends on the order the tree came in: the lane and the columns are
 * ordered by time and sequence number.
 */
export function layoutTraceGraph(tree: TraceTree, o: GraphOptions): GraphLayout {
  const centerKey = `r${tree.selected.record.seq}`;
  const pending = new Map<string, Pending>();
  const add = (p: Pending): void => {
    const have = pending.get(p.key);
    if (have) pending.set(p.key, { ...have, via: [...have.via, ...p.via.filter((v) => !have.via.some((h) => h.from === v.from && h.relation === v.relation))] });
    else pending.set(p.key, p);
  };
  pending.set(centerKey, { col: 0, record: tree.selected.record, key: centerKey, via: [] });

  // Left: the parent chain and the causes, one column a level.
  if (o.sides.parents)
    tree.ancestors.slice(0, o.depth).forEach((a, i) => {
      const from = i === 0 ? centerKey : `r${(tree.ancestors[i - 1] as TreeNode).record.seq}`;
      add({ col: -(i + 1), record: a.record, key: `r${a.record.seq}`, via: [{ from, relation: "parent" }] });
    });
  const walkLeft = (nodes: readonly TreeNode[], level: number, from: string): void => {
    if (level > o.depth) return;
    for (const n of nodes) {
      const key = `r${n.record.seq}`;
      add({ col: -level, record: n.record, key, via: [{ from, relation: "cause" }] });
      walkLeft(n.below, level + 1, key);
    }
  };
  if (o.sides.causes) walkLeft(tree.causes, 1, centerKey);

  // The lane: what the record did, in time order. It takes the first column on the right; the effects come after it.
  const items = o.sides.children ? laneItems(tree.children, o.depth) : [];
  const rows = laneRows(items, o);
  const hasLane = rows.length > 0;
  const effectBase = hasLane ? 2 : 1;
  const inLane = new Set(items.map((x) => x.record.seq));

  // Right: effects (cause edges), one column a level, a column of many shown in part.
  const columns = new Map<number, { col: number; items: { record: TraceRecord; from: string }[] }>();
  const walkRight = (nodes: readonly TreeNode[], level: number, from: string): void => {
    if (level > o.depth) return;
    const col = columns.get(level) ?? columns.set(level, { col: effectBase + level - 1, items: [] }).get(level);
    for (const n of nodes) {
      // A record that is a child as well is a step of the lane and not drawn twice.
      if (!inLane.has(n.record.seq)) col?.items.push({ record: n.record, from });
      walkRight(n.below, level + 1, `r${n.record.seq}`);
    }
  };
  if (o.sides.effects) walkRight(tree.effects, 1, centerKey);
  for (const c of columns.values()) {
    const list = [...c.items].sort((a, b) => byTime(a.record, b.record));
    const gkey = `cause:${c.col}:more`;
    const grouped = list.length > COLUMN_LIMIT;
    const shownN = grouped ? HEAD + (o.expanded.get(gkey) ?? 0) : list.length;
    for (const it of list.slice(0, shownN)) add({ col: c.col, record: it.record, key: `r${it.record.seq}`, via: [{ from: it.from, relation: "cause" }] });
    const rest = list.slice(shownN);
    if (grouped && rest.length > 0) {
      const from = [...new Set(rest.map((r) => r.from))];
      add({ col: c.col, group: { label: `+ ${rest.length} more · ${summaryOf(rest.map((r) => r.record))}`, hidden: rest.length, key: gkey, kind: "more" }, key: `g:${gkey}`, via: from.map((f) => ({ from: f, relation: "cause" as const })) });
    }
  }

  // Positions: a column a step of its width and the gap, its nodes in time order and centred on the middle row; the lane has its own height and scrolls past LANE_VIEW_MAX.
  const cols = new Map<number, Pending[]>();
  for (const p of pending.values()) (cols.get(p.col) ?? cols.set(p.col, []).get(p.col))?.push(p);
  const timeOf = (p: Pending): number => (p.record ? p.record.simTime : Number.MAX_SAFE_INTEGER);
  const seqOf = (p: Pending): number => (p.record ? p.record.seq : Number.MAX_SAFE_INTEGER);
  const laneW = RAIL_W + NODE_W + (o.depth - 1) * LANE_INDENT;
  const contentH = rows.reduce((h, r, i) => h + r.h + (i > 0 ? LANE_GAP_Y : 0), 0);
  const viewH = Math.min(contentH, LANE_VIEW_MAX);
  const colList = [...cols.keys(), ...(hasLane ? [1] : [])];
  const minCol = Math.min(...colList);
  const maxCol = Math.max(...colList);
  const colW = (c: number): number => (hasLane && c === 1 ? laneW : NODE_W);
  const colX = new Map<number, number>();
  let run = 0;
  for (let c = minCol; c <= maxCol; c++) {
    colX.set(c, run);
    run += colW(c) + GAP_X;
  }
  const width = run - GAP_X;
  const tallest = Math.max(NODE_H, viewH, ...[...cols.values()].map((c) => c.length * (NODE_H + GAP_Y) - GAP_Y));
  const nodes: GraphNode[] = [];
  for (const [col, list] of cols) {
    list.sort((a, b) => timeOf(a) - timeOf(b) || seqOf(a) - seqOf(b) || (a.key < b.key ? -1 : 1));
    const top = (tallest - (list.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
    list.forEach((p, i) => {
      nodes.push({
        key: p.key,
        col,
        x: colX.get(col) as number,
        y: top + i * (NODE_H + GAP_Y),
        h: NODE_H,
        ...(p.record ? { record: p.record } : {}),
        ...(p.group ? { group: p.group } : {}),
        center: p.key === centerKey,
        failed: p.record !== undefined && failedRecord(p.record),
      });
    });
  }
  let lane: GraphLane | undefined;
  if (hasLane) {
    const laneX = colX.get(1) as number;
    const laneY = (tallest - viewH) / 2;
    lane = { x: laneX, y: laneY, width: laneW, viewH, contentH, total: items.length };
    let y = 0;
    let prevEnd: number | undefined;
    for (const r of rows) {
      const first = r.records[0] as TraceRecord;
      const last = r.records[r.records.length - 1] as TraceRecord;
      const gap = prevEnd !== undefined && first.simTime - prevEnd >= GAP_SHOWN_S ? `+${first.simTime - prevEnd < 10 ? (first.simTime - prevEnd).toFixed(2) : (first.simTime - prevEnd).toFixed(1)} s` : undefined;
      const x = laneX + RAIL_W + (r.level - 1) * LANE_INDENT;
      const base = { key: r.key, col: 1, x, y: laneY + y, h: r.h, center: false } as const;
      if (r.kind === "step") nodes.push({ ...base, record: first, failed: failedRecord(first), lane: { level: r.level, time: seconds(first.simTime), ...(gap ? { gap } : {}), ok: succeeded(first) } });
      else if (r.kind === "run")
        nodes.push({
          ...base,
          failed: false,
          group: { label: `${kindOp(first)} ×${r.records.length}`, hidden: r.records.length, key: r.key, kind: "run", detail: `${seconds(first.simTime)}–${seconds(last.simTime)} · #${first.seq} … #${last.seq}` },
          lane: { level: r.level, time: seconds(first.simTime), ...(gap ? { gap } : {}), ok: false },
        });
      else
        nodes.push({
          ...base,
          failed: false,
          group: { label: `… ${r.records.length} more · ${summaryOf(r.records)}`, hidden: r.records.length, key: "lane:gap", kind: "gap" },
          lane: { level: 1, time: "", ok: false },
        });
      prevEnd = last.simTime;
      y += r.h + LANE_GAP_Y;
    }
  }
  nodes.sort((a, b) => a.col - b.col || a.y - b.y);
  const failedKeys = new Set(nodes.filter((n) => n.failed).map((n) => n.key));
  const edges: GraphEdge[] = [];
  for (const p of pending.values())
    for (const v of p.via) {
      // Edges run from the left node to the right one: a parent or a cause is the origin of the record it belongs to.
      const left = p.col < 0 || p.col < (pending.get(v.from)?.col ?? 0);
      const [from, to] = left ? [p.key, v.from] : [v.from, p.key];
      edges.push({ from, to, relation: v.relation, failed: failedKeys.has(from) || failedKeys.has(to) });
    }
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.relation < b.relation ? -1 : 1));
  return { nodes, edges, ...(lane ? { lane } : {}), width, height: tallest };
}

/** The two lines of a node: its summary (kind tag and `op · name`) and its time, agent or source and sequence number. */
export function nodeLines(r: TraceRecord): { readonly top: string; readonly bottom: string } {
  return { top: summary(r), bottom: `${r.simTime.toFixed(2)} s · ${r.agentId ?? r.source} · #${r.seq}` };
}
