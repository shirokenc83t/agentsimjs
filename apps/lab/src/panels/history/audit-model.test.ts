import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { AnalysisSeries } from "../analysis/analysis-model.ts";
import { auditCsv, auditFindings, auditRows, causeWords, recordWords, rowsInWindow } from "./audit-model.ts";
import { computeProvenance, metricProvenance, nearestPoint } from "./provenance.ts";

// The audit rows of one agent (reasons in words, what caused each action, sub-rows, the stop, idle) and where a chart value comes from.

let seq = 0;
const rec = (kind: TraceRecord["kind"], payload: unknown, simTime: number, extra: Partial<TraceRecord> = {}): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq: seq++, simTime, wallTime: 0, agentId: "ugv-007", source: "ugv-007/x", kind, payload, ...extra });

function mission(): TraceRecord[] {
  seq = 0;
  const d1 = rec("thought", { op: "decision", step: 1, of: 3, decision: { name: "goTo" } }, 0);
  const a1 = rec("action", { op: "start", actionId: "a1", name: "goTo", params: { xM: 50, yM: 20 } }, 0.1, { causeIds: [d1.id] });
  const e1 = rec("action", { op: "end", actionId: "a1", name: "goTo", status: "succeeded" }, 30);
  const d2 = rec("thought", { op: "decision", step: 2, of: 3, decision: { name: "explore" } }, 30.1);
  const a2 = rec("action", { op: "start", actionId: "a2", name: "explore", params: { radiusM: 15 } }, 30.2, { causeIds: [d2.id] });
  const reflex = rec("reflex", { reflex: "obstacle", code: "obstacle_ahead" }, 39.1);
  const replan = rec("action", { op: "replan", reason: "map_changed" }, 39.3, { parentId: a2.id, causeIds: [reflex.id] });
  const e2 = rec("action", { op: "end", actionId: "a2", name: "explore", status: "failed", failure: { code: "no_frontier", message: "no path to any frontier" } }, 52.3);
  const stop = rec("thought", { op: "decision", step: 2, of: 3, stop: { reason: "explore_failed" } }, 52.4);
  return [d1, a1, e1, d2, a2, reflex, replan, e2, stop];
}

describe("the audit rows", () => {
  it("has one row per action in time order with its outcome, duration, reason in words and what caused it", () => {
    const rows = auditRows(mission(), 60);
    const actions = rows.filter((r) => r.kind === "action");
    expect(actions.map((r) => [r.what, r.outcome, r.reason, r.causedBy])).toEqual([
      ["goTo (50, 20)", "✓ 29.9 s", "completed", "mission step 1 of 3 #0"],
      ["explore r 15 m", "✕ 22.1 s", "no path to any frontier", "mission step 2 of 3 #3"],
    ]);
  });

  it("puts reflexes and replans inside their action as indented sub-rows, the stop as its own row, and idle stretches as rows", () => {
    const rows = auditRows(mission(), 60);
    const order = rows.map((r) => `${r.level}${r.kind}`);
    expect(order.indexOf("1reflex")).toBeGreaterThan(order.indexOf("0action"));
    expect(rows.find((r) => r.kind === "reflex")).toMatchObject({ level: 1, reason: "obstacle ahead", glyph: "▲" });
    expect(rows.find((r) => r.kind === "replan")).toMatchObject({ level: 1, reason: "map changed", causedBy: "reflex obstacle ahead #5" });
    expect(rows.find((r) => r.kind === "stop")).toMatchObject({ level: 0, what: "mission stopped at step 2 of 3", reason: "explore failed", glyph: "■" });
    expect(rows.filter((r) => r.kind === "idle").map((r) => [r.t0, r.t1])).toEqual([[52.3, 60]]);
    // Time order throughout.
    expect(rows.map((r) => r.t0)).toEqual([...rows.map((r) => r.t0)].sort((a, b) => a - b));
  });

  it("says by what an action was preempted when a record says it, and what it was replaced by otherwise", () => {
    seq = 0;
    const a1 = rec("action", { op: "start", actionId: "a1", name: "explore", params: {} }, 0);
    const reflex = rec("reflex", { reflex: "battery", code: "battery_critical" }, 10);
    const e1 = rec("action", { op: "end", actionId: "a1", name: "explore", status: "preempted" }, 10, { causeIds: [reflex.id] });
    const a2 = rec("action", { op: "start", actionId: "a2", name: "goTo", params: {} }, 11);
    const e2 = rec("action", { op: "end", actionId: "a2", name: "goTo", status: "preempted" }, 20);
    const a3 = rec("action", { op: "start", actionId: "a3", name: "hold", params: {} }, 20.1);
    const rows = auditRows([a1, reflex, e1, a2, e2, a3], 30).filter((r) => r.kind === "action");
    expect(rows.map((r) => r.reason)).toEqual(["preempted by reflex battery critical #1", "replaced by hold", "still running when the record ends"]);
    expect(rows[0]?.causedBy).toBe("none recorded");
  });

  it("filters by the brush window (a row is in when it overlaps it), and exports the table as CSV", () => {
    const rows = auditRows(mission(), 60);
    const inWin = rowsInWindow(rows, { t0: 30, t1: 60 });
    expect(inWin.some((r) => r.what.startsWith("goTo"))).toBe(true); // it ends at 30: it touches the window
    expect(rowsInWindow(rows, { t0: 40, t1: 50 }).filter((r) => r.kind === "action").map((r) => r.what)).toEqual(["explore r 15 m"]);
    expect(rowsInWindow(rows, undefined)).toHaveLength(rows.length);
    const csv = auditCsv(rows).split("\n");
    expect(csv[0]).toBe("t0_s,t1_s,level,kind,what,outcome,reason,caused_by,seq");
    expect(csv).toHaveLength(rows.length + 1);
    expect(csv.find((l) => l.includes("explore r 15 m"))).toContain('"no path to any frontier"');
  });

  it("says in one line what the agent did, and only what the records hold", () => {
    const records = mission();
    const line = auditFindings("ugv-007", auditRows(records, 60), records);
    expect(line).toContain("ugv-007 ran 2 actions in 52.0 s");
    expect(line).toContain("goTo ✓");
    expect(line).toContain("explore ✕ failed at 52.3 s (no path to any frontier)");
    expect(line).toContain("the mission stopped at step 2 of 3 at 52.4 s");
    expect(line).toContain("one reflex at 39.1 s");
    expect(auditFindings("ugv-009", [], [])).toBe("ugv-009 has no recorded actions.");
  });

  it("names a record in words, and a cause that was not read by its number", () => {
    const records = mission();
    expect(recordWords(records[0] as TraceRecord)).toBe("mission step 1 of 3 #0");
    expect(recordWords(records[5] as TraceRecord)).toBe("reflex obstacle ahead #5");
    expect(causeWords({ ...(records[1] as TraceRecord), causeIds: ["run-000001#99"] }, new Map())).toBe("record #99");
  });
});

