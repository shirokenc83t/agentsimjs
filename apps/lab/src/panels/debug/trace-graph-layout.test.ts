import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { COLUMN_LIMIT, GAP_X, HEAD, LANE_HEAD, LANE_PAGE, LANE_ROWS, LANE_TAIL, LANE_VIEW_MAX, layoutTraceGraph, NODE_W, PAGE, RAIL_W, RUN_MIN, outcomeGlyph, type GraphOptions } from "./trace-graph-layout.ts";
import type { TraceTree, TreeNode } from "./trace-tree.ts";

// The layout of the trace graph is a function of the tree and the options: parents and causes on the left, the record in the middle, its children as one lane in time order, its effects on
// the right; the same every time.

const rec = (seq: number, simTime: number, op: string, detail?: string, kind = "action", payload: Record<string, unknown> = {}): TraceRecord =>
  ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime, wallTime: 1, agentId: "ugv-001", source: "ugv-001/actions", kind, ...(detail ? { detail } : {}), payload: { op, ...payload } }) as unknown as TraceRecord;
const node = (record: TraceRecord, below: TreeNode[] = []): TreeNode => ({ record, copyOf: undefined, below, more: 0 });
const OPTS: GraphOptions = { depth: 1, sides: { parents: true, causes: true, children: true, effects: true }, foldRuns: true, expanded: new Map() };
const tree = (over: Partial<TraceTree> = {}): TraceTree => ({ selected: node(rec(10, 5, "start", "full")), ancestors: [], ancestorsMore: false, causes: [], causesMore: 0, children: [], childrenMore: 0, effects: [], effectsMore: 0, ...over });
const lane = (g: ReturnType<typeof layoutTraceGraph>) => g.nodes.filter((n) => n.lane);

