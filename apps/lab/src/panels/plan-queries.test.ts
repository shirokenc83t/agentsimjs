import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { PlanQueryIndex } from "./plan-queries.ts";

let seq = 0;
const rec = (agentId: string, kind: string, payload: unknown, runId = "run-000001"): TraceRecord =>
  ({ id: `${runId}#${seq}`, runId, seq: seq++, simTime: seq * 0.1, wallTime: 0, kind, agentId, source: `${agentId}/planner`, detail: "full", payload }) as unknown as TraceRecord;

const strategy = {
  id: "short-astar-long-hpa",
  version: 1,
  hash: "abcd1234",
  selects: [{ path: "/root", branch: "else", values: { "dist.m": 310.5 } }],
  searches: [{ path: "/root/else", role: "plain", algorithm: "hpa", heuristic: "euclidean", expansions: 1200, result: "found", startedTick: 5, endedTick: 9, waypoints: [[1, 1], [60.5, 60.5]] }],
};

const plan = (agentId: string, queryId: string, over: Record<string, unknown> = {}) =>
  rec(agentId, "compute", { op: "plan", queryId, algorithm: "strategy:short-astar-long-hpa@1", status: "found", expansionsCharged: 1200, submittedTick: 5, completedTick: 9, restarts: 0, waypoints: [[1, 1], [60.5, 60.5]], strategy, ...over });

describe("PlanQueryIndex: planning queries from trace records (UI-SPEC, Inspector query table)", () => {
  it("assembles a strategy query: status, ticks, branch with its condition values, each search with its geometry", () => {
    const idx = new PlanQueryIndex();
    idx.ingest([plan("ugv-001", "q-1")]);
    const [q] = idx.queries("ugv-001");
    expect(q).toMatchObject({ queryId: "q-1", status: "found", submittedTick: 5, completedTick: 9, expansionsCharged: 1200, interruptions: 0 });
    expect(q?.strategy?.selects[0]).toEqual({ path: "/root", branch: "else", values: { "dist.m": 310.5 } });
    expect(q?.strategy?.searches[0]).toMatchObject({ role: "plain", algorithm: "hpa", expansions: 1200, result: "found", waypoints: [[1, 1], [60.5, 60.5]] });
  });

  it("a plain query has no strategy; restarts and interruptions are counted in order", () => {
    const idx = new PlanQueryIndex();
    idx.ingest([
      rec("ugv-001", "compute", { op: "restart", queryId: "q-1", reason: "map_changed", spent: 40 }),
      rec("ugv-001", "compute", { op: "plan", queryId: "q-1", algorithm: "astar", status: "found", expansionsCharged: 90, submittedTick: 1, completedTick: 4, waypoints: [[0, 0], [5, 5]] }),
    ]);
    const [q] = idx.queries("ugv-001");
    expect(q?.strategy).toBeUndefined();
    expect(q?.restarts).toEqual([expect.objectContaining({ reason: "map_changed", spent: 40, interrupted: false })]);
    expect(q?.status).toBe("found");
  });

  it("a lazy query: legs by query id, then an interruption (no plan record) marks it interrupted", () => {
    const idx = new PlanQueryIndex();
    idx.ingest([
      rec("ugv-001", "action", { op: "leg", queryId: "q-1", index: 0, count: 3, last: false, tick: 12, mapVersion: 4 }),
      rec("ugv-001", "action", { op: "leg", queryId: "q-1", index: 1, count: 3, last: false, tick: 20, mapVersion: 4 }),
      rec("ugv-001", "compute", { op: "restart", queryId: "q-1", reason: "map_changed", spent: 300, interrupted: true }),
      rec("ugv-001", "action", { op: "replan", queryId: "q-1", reason: "map_changed", interrupted: true }),
      rec("ugv-001", "action", { op: "leg", queryId: "q-2", index: 0, count: 1, last: true, tick: 40, mapVersion: 5 }),
    ]);
    const [a, b] = idx.queries("ugv-001");
    expect([a?.queryId, a?.status, a?.interruptions, a?.legs.map((l) => l.index)]).toEqual(["q-1", "interrupted", 1, [0, 1]]);
    expect([b?.queryId, b?.status, b?.legs.length]).toEqual(["q-2", "running", 1]);
  });

  it("agents are independent, and rows come back in the order the queries started", () => {
    const idx = new PlanQueryIndex();
    idx.ingest([plan("uav-001", "q-1"), plan("ugv-001", "q-1"), plan("ugv-001", "q-2")]);
    expect(idx.queries("uav-001").map((q) => q.queryId)).toEqual(["q-1"]);
    expect(idx.queries("ugv-001").map((q) => q.queryId)).toEqual(["q-1", "q-2"]);
    expect(idx.queries("nobody")).toEqual([]);
  });

  it("is incremental: batches in any split give the rows of one pass, and an unchanged agent keeps the same array", () => {
    const all = [
      rec("ugv-001", "compute", { op: "restart", queryId: "q-1", reason: "map_changed", spent: 10 }),
      plan("ugv-001", "q-1"),
      plan("uav-001", "q-1"),
      rec("ugv-001", "action", { op: "leg", queryId: "q-2", index: 0, count: 2, last: false, tick: 3 }),
      plan("ugv-001", "q-2", { status: "budget_exceeded" }),
    ];
    const whole = new PlanQueryIndex();
    whole.ingest(all);
    const parts = new PlanQueryIndex();
    for (let n = 1; n <= all.length; n++) parts.ingest(all.slice(0, n)); // the list grows, as the client's does
    for (const id of ["ugv-001", "uav-001"]) expect(parts.queries(id)).toEqual(whole.queries(id));
    const before = parts.queries("uav-001");
    expect(parts.ingest(all)).toEqual(new Set()); // nothing new
    expect(parts.queries("uav-001")).toBe(before);
    const changed = parts.ingest([...all, plan("ugv-001", "q-3")]);
    expect([...changed]).toEqual(["ugv-001"]);
    expect(parts.queries("uav-001")).toBe(before);
  });

  it("copes with the client trimming the oldest records, and resets for another run", () => {
    const idx = new PlanQueryIndex();
    const a = [plan("ugv-001", "q-1"), plan("ugv-001", "q-2"), plan("ugv-001", "q-3")];
    idx.ingest(a);
    idx.ingest(a.slice(1)); // trimmed head: rows already read stay
    expect(idx.queries("ugv-001").length).toBe(3);
    idx.ingest([rec("ugv-001", "compute", { op: "plan", queryId: "q-1", algorithm: "astar", status: "found" }, "run-000002")]);
    expect(idx.queries("ugv-001").map((q) => q.queryId)).toEqual(["q-1"]);
    idx.ingest([]);
    expect(idx.queries("ugv-001")).toEqual([]);
  });

  it("ignores malformed payloads instead of throwing (records are data from the worker)", () => {
    const idx = new PlanQueryIndex();
    expect(() => idx.ingest([rec("ugv-001", "compute", null), rec("ugv-001", "compute", { op: "plan" }), rec("ugv-001", "compute", { op: "plan", queryId: "q-1", strategy: { id: 7 }, waypoints: "x" })])).not.toThrow();
    expect(idx.queries("ugv-001").map((q) => q.strategy)).toEqual([undefined]);
  });
});