describe("where a chart value comes from", () => {
  const compute = (n: number): AnalysisSeries => ({ key: "k", agentId: "ugv-007", name: "planner expansions", unit: "per query", source: "compute", points: [{ t: 39.2, v: 184, seq: n, tick: 392 }] });

  it("follows a planner point: the compute record, its causes, then its parent and what caused that", async () => {
    seq = 0;
    const decision = rec("thought", { op: "decision", step: 2, of: 3, decision: { name: "explore" } }, 30);
    const startRec = rec("action", { op: "start", actionId: "a2", name: "explore", params: {} }, 30.2, { causeIds: [decision.id] });
    const obstacle = rec("event", { op: "collision-risk" }, 39);
    const reflex = rec("reflex", { reflex: "obstacle", code: "obstacle_ahead" }, 39.1, { causeIds: [obstacle.id] });
    const plan = rec("compute", { op: "plan", expansionsCharged: 184 }, 39.2, { causeIds: [reflex.id], parentId: startRec.id });
    const all = new Map([decision, startRec, obstacle, reflex, plan].map((r) => [r.seq, r] as const));
    const p = await computeProvenance(compute(plan.seq), { t: 39.2, v: 184, seq: plan.seq, tick: 392 }, async (s) => all.get(s));
    expect(p.kind).toBe("compute");
    expect(p.seq).toBe(plan.seq);
    expect(p.lead).toBe("184 expansions at 39.2 s is one compute record: the plan ugv-007 made after reflex obstacle ahead.");
    expect(p.chain.map((c) => `${c.relation}:${c.label}`)).toEqual([
      "value:compute plan #4 · tick 392",
      "cause:reflex obstacle ahead #3",
      "cause:event collision-risk #2",
      "parent:explore #1",
      "cause:mission step 2 of 3 #0",
    ]);
  });

  it("says so when the record is not read, and for a point of a metric gives the sample, its tick and rate, and that the line is drawn", async () => {
    const p = await computeProvenance(compute(7), { t: 39.2, v: 184, seq: 7 }, async () => undefined);
    expect(p.chain).toEqual([]);
    expect(p.lead).toContain("its record is not in the part of the run that was read");
    const speed: AnalysisSeries = { key: "k", agentId: "ugv-007", name: "speed", unit: "m/s", source: "metric", points: [{ t: 37, v: 2, tick: 370 }, { t: 38, v: 2, tick: 380 }, { t: 39, v: 0, tick: 390 }, { t: 40, v: 2, tick: 400 }] };
    const m = metricProvenance(speed, speed.points[2] as { t: number; v: number }, 0.1);
    expect(m.lead).toBe("0 m/s is the sample of agent.speedMps at tick 390 (every 1.0 s); the line to 2 m/s at 40.0 s is drawn straight between two samples, it is not measured.");
    expect(m.chain).toEqual([{ relation: "value", label: "agent.speedMps sample · tick 390", seq: undefined, tick: 390 }]);
  });

  it("finds the nearest point to a click", () => {
    const pts = [{ t: 1, v: 1 }, { t: 5, v: 2 }, { t: 9, v: 3 }];
    expect(nearestPoint(pts, 4)?.t).toBe(5);
    expect(nearestPoint(pts, 3)?.t).toBe(1);
    expect(nearestPoint([], 3)).toBeUndefined();
  });
});
