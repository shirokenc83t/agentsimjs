import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { breadcrumb, childNodes, collapseAll, explode, fold, layoutRow, navigate, rootNodes, timeTicks, type HistoryNode } from "./history-model.ts";

// The model of the agent action history: rows from records, a deterministic layout, folding of narrow nodes, exploding and folding, the keyboard, and a mission's decision → step chain.

let seq = 0;
const rec = (kind: TraceRecord["kind"], payload: unknown, simTime: number, extra: Partial<TraceRecord> = {}): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq: seq++, simTime, wallTime: 0, agentId: "ugv-007", source: "ugv-007/x", kind, payload, ...extra });
const start = (id: string, name: string, t: number, params: unknown = {}, extra: Partial<TraceRecord> = {}) => rec("action", { op: "start", actionId: id, name, params }, t, extra);
const end = (id: string, name: string, status: string, t: number, code?: string) => rec("action", { op: "end", actionId: id, name, status, ...(code === undefined ? {} : { failure: { code } }) }, t);

function run(): TraceRecord[] {
  seq = 0;
  return [
    rec("injected", { op: "command", name: "explore", ok: true }, 2.2),
    start("a1", "takeoff", 0, { altitudeM: 20 }),
    end("a1", "takeoff", "succeeded", 2),
    start("a2", "explore", 2.2, { radiusM: 20 }),
    rec("reflex", { reflex: "obstacle", code: "obstacle_ahead" }, 39.1),
    end("a2", "explore", "preempted", 39.1),
    start("a3", "goTo", 45, { xM: 50, yM: 20 }),
    end("a3", "goTo", "failed", 50, "unreachable"),
  ];
}

describe("the first rows of an agent's history", () => {
  it("has the commands on one row and the actions as bars with their outcome, the reflex and the failure on the action row, and idle time between", () => {
    const { commands, actions } = rootNodes(run(), 60);
    expect(commands.map((n) => [n.glyph, n.label])).toEqual([["◆", "explore"]]);
    const bars = actions.filter((n) => n.kind === "action");
    expect(bars.map((n) => [n.label, n.glyph, n.t0, n.t1])).toEqual([
      ["takeoff 20 m", "✓", 0, 2],
      ["explore r 20 m", "▲", 2.2, 39.1],
      ["goTo (50, 20)", "✕", 45, 50],
    ]);
    expect(actions.find((n) => n.kind === "reflex")).toMatchObject({ glyph: "▲", t0: 39.1 });
    expect(actions.find((n) => n.kind === "failure")).toMatchObject({ glyph: "✕", label: "goTo failed · unreachable" });
    const idle = actions.filter((n) => n.kind === "idle");
    expect(idle.map((n) => [n.t0, n.t1])).toEqual([[2, 2.2].map((x) => x) as never, [39.1, 45], [50, 60]].filter((p) => (p as number[])[1]! - (p as number[])[0]! >= 0.5));
    expect(idle.every((n) => n.label === "idle" && n.glyph === "○")).toBe(true);
  });

  it("a running action runs to the end of the run, and a mission's decisions are on the command row", () => {
    seq = 0;
    const records = [rec("thought", { op: "decision", step: 1, of: 4, decision: { name: "takeoff" } }, 0), start("a1", "takeoff", 0), rec("thought", { op: "decision", step: 4, of: 4, done: true }, 30)];
    const { commands, actions } = rootNodes(records, 40);
    expect(commands.map((n) => n.label)).toEqual(["decision · step 1 of 4 · takeoff", "decision · step 4 of 4 · done"]);
    expect(actions[0]).toMatchObject({ status: "running", glyph: "▶", t1: 40 });
  });
});