describe("the layout of the trace graph", () => {
  it("puts parents and causes on the left, the record in the middle, its children as a lane after it and its effects after the lane, edges solid for parents and dashed for causes", () => {
    const t = tree({ ancestors: [node(rec(8, 1, "start"))], causes: [node(rec(9, 2, "decision", undefined, "decision"))], children: [node(rec(11, 6, "phase", "transitions"))], effects: [node(rec(12, 7, "end", undefined, "event"))] });
    const g = layoutTraceGraph(t, OPTS);
    const at = (seq: number) => g.nodes.find((n) => n.record?.seq === seq);
    expect([8, 9, 10, 11, 12].map((s) => at(s)?.col)).toEqual([-1, -1, 0, 1, 2]);
    expect(at(11)?.lane?.level).toBe(1);
    expect(at(10)?.center).toBe(true);
    const rel = (from: number, to: number) => g.edges.find((e) => e.from === `r${from}` && e.to === `r${to}`)?.relation;
    expect([rel(8, 10), rel(9, 10), rel(10, 12)]).toEqual(["parent", "cause", "cause"]);
    // The lane is linked to the record by a bracket, not by an edge a child.
    expect(g.edges.some((e) => e.to === "r11")).toBe(false);
    expect(g.lane?.x).toBe(2 * (NODE_W + GAP_X));
    expect(g.width).toBe(3 * NODE_W + 3 * GAP_X + RAIL_W + NODE_W);
  });

  it("orders the lane by time and sequence number, top to bottom, and is the same layout every time whatever order the tree came in", () => {
    const kids = [rec(20, 9, "phase"), rec(21, 6, "predrive"), rec(22, 7, "end", undefined, "action", { status: "succeeded" })];
    const a = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS);
    const b = layoutTraceGraph(tree({ children: [...kids].reverse().map((r) => node(r)) }), OPTS);
    expect(a).toEqual(b);
    expect(lane(a).map((n) => n.record?.seq)).toEqual([21, 22, 20]);
    const ys = lane(a).map((n) => n.y);
    expect([...ys].sort((x, y) => x - y)).toEqual(ys);
  });

  it("says each step's time and the gap to the step before where it matters (from 0.1 s), and marks the end that succeeded", () => {
    const kids = [rec(20, 6, "predrive"), rec(21, 6.04, "decision"), rec(22, 6.5, "phase"), rec(23, 8, "end", undefined, "action", { status: "succeeded" })];
    const steps = lane(layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS));
    expect(steps.map((n) => n.lane?.time)).toEqual(["6.00 s", "6.04 s", "6.50 s", "8.00 s"]);
    expect(steps.map((n) => n.lane?.gap)).toEqual([undefined, undefined, "+0.46 s", "+1.50 s"]);
    expect(steps.map((n) => n.lane?.ok)).toEqual([false, false, false, true]);
  });

  it("folds a run of the same kind and op into one row that keeps its place in the order, and opens it when asked", () => {
    const kids = [rec(20, 6, "predrive", "full"), ...Array.from({ length: 12 }, (_, i) => rec(21 + i, 6.3 + i * 0.1, "phase", "transitions")), rec(40, 8, "end", undefined, "action", { status: "succeeded" })];
    const g = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS);
    expect(lane(g).map((n) => (n.group ? "run" : "step"))).toEqual(["step", "run", "step"]);
    const run = lane(g).find((n) => n.group);
    expect(run?.group).toMatchObject({ kind: "run", label: "phase · transitions ×12", hidden: 12 });
    expect(run?.group?.detail).toBe("6.30 s–7.40 s · #21 … #32");
    const open = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, expanded: new Map([[run?.group?.key as string, 1]]) });
    expect(lane(open)).toHaveLength(14);
    expect(lane(open).every((n) => !n.group)).toBe(true);
    // Folding off: every step is a row. Fewer than RUN_MIN of a kind stay as they are.
    expect(lane(layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, foldRuns: false }))).toHaveLength(14);
    const two = Array.from({ length: RUN_MIN - 1 }, (_, i) => rec(50 + i, 7 + i, "phase", "transitions"));
    expect(lane(layoutTraceGraph(tree({ children: two.map((r) => node(r)) }), OPTS))).toHaveLength(RUN_MIN - 1);
  });

  it("never folds a failure or the end, and a run is broken by another kind", () => {
    const fail = (seq: number, t: number) => rec(seq, t, "end", undefined, "action", { status: "failed", failure: { code: "unreachable" } });
    const kids = [rec(20, 6, "phase"), rec(21, 6.1, "phase"), fail(22, 6.2), fail(23, 6.3), fail(24, 6.4), rec(25, 7, "phase"), rec(26, 7.1, "phase"), rec(27, 7.2, "phase")];
    const rows = lane(layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS));
    expect(rows.map((n) => (n.group ? `run×${n.group.hidden}` : `#${n.record?.seq}`))).toEqual(["#20", "#21", "#22", "#23", "#24", "run×3"]);
    expect(rows.filter((n) => n.failed)).toHaveLength(3);
  });

  it("collapses a long middle into one row that opens a page of rows at a time and keeps the head and the tail (the end closes the lane)", () => {
    const kids = Array.from({ length: 150 }, (_, i) => rec(100 + i, 6 + i * 0.1, i % 2 === 0 ? "predrive" : "decision", "x"));
    kids.push(rec(300, 40, "end", undefined, "action", { status: "succeeded" }));
    const g = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), OPTS);
    expect(g.lane?.total).toBe(151);
    const rows = lane(g);
    expect(rows).toHaveLength(LANE_HEAD + 1 + LANE_TAIL);
    const gap = rows.find((n) => n.group?.kind === "gap");
    expect(gap?.group?.hidden).toBe(151 - LANE_HEAD - LANE_TAIL);
    expect(gap?.group?.label).toMatch(/^… 140 more · /);
    expect(rows[rows.length - 1]?.record?.seq).toBe(300);
    // It scrolls instead of growing the window: the lane is as tall as the cap and holds more.
    expect(g.lane?.viewH).toBe(LANE_VIEW_MAX);
    expect((g.lane?.contentH ?? 0) > LANE_VIEW_MAX).toBe(true);
    const more = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, expanded: new Map([["lane:gap", LANE_PAGE]]) });
    expect(lane(more)).toHaveLength(LANE_HEAD + LANE_PAGE + 1 + LANE_TAIL);
    const all = layoutTraceGraph(tree({ children: kids.map((r) => node(r)) }), { ...OPTS, expanded: new Map([["lane:gap", 1000]]) });
    expect(lane(all)).toHaveLength(151);
    expect(lane(all).some((n) => n.group)).toBe(false);
    expect(LANE_ROWS).toBeGreaterThan(LANE_HEAD + LANE_TAIL);
  });

  it("puts the record in the middle of the lane's height, and the left and right columns on the same middle", () => {
    const kids = Array.from({ length: 15 }, (_, i) => rec(100 + i, 6 + i, i % 2 === 0 ? "predrive" : "decision", "x"));
    const g = layoutTraceGraph(tree({ ancestors: [node(rec(8, 1, "start"))], children: kids.map((r) => node(r)) }), OPTS);
    const mid = (g.lane?.y ?? 0) + (g.lane?.viewH ?? 0) / 2;
    const center = g.nodes.find((n) => n.center);
    expect((center?.y ?? 0) + (center?.h ?? 0) / 2).toBeCloseTo(mid, 5);
    const parent = g.nodes.find((n) => n.record?.seq === 8);
    expect((parent?.y ?? 0) + (parent?.h ?? 0) / 2).toBeCloseTo(mid, 5);
  });

  it("shows the depth asked: a column a level to the left, grandchildren as indented steps of the lane, effects of effects further right", () => {
    const t = tree({
      ancestors: [node(rec(8, 1, "start")), node(rec(7, 0.5, "start"))],
      children: [node(rec(11, 6, "phase"), [node(rec(13, 7, "x"))])],
    });
    expect(layoutTraceGraph(t, OPTS).nodes.map((n) => n.col).sort()).toEqual([-1, 0, 1]);
    const two = layoutTraceGraph(t, { ...OPTS, depth: 2 });
    expect(two.nodes.map((n) => n.col).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 1]);
    const steps = lane(two);
    expect(steps.map((n) => n.lane?.level)).toEqual([1, 2]);
    expect((steps[1] as { x: number }).x).toBeGreaterThan((steps[0] as { x: number }).x);
    expect(layoutTraceGraph(t, { ...OPTS, depth: 3 }).nodes).toHaveLength(5); // there is nothing further
  });

  it("hides a side that is turned off, the lane included", () => {
    const t = tree({ ancestors: [node(rec(8, 1, "start"))], children: [node(rec(11, 6, "phase"))] });
    const g = layoutTraceGraph(t, { ...OPTS, sides: { ...OPTS.sides, parents: false } });
    expect(g.nodes.some((n) => n.record?.seq === 8)).toBe(false);
    expect(g.nodes.some((n) => n.record?.seq === 11)).toBe(true);
    const none = layoutTraceGraph(t, { ...OPTS, sides: { ...OPTS.sides, children: false } });
    expect(none.lane).toBeUndefined();
    expect(none.nodes.some((n) => n.record?.seq === 11)).toBe(false);
  });

  it("shows the first few of 12 or more effects and one dashed group node for the rest, which a click expands a page at a time; a child that is an effect too is drawn once, in the lane", () => {
    const fx = Array.from({ length: COLUMN_LIMIT + 6 }, (_, i) => rec(30 + i, 6 + i * 0.1, i % 3 === 0 ? "predrive" : "phase", "full"));
    const g = layoutTraceGraph(tree({ effects: fx.map((r) => node(r)) }), OPTS);
    expect(g.nodes.filter((n) => n.record && n.col === 1)).toHaveLength(HEAD);
    const group = g.nodes.find((n) => n.group);
    expect(group?.group?.hidden).toBe(COLUMN_LIMIT + 6 - HEAD);
    expect(group?.group?.label).toMatch(/^\+ 12 more · /);
    expect(group?.group?.label).toContain("phase ×");
    const more = layoutTraceGraph(tree({ effects: fx.map((r) => node(r)) }), { ...OPTS, expanded: new Map([[group?.group?.key as string, PAGE]]) });
    expect(more.nodes.filter((n) => n.record && n.col === 1)).toHaveLength(HEAD + PAGE);
    const both = layoutTraceGraph(tree({ children: [node(fx[0] as TraceRecord)], effects: [node(fx[0] as TraceRecord)] }), OPTS);
    expect(both.nodes.filter((n) => n.record?.seq === 30)).toHaveLength(1);
    expect(both.nodes.find((n) => n.record?.seq === 30)?.lane).toBeDefined();
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
