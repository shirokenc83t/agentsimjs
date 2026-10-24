import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { COLUMN_LIMIT, GAP_X, GAP_Y, HEAD, layoutTraceGraph, NODE_H, NODE_W, PAGE, outcomeGlyph, type GraphOptions } from "./trace-graph-layout.ts";
import type { TraceTree, TreeNode } from "./trace-tree.ts";

// The layout of the trace graph is a function of the tree and the options: layered, left to right, ordered by time inside a column, the same every time (U-010 §2).

const rec = (seq: number, simTime: number, op: string, detail?: string, kind = "action", payload: Record<string, unknown> = {}): TraceRecord =>
  ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime, wallTime: 1, agentId: "ugv-001", source: "ugv-001/actions", kind, ...(detail ? { detail } : {}), payload: { op, ...payload } }) as unknown as TraceRecord;
const node = (record: TraceRecord, below: TreeNode[] = []): TreeNode => ({ record, copyOf: undefined, below, more: 0 });
const OPTS: GraphOptions = { depth: 1, sides: { parents: true, causes: true, children: true, effects: true }, groupByKind: false, expanded: new Map() };
const tree = (over: Partial<TraceTree> = {}): TraceTree => ({ selected: node(rec(10, 5, "start", "full")), ancestors: [], ancestorsMore: false, causes: [], causesMore: 0, children: [], childrenMore: 0, effects: [], effectsMore: 0, ...over });