describe("the layout", () => {
  const axis = { t0: 0, t1: 60, widthPx: 600 };

  it("gives the same positions twice and does not depend on the order the nodes come in", () => {
    const { actions } = rootNodes(run(), 60);
    const a = layoutRow(actions, axis);
    const b = layoutRow([...actions].reverse(), axis);
    expect(a).toEqual(b);
    expect(layoutRow(actions, axis)).toEqual(a);
    expect(a.placed.find((p) => p.node.label === "takeoff 20 m")).toMatchObject({ x: 0, w: 20 }); // 2 s of 60 on 600 px
  });

  it("staggers what overlaps on sub-rows in seq order", () => {
    const { actions } = rootNodes(run(), 60);
    const { placed, lanes } = layoutRow(actions, axis);
    const reflex = placed.find((p) => p.node.kind === "reflex");
    const explore = placed.find((p) => p.node.label.startsWith("explore"));
    expect(reflex?.lane).not.toBe(explore?.lane); // the reflex sits at the end of the explore bar
    expect(lanes).toBeGreaterThan(1);
  });

  it("the width rule: nodes narrower than 40 px fold with their neighbours of the same op across other ops, a lone narrow node is a tick, and wide ones stay boxes", () => {
    seq = 0;
    const start0 = start("a2", "explore", 0);
    const kids: TraceRecord[] = [];
    for (let i = 0; i < 6; i++) {
      kids.push(rec("action", { op: "explore-iteration", event: "start", iteration: i + 1 }, i * 10, { parentId: start0.id }));
      kids.push(rec("action", { op: "explore-iteration", event: "end", iteration: i + 1 }, i * 10 + 9, { parentId: start0.id }));
      kids.push(rec("action", { op: "explore-target", event: "selected" }, i * 10 + 1, { parentId: start0.id }));
    }
    kids.push(rec("action", { op: "explore-target", event: "selected" }, 59.5, { parentId: start0.id }));
    const { placed } = layoutRow(childNodes(kids, 60, 60), { t0: 0, t1: 60, widthPx: 600 }); // an iteration is 90 px: wide; a target is a point: narrow
    const groups = placed.filter((p) => p.node.kind === "group");
    expect(groups.map((g) => g.node.label)).toEqual(["… 7 targets ▸"]); // across the iterations between them
    expect(placed.filter((p) => p.node.label.startsWith("iteration")).every((p) => !p.tick)).toBe(true);
    expect(placed.filter((p) => p.node.label.startsWith("iteration"))).toHaveLength(6);
    // One narrow node alone is a tick.
    const lone = layoutRow(childNodes([rec("action", { op: "explore-target", event: "selected" }, 30, { parentId: start0.id })], 60, 60), { t0: 0, t1: 60, widthPx: 600 });
    expect(lone.placed.map((p) => [p.node.kind, p.tick])).toEqual([["record", true]]);
  });

  it("folds each op on its own: phases between iterations fold whatever the iterations do, and the wide iterations stay", () => {
    seq = 0;
    const start0 = start("a2", "explore", 0);
    const kids: TraceRecord[] = [];
    for (let i = 0; i < 4; i++) {
      kids.push(rec("action", { op: "explore-iteration", iteration: i + 1 }, i * 25, { parentId: start0.id }));
      for (let k = 0; k < 5; k++) kids.push(rec("action", { op: "phase", to: `p${k}` }, i * 25 + 0.1 * k, { parentId: start0.id }));
    }
    const { placed } = layoutRow(childNodes(kids, 100, 100), { t0: 0, t1: 100, widthPx: 600 });
    expect(placed.filter((p) => p.node.kind === "group").map((p) => p.node.label)).toEqual(["… 16 phases ▸"]); // the narrow phases of all four bursts: the wide iterations between them do not break the run
    expect(placed.filter((p) => p.node.label.startsWith("iteration"))).toHaveLength(4);
  });

  it("folds runs of narrow bars of one op into one node with its members, and keeps the wide ones", () => {
    seq = 0;
    const start0 = start("a2", "explore", 0);
    const iterations = Array.from({ length: 12 }, (_, i) => rec("action", { op: "explore-iteration", iteration: i + 1 }, i * 0.5, { parentId: start0.id }));
    const nodes = childNodes(iterations, 100, 6);
    const folded = layoutRow(nodes, { t0: 0, t1: 100, widthPx: 600 });
    expect(folded.placed).toHaveLength(1);
    expect(folded.placed[0]?.node).toMatchObject({ kind: "group", label: "… 12 iterations ▸" });
    expect(folded.placed[0]?.node.members).toHaveLength(12);
    // Stretched, the same nodes are wide enough to stay apart.
    expect(layoutRow(nodes, { t0: 0, t1: 6, widthPx: 600 }).placed).toHaveLength(12);
  });
});

