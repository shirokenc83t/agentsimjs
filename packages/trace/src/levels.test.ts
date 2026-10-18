import { contentHash64 } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { dropsRecord, filterRecord, metadataMindIo, summarizeCompute } from "./levels.ts";
import { RECORDING_PRESETS } from "./recording-profile.ts";
import type { TraceRecord } from "./trace-record.ts";

// F3a M2: level filters as pure functions (ADR-0035 §1, addition of 2026-10-17, items 1 and 2).

const base = { id: "run-000001#1", runId: "run-000001", seq: 1, simTime: 1, wallTime: 0, detail: "full" as const };
const rec = (kind: TraceRecord["kind"], source: string, payload: unknown): TraceRecord => ({ ...base, kind, source, agentId: "uav-001", payload });

const search = (path: string, waypoints?: number[][]) => ({ path, role: "plan", algorithm: "astar", heuristic: "octile", expansions: 40, result: "found", startedTick: 3, endedTick: 5, ...(waypoints ? { waypoints } : {}) });
const strategyPlan = (): TraceRecord =>
  rec("compute", "uav-001/planner", {
    op: "plan",
    queryId: "q1",
    algorithm: "strategy:fallback@1",
    status: "found",
    cost: 12.5,
    waypoints: [10, 11, 12],
    strategy: { id: "fallback", version: 1, hash: "ab", selects: [{ path: "/root", branch: 0, values: { straightM: 3 } }], searches: [search("/root/0", [[1, 2], [3, 4]]), search("/root/1", [[5, 6]]), search("/root/2")] },
  });
const request = (): TraceRecord =>
  rec("thought", "uav-001/s1", {
    op: "request",
    tick: 7,
    events: [{ kind: "start" }],
    eventsDropped: 0,
    self: { id: "uav-001", x: 1, y: 2, running: null },
    beliefs: { entities: [{ id: "e1" }] },
    space: "0123456789abcdef",
    allowed: { manifest: "fedcba9876543210", names: ["goTo"] },
    unavailable: [],
  });

describe("compute: summary", () => {
  it("drops the per-search waypoints of a strategy query and keeps everything else, still one record", () => {
    const full = strategyPlan();
    const out = summarizeCompute(full);
    const p = out.payload as { strategy: { searches: Record<string, unknown>[]; selects: unknown[] }; waypoints: number[] };
    expect(p.strategy.searches.map((s) => "waypoints" in s)).toEqual([false, false, false]);
    expect(p.strategy.searches.map((s) => [s.path, s.expansions, s.result, s.startedTick, s.endedTick])).toEqual([
      ["/root/0", 40, "found", 3, 5],
      ["/root/1", 40, "found", 3, 5],
      ["/root/2", 40, "found", 3, 5],
    ]);
    expect(p.strategy.selects).toEqual([{ path: "/root", branch: 0, values: { straightM: 3 } }]);
    expect(p.waypoints).toEqual([10, 11, 12]); // the query's own result is not a per-search geometry
    expect({ ...out, payload: undefined }).toEqual({ ...full, payload: undefined });
  });

  it("does not change the original record, and returns a plain query's record as it is", () => {
    const full = strategyPlan();
    const before = JSON.stringify(full);
    summarizeCompute(full);
    expect(JSON.stringify(full)).toBe(before);
    const plain = rec("compute", "uav-001/planner", { op: "plan", queryId: "q2", algorithm: "astar", waypoints: [1, 2] });
    expect(summarizeCompute(plain)).toBe(plain);
    const restart = rec("compute", "uav-001/planner", { op: "restart", queryId: "q1", reason: "read_set_overlap", spent: 4 });
    expect(summarizeCompute(restart)).toBe(restart);
  });
});

describe("mind-io: metadata", () => {
  it("replaces the self and beliefs bodies of a request by their content hash and keeps every reference", () => {
    const full = request();
    const out = metadataMindIo(full);
    const p = out.payload as Record<string, unknown>;
    const f = full.payload as Record<string, unknown>;
    expect(p.self).toBe(contentHash64(JSON.stringify(f.self)));
    expect(p.beliefs).toBe(contentHash64(JSON.stringify(f.beliefs)));
    for (const k of ["op", "tick", "events", "eventsDropped", "unavailable", "allowed", "space"]) expect(p[k], k).toEqual(f[k]);
    expect(Object.keys(p).sort()).toEqual(Object.keys(f).sort());
  });

  it("gives the same hash for the same content and another one for another", () => {
    const a = metadataMindIo(request()).payload as { self: string };
    const b = metadataMindIo(request()).payload as { self: string };
    expect(a.self).toBe(b.self);
    const changed = request();
    (changed.payload as { self: { x: number } }).self.x = 2;
    expect((metadataMindIo(changed).payload as { self: string }).self).not.toBe(a.self);
  });

  it("keeps a request without a beliefs body without one, writes space records unchanged, and does not change the original", () => {
    const noBeliefs = request();
    delete (noBeliefs.payload as Record<string, unknown>).beliefs;
    expect("beliefs" in (metadataMindIo(noBeliefs).payload as object)).toBe(false);
    const space = rec("thought", "uav-001/s1", { op: "space", hash: "0123456789abcdef", summary: "{...}" });
    expect(metadataMindIo(space)).toBe(space);
    const full = request();
    const before = JSON.stringify(full);
    metadataMindIo(full);
    expect(JSON.stringify(full)).toBe(before);
  });
});

describe("filterRecord and dropsRecord under a profile", () => {
  const vs = rec("event", "world/sim", { op: "belief-vs-truth", observer: true, map: "m", entities: [] });

  it("drops belief-vs-truth samples when beliefs is off, and only those", () => {
    expect(filterRecord(RECORDING_PRESETS.minimal, vs)).toBeUndefined();
    expect(dropsRecord(RECORDING_PRESETS.minimal, vs)).toBe(true);
    expect(filterRecord(RECORDING_PRESETS["default-research"], vs)).toBe(vs);
    expect(filterRecord(RECORDING_PRESETS.minimal, rec("event", "world/sim", { op: "other" }))).toBeDefined();
  });

  it("applies compute and mind-io levels by channel", () => {
    const strategy = strategyPlan();
    const req = request();
    expect(JSON.stringify(filterRecord(RECORDING_PRESETS.minimal, strategy))).not.toContain('"waypoints":[[');
    expect(filterRecord(RECORDING_PRESETS["default-research"], strategy)).toBe(strategy);
    expect((filterRecord(RECORDING_PRESETS.minimal, req)?.payload as { self: unknown }).self).toMatch(/^[0-9a-f]{16}$/);
    expect(filterRecord(RECORDING_PRESETS["debug-full"], req)).toBe(req);
  });

  it("keeps a record it cannot map as it is: nothing is lost on a gap in the table", () => {
    const odd = rec("protocol", "world/sim", { op: "x" });
    expect(filterRecord(RECORDING_PRESETS.minimal, odd)).toBe(odd);
  });

  it("never drops an events, transitions, compute or mind-io record, under any preset", () => {
    const samples = [
      rec("action", "uav-001/actions", { op: "start" }),
      rec("action", "uav-001/actions", { op: "leg" }),
      rec("plan-node", "uav-001/actions", {}),
      strategyPlan(),
      request(),
      rec("thought", "uav-001/s1", { op: "space", hash: "x", summary: "{}" }),
    ];
    for (const [name, p] of Object.entries(RECORDING_PRESETS)) for (const s of samples) expect(filterRecord(p, s), `${name} ${s.kind}`).toBeDefined();
  });
});
