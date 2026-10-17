import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { PlanningService, type PlanningConfig, type PlanOutcome, type PlanRequest } from "./planning-service.ts";

/**
 * Live planning views and the read-set rule (ADR-0024 additions of 2026-10-09 and 2026-10-10).
 */
const UGV = { vehicle: "ugv" as const, cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 };
const cfg = (o: Partial<PlanningConfig> = {}): PlanningConfig => ({ algorithm: { kind: "astar" }, onboardComputeExpansionsPerTick: 100, totalBudget: 1_000_000, ...o });
const req = (from: [number, number], to: [number, number], c = cfg()): PlanRequest => ({ agentId: "ugv-001", traversal: UGV, config: c, from: { x: from[0] + 0.5, y: from[1] + 0.5 }, to: { x: to[0] + 0.5, y: to[1] + 0.5 } });

const grid = () => new GridSpace({ sizeX: 96, sizeY: 64, resolutionM: 1, chunkSize: 16 });
/** A wall at column x for rows [j0, j1). */
const wall = (g: GridSpace, x: number, j0: number, j1: number) => {
  for (let j = j0; j < j1; j++) g.setCell("occupancy", x, j, OCCUPANCY_BLOCKED);
};

function finish(s: PlanningService, from: number): PlanOutcome {
  for (let t = from; t < from + 5000; t++) {
    s.tick(t);
    const o = s.takeCompleted()[0];
    if (o) return o;
  }
  throw new Error("no completion");
}

const strip = (o: PlanOutcome) => ({ status: o.status, cells: o.cells, cost: o.cost, expansionsCharged: o.expansionsCharged, completedTick: o.completedTick });

describe("live planning views and the read-set rule", () => {
  it.each([true, false])("a query that continues across view versions equals a cold run on the final view (caches %s)", (cachesEnabled) => {
    // Live: walls appear far ahead of the search (unread chunks) at ticks 2 and 4.
    const g = grid();
    const s = new PlanningService(g, { cachesEnabled });
    s.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "dijkstra" } })), 1);
    s.tick(1);
    wall(g, 80, 10, 50);
    s.tick(2);
    s.tick(3);
    wall(g, 70, 20, 64);
    const live = finish(s, 4);
    expect(live.restarts).toBe(0);
    expect(live.continuations).toBe(2);
    // Cold: the same query on the final world from the start, submitted at the same tick.
    const g2 = grid();
    wall(g2, 80, 10, 50);
    wall(g2, 70, 20, 64);
    const cold = new PlanningService(g2, { cachesEnabled });
    cold.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "dijkstra" } })), 1);
    expect(strip(live)).toEqual(strip(finish(cold, 1)));
  });

  it.each([true, false])("snapshot mid-query after a continued change, restore, finish: same outcome (caches %s)", (cachesEnabled) => {
    const g = grid();
    const s = new PlanningService(g, { cachesEnabled });
    s.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "dijkstra" } })), 1);
    s.tick(1);
    wall(g, 80, 10, 50);
    s.tick(2); // continues
    s.tick(3);
    const snap = s.snapshot();
    const reference = finish(s, 4);
    // Restore on a fresh service over the same world (stamps are derived data: rebuilt, not restored).
    const r = new PlanningService(g, { cachesEnabled });
    r.restore(snap);
    const restored = finish(r, 4);
    expect({ ...strip(restored), restarts: restored.restarts, continuations: restored.continuations }).toEqual({ ...strip(reference), restarts: reference.restarts, continuations: reference.continuations });
  });

  it("restarts are reported with their reason and the overlapping chunks; the outcome counts them", () => {
    const g = grid();
    const s = new PlanningService(g);
    s.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "dijkstra" } })), 1);
    s.tick(1);
    wall(g, 4, 20, 40); // through what it read (chunk 0, row 2)
    const o = finish(s, 2);
    // The wall's chunks 6 and 12 (6 chunks per row); chunk 12 holds the start.
    expect(s.takeRestarts()).toEqual([{ queryId: "plan-000001", agentId: "ugv-001", tick: 2, reason: "read_set_overlap", chunks: [6, 12], spent: 100 }]);
    expect([o.restarts, o.continuations]).toEqual([1, 0]);
    expect(o.expansionsCharged).toBeGreaterThan(100); // cumulative: the first attempt's 100 count
  });

  it("a cell that flips at every update next to the start restarts the query until the cumulative charge reaches totalBudget", () => {
    const g = grid();
    const s = new PlanningService(g);
    s.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "dijkstra" }, totalBudget: 1000 })), 1);
    let o: PlanOutcome | undefined;
    const reasons: string[] = [];
    for (let t = 1; t < 100 && !o; t++) {
      g.setCell("occupancy", 3, 33, t % 2); // flips every tick, next to the start
      s.tick(t);
      for (const r of s.takeRestarts()) reasons.push(`${r.reason}@${r.spent}`);
      o = s.takeCompleted()[0];
    }
    expect(o?.status).toBe("budget_exceeded");
    expect(o?.expansionsCharged).toBe(1000);
    expect(reasons.length).toBe(o?.restarts);
    expect(reasons.every((r) => r.startsWith("read_set_overlap@"))).toBe(true);
    expect(reasons.at(-1)).toBe("read_set_overlap@1000");
  });

  it("an HPA* query restarts on any change to its graph (graph_changed)", () => {
    const g = grid();
    const s = new PlanningService(g);
    s.submit(req([2, 32], [90, 32], cfg({ algorithm: { kind: "hpa" } })), 1);
    s.tick(1);
    expect(s.takeCompleted()).toEqual([]); // still in progress after one 100-expansion slice
    wall(g, 80, 10, 50);
    s.tick(2);
    expect(s.takeRestarts().map((r) => r.reason)).toEqual(["graph_changed"]);
    expect(finish(s, 3).status).toBe("found");
  });
});
