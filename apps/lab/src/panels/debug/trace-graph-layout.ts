import type { TraceRecord } from "@agentsim/trace";
import { summary } from "./log-rows.ts";
import { flagRole, isFailure, markOf } from "./marks.ts";
import type { TraceTree, TreeNode } from "./trace-tree.ts";

// The layout of the trace graph (U-010 §2): layered, left to right, deterministic, never force-directed, so a node is where it was the last time. Parents and causes are on
// the left (parent edges solid, cause edges dashed), the record in the middle, children and effects on the right; inside a column the nodes are ordered by time. A column of
// many children shows the first few and a dashed group node for the rest; with grouping on, a column collapses to one node per kind · op. Pure: the panel only draws it.

export const NODE_W = 230;
export const NODE_H = 44;
export const GAP_X = 110;
export const GAP_Y = 14;
/** A column of more records than this shows the first `HEAD` of them and a group node for the rest. */
export const COLUMN_LIMIT = 12;
export const HEAD = 6;
/** What a click on a group node shows more of. */
export const PAGE = 10;

export type Side = "parents" | "causes" | "children" | "effects";

export interface GraphOptions {
  readonly depth: 1 | 2 | 3;
  readonly sides: Readonly<Record<Side, boolean>>;
  readonly groupByKind: boolean;
  /** How many records of a group have been expanded (a click adds a page), by the group's key. */
  readonly expanded: ReadonlyMap<string, number>;
}

export interface GraphNode {
  readonly key: string;
  /** Column: negative on the left of the record, 0 for it, positive on the right. */
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly record?: TraceRecord;
  /** A group of records not shown one by one: its label, how many it holds still hidden, and the key a click expands. */
  readonly group?: { readonly label: string; readonly hidden: number; readonly key: string };
  readonly center: boolean;
  readonly failed: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** `parent`: solid; `cause`: dashed. */
  readonly relation: "parent" | "cause";
  readonly failed: boolean;
}

export interface GraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

/** `phase · transitions`: what a record is, as the Log's summary column says it, for grouping and for the label of a group. */
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

/** A short description of what is in a list of records: `phase ×5, predrive ×1` (most first). */
function summaryOf(records: readonly TraceRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(kindOpShort(r), (counts.get(kindOpShort(r)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ×${n}`).join(", ");
}
const kindOpShort = (r: TraceRecord): string => {
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

/**
 * The layout of a tree. A record that is both an ancestor and a cause is one node with two edges. Nothing here depends on the order the tree came in: columns are ordered by
 * time and sequence number.
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

  // Right: children (parent edges) and effects (cause edges), one column a level, a column of many shown in part.
  const columns = new Map<string, { relation: "parent" | "cause"; col: number; items: { record: TraceRecord; from: string }[] }>();
  const walkRight = (nodes: readonly TreeNode[], level: number, from: string, relation: "parent" | "cause"): void => {
    if (level > o.depth) return;
    const col = columns.get(`${relation}:${level}`) ?? columns.set(`${relation}:${level}`, { relation, col: level, items: [] }).get(`${relation}:${level}`);
    for (const n of nodes) {
      col?.items.push({ record: n.record, from });
      walkRight(n.below, level + 1, `r${n.record.seq}`, relation);
    }
  };
  if (o.sides.children) walkRight(tree.children, 1, centerKey, "parent");
  if (o.sides.effects) walkRight(tree.effects, 1, centerKey, "cause");
  for (const c of columns.values()) {
    const items = [...c.items].sort((a, b) => byTime(a.record, b.record));
    const buckets = new Map<string, typeof items>();
    if (o.groupByKind) for (const it of items) (buckets.get(`k:${kindOp(it.record)}`) ?? buckets.set(`k:${kindOp(it.record)}`, []).get(`k:${kindOp(it.record)}`))?.push(it);
    else buckets.set("more", items);
    for (const [bk, list] of buckets) {
      const gkey = `${c.relation}:${c.col}:${bk}`;
      const grouped = o.groupByKind ? list.length > 1 : list.length > COLUMN_LIMIT;
      const shownN = grouped ? (o.groupByKind ? 0 : HEAD) + (o.expanded.get(gkey) ?? 0) : list.length;
      const visible = list.slice(0, shownN);
      for (const it of visible) add({ col: c.col, record: it.record, key: `r${it.record.seq}`, via: [{ from: it.from, relation: c.relation }] });
      const rest = list.slice(shownN);
      if (grouped && rest.length > 0) {
        const label = o.groupByKind ? `${kindOp((rest[0] as { record: TraceRecord }).record)} ×${rest.length}` : `+ ${rest.length} more · ${summaryOf(rest.map((r) => r.record))}`;
        const from = [...new Set(rest.map((r) => r.from))];
        add({ col: c.col, group: { label, hidden: rest.length, key: gkey }, key: `g:${gkey}`, via: from.map((f) => ({ from: f, relation: c.relation })) });
      }
    }
  }

  // Positions: a column a step of node width and gap, its nodes in time order and centred on the middle row.
  const cols = new Map<number, Pending[]>();
  for (const p of pending.values()) (cols.get(p.col) ?? cols.set(p.col, []).get(p.col))?.push(p);
  const timeOf = (p: Pending): number => (p.record ? p.record.simTime : Number.MAX_SAFE_INTEGER);
  const seqOf = (p: Pending): number => (p.record ? p.record.seq : Number.MAX_SAFE_INTEGER);
  const minCol = Math.min(...cols.keys());
  const maxCol = Math.max(...cols.keys());
  const tallest = Math.max(...[...cols.values()].map((c) => c.length));
  const height = tallest * (NODE_H + GAP_Y) - GAP_Y;
  const nodes: GraphNode[] = [];
  for (const [col, list] of cols) {
    list.sort((a, b) => timeOf(a) - timeOf(b) || seqOf(a) - seqOf(b) || (a.key < b.key ? -1 : 1));
    const top = (height - (list.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
    list.forEach((p, i) => {
      nodes.push({
        key: p.key,
        col,
        x: (col - minCol) * (NODE_W + GAP_X),
        y: top + i * (NODE_H + GAP_Y),
        ...(p.record ? { record: p.record } : {}),
        ...(p.group ? { group: p.group } : {}),
        center: p.key === centerKey,
        failed: p.record !== undefined && failedRecord(p.record),
      });
    });
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
  return { nodes, edges, width: (maxCol - minCol + 1) * NODE_W + (maxCol - minCol) * GAP_X, height: Math.max(height, NODE_H) };
}

/** The two lines of a node: its summary (kind tag and `op · name`) and its time, agent or source and sequence number. */
export function nodeLines(r: TraceRecord): { readonly top: string; readonly bottom: string } {
  return { top: summary(r), bottom: `${r.simTime.toFixed(2)} s · ${r.agentId ?? r.source} · #${r.seq}` };
}