describe("the layout of the trace graph", () => {
  it("puts parents and causes on the left, the record in the middle and children and effects on the right, in columns of one step, edges solid for parents and dashed for causes", () => {
    const t = tree({ ancestors: [node(rec(8, 1, "start"))], causes: [node(rec(9, 2, "decision", undefined, "decision"))], children: [node(rec(11, 6, "phase", "transitions"))], effects: [node(rec(12, 7, "end", undefined, "event"))] });
    const g = layoutTraceGraph(t, OPTS);
    const at = (seq: number) => g.nodes.find((n) => n.record?.seq === seq);
    expect([8, 9, 10, 11, 12].map((s) => at(s)?.col)).toEqual([-1, -1, 0, 1, 1]);
    expect(at(10)?.x).toBe(NODE_W + GAP_X);
    expect(at(11)?.x).toBe(2 * (NODE_W + GAP_X));
    expect(at(10)?.center).toBe(true);
    const rel = (from: number, to: number) => g.edges.find((e) => e.from === `r${from}` && e.to === `r${to}`)?.relation;
    expect([rel(8, 10), rel(9, 10), rel(10, 11), rel(10, 12)]).toEqual(["parent", "cause", "parent", "cause"]);
    expect(g.width).toBe(3 * NODE_W + 2 * GAP_X);
  });

  it("orders a column by time and is the same layout every time, whatever order the tree came in", () => {
    const kids = [rec(20, 9, "phase"), rec(21, 6, "phase"), rec(22, 7, "phase")];
    const a = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS);
    const b = layoutTraceGraph(tree({ children: [...kids].reverse().map((r) => node(r)) }), OPTS);
    expect(a).toEqual(b);
    const right = a.nodes.filter((n) => n.col === 1);
    expect(right.map((n) => n.record?.seq)).toEqual([21, 22, 20]);
    for (let i = 1; i < right.length; i++) expect((right[i] as { y: number }).y - (right[i - 1] as { y: number }).y).toBe(NODE_H + GAP_Y);
  });

  it("shows the depth asked: one column a level, the chain of parents and the causes of causes to the left, children of children to the right", () => {
    const t = tree({
      ancestors: [node(rec(8, 1, "start")), node(rec(7, 0.5, "start"))],
      children: [node(rec(11, 6, "phase"), [node(rec(13, 7, "x"))])],
    });
    expect(layoutTraceGraph(t, OPTS).nodes.map((n) => n.col).sort()).toEqual([-1, 0, 1]);
    expect(layoutTraceGraph(t, { ...OPTS, depth: 2 }).nodes.map((n) => n.col).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    expect(layoutTraceGraph(t, { ...OPTS, depth: 3 }).nodes).toHaveLength(5); // there is nothing further
  });

  it("hides a side that is turned off", () => {
    const t = tree({ ancestors: [node(rec(8, 1, "start"))], children: [node(rec(11, 6, "phase"))] });
    const g = layoutTraceGraph(t, { ...OPTS, sides: { ...OPTS.sides, parents: false } });
    expect(g.nodes.some((n) => n.record?.seq === 8)).toBe(false);
    expect(g.nodes.some((n) => n.record?.seq === 11)).toBe(true);
  });

  it("shows the first few of 12 or more children and one dashed group node for the rest, which a click expands a page at a time", () => {
    const kids = Array.from({ length: COLUMN_LIMIT + 6 }, (_, i) => rec(30 + i, 6 + i * 0.1, i % 3 === 0 ? "predrive" : "phase", "full"));
    const g = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS);
    expect(g.nodes.filter((n) => n.record && n.col === 1)).toHaveLength(HEAD);
    const group = g.nodes.find((n) => n.group);
    expect(group?.group?.hidden).toBe(COLUMN_LIMIT + 6 - HEAD);
    expect(group?.group?.label).toMatch(/^\+ 12 more · /);
    expect(group?.group?.label).toContain("phase ×");
    const more = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, expanded: new Map([[group?.group?.key as string, PAGE]]) });
    expect(more.nodes.filter((n) => n.record && n.col === 1)).toHaveLength(HEAD + PAGE);
    expect(more.nodes.find((n) => n.group)?.group?.hidden).toBe(12 - PAGE);
    const all = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, expanded: new Map([[group?.group?.key as string, 2 * PAGE]]) });
    expect(all.nodes.some((n) => n.group)).toBe(false);
  });

  it("with grouping on, a column is one node per kind and op, a single record stays itself", () => {
    const kids = [...Array.from({ length: 9 }, (_, i) => rec(40 + i, 6 + i * 0.1, "phase", "transitions")), rec(60, 8, "predrive", "full")];
    const g = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, groupByKind: true });
    const right = g.nodes.filter((n) => n.col === 1);
    expect(right).toHaveLength(2);
    expect(right.find((n) => n.group)?.group?.label).toBe("phase · transitions ×9");
    expect(right.find((n) => n.record)?.record?.seq).toBe(60);
  });

  it("is one node with two edges for a record that is both a parent and a cause, and marks a failure's edges", () => {
    const failed = rec(8, 1, "end", undefined, "action", { status: "failed", failure: { code: "unreachable" } });
    const g = layoutTraceGraph(tree({ ancestors: [node(failed)], causes: [node(failed)] }), OPTS);
    expect(g.nodes.filter((n) => n.record?.seq === 8)).toHaveLength(1);
    expect(g.edges.filter((e) => e.from === "r8").map((e) => e.relation).sort()).toEqual(["cause", "parent"]);
    expect(g.nodes.find((n) => n.record?.seq === 8)?.failed).toBe(true);
    expect(g.edges.every((e) => e.failed)).toBe(true);
  });

  it("says the outcome of an action record: a start runs, a success is done, a failure and a refusal are flags", () => {
    expect(outcomeGlyph(rec(1, 1, "start"))).toBe("▶");
    expect(outcomeGlyph(rec(2, 1, "end", undefined, "action", { status: "succeeded" }))).toBe("✓");
    expect(outcomeGlyph(rec(3, 1, "end", undefined, "action", { status: "failed" }))).toBe("✕");
    expect(outcomeGlyph(rec(4, 1, "rejected"))).toBe("▲");
    expect(outcomeGlyph(rec(5, 1, "phase"))).toBeUndefined();
    expect(outcomeGlyph(rec(6, 1, "start", undefined, "event"))).toBeUndefined();
  });
});