describe("the children of a node", () => {
  it("turns phases and iterations into bars that last until the next one, labelled with the iteration and its target when the records say them", () => {
    seq = 0;
    const p = start("a", "explore", 0);
    const kids = [
      rec("action", { op: "explore-iteration", iteration: 1, target: { xM: 40, yM: 12 } }, 1, { parentId: p.id }),
      rec("action", { op: "phase", to: "planning" }, 1.1, { parentId: p.id }),
      rec("action", { op: "explore-iteration", iteration: 2 }, 4, { parentId: p.id }),
      rec("action", { op: "phase", to: "driving" }, 4.2, { parentId: p.id }),
    ];
    const nodes = childNodes(kids, 10, 8);
    const its = nodes.filter((n) => n.op === "explore-iteration");
    expect(its.map((n) => [n.label, n.t0, n.t1])).toEqual([["iteration 1 (40, 12)", 1, 4], ["iteration 2", 4, 8]]);
    expect(nodes.filter((n) => n.op === "phase").map((n) => [n.label, n.t0, n.t1])).toEqual([["phase · planning", 1.1, 4.2], ["phase · driving", 4.2, 8]]);
  });
});

describe("exploding and folding", () => {
  it("opens one branch at a time, folds the last opened node, and collapses all", () => {
    let path = explode([], 1, "s3");
    path = explode(path, 2, "b9");
    expect(path.map((p) => p.key)).toEqual(["s3", "b9"]);
    expect(explode(path, 1, "s7").map((p) => p.key)).toEqual(["s7"]); // another node of the first row replaces the branch
    expect(fold(path).map((p) => p.key)).toEqual(["s3"]);
    expect(collapseAll()).toEqual([]);
    expect(breadcrumb(["explore r 20 m", "iteration 6", "▲ obstacle"])).toBe("explore r 20 m › iteration 6 › ▲ obstacle");
  });

  it("a mission's chain is three levels: a decision opens into the action it started, which opens into its phases", () => {
    seq = 0;
    const decision = rec("thought", { op: "decision", step: 2, of: 4, decision: { name: "goTo" } }, 10);
    const startRec = start("a2", "goTo", 10.1, { xM: 50, yM: 20 }, { causeIds: [decision.id] });
    const phase = rec("action", { op: "phase", to: "following" }, 10.2, { parentId: startRec.id });
    const { commands } = rootNodes([decision], 30);
    expect(commands[0]?.canExplode).toBe(true);
    // Level 2: what the decision caused (read by its cause link), level 3: what the start has as children (by its parent link).
    const level2 = childNodes([startRec], 30);
    const level3 = childNodes([phase], 30, 20);
    expect(level2[0]).toMatchObject({ label: "goTo (50, 20)", canExplode: true });
    expect(level3[0]).toMatchObject({ label: "phase · following" });
    const path = explode(explode([], 0, commands[0]?.key as string), 2, level2[0]?.key as string);
    expect(path).toHaveLength(2);
  });
});

describe("the keyboard", () => {
  const node = (key: string, t0: number, seq: number): HistoryNode => ({ key, seq, record: undefined, kind: "record", label: key, glyph: "▪", t0, t1: t0, canExplode: false });
  const rows = [
    { index: 1, placed: [{ node: node("a", 0, 1), x: 0, w: 5, lane: 0, tick: false }, { node: node("b", 10, 2), x: 10, w: 5, lane: 0, tick: false }, { node: node("c", 20, 3), x: 20, w: 5, lane: 0, tick: false }] },
    { index: 2, placed: [{ node: node("d", 10, 4), x: 10, w: 5, lane: 0, tick: false }] },
  ];
  const path = [{ row: 1, key: "b" }];

  it("← → move along the row by time, ↓ goes to the row below, ↑ back to the node that was opened", () => {
    expect(navigate(rows, { row: 1, key: "a" }, "right", path)).toEqual({ row: 1, key: "b" });
    expect(navigate(rows, { row: 1, key: "b" }, "right", path)).toEqual({ row: 1, key: "c" });
    expect(navigate(rows, { row: 1, key: "c" }, "right", path)).toEqual({ row: 1, key: "c" }); // at the end it stays
    expect(navigate(rows, { row: 1, key: "b" }, "left", path)).toEqual({ row: 1, key: "a" });
    expect(navigate(rows, { row: 1, key: "b" }, "down", path)).toEqual({ row: 2, key: "d" });
    expect(navigate(rows, { row: 2, key: "d" }, "up", path)).toEqual({ row: 1, key: "b" });
    expect(navigate(rows, undefined, "right", path)).toEqual({ row: 1, key: "a" }); // nothing focused: the first node
  });
});

describe("the axis", () => {
  it("has round ticks in steps of 1, 2 or 5 and about as many as asked", () => {
    expect(timeTicks(0, 60, 6)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(timeTicks(35, 45, 5)).toEqual([36, 38, 40, 42, 44]);
    expect(timeTicks(0, 0, 5)).toEqual([]);
  });
});
