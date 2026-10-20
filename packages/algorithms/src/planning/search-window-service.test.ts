import type { GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import type { StrategyNode } from "./strategy/schema.ts";
import { randomGrid, UGV } from "../testing/fixtures.ts";
import { PlanningService, type PlanOutcome, type PlanningConfig, type PlanRequest, type SearchWindow } from "./planning-service.ts";

// ADR-0024 addition and ADR-0040: a planner query may carry a search window. The service passes it to the search, the result-cache key includes it,
// and a snapshot of a query in flight carries it (it is part of the request).

const cfg = (over: Partial<PlanningConfig> = {}): PlanningConfig => ({ algorithm: { kind: "astar" }, onboardComputeExpansionsPerTick: 100, totalBudget: 1_000_000, ...over });
const req = (to: [number, number], window?: SearchWindow, config = cfg()): PlanRequest => ({
  agentId: "ugv-001",
  traversal: UGV,
  config,
  from: { x: 3.5, y: 3.5 },
  to: { x: to[0] + 0.5, y: to[1] + 0.5 },
  ...(window ? { window } : {}),
});

function grid(): GridSpace {
  const g = randomGrid(8, 64, 0.15, 16);
  for (const [i, j] of [[3, 3], [50, 50], [40, 12], [10, 10]] as const) {
    g.setCell("occupancy", i, j, 0);
    g.setCell("terrainCost", i, j, 10);
  }
  return g;
}

function finish(s: PlanningService, from = 1): PlanOutcome {
  for (let t = from; t < from + 5000; t++) {
    s.tick(t);
    const o = s.takeCompleted()[0];
    if (o) return o;
  }
  throw new Error("no completion");
}

const semantic = (o: PlanOutcome) => ({ status: o.status, cells: o.cells, cost: o.cost, expansionsCharged: o.expansionsCharged, completedTick: o.completedTick, restarts: o.restarts });

describe("planner queries with a search window", () => {
  it("never leave the window, and end not_found when the goal is outside it", () => {
    const w = { i0: 0, j0: 0, i1: 20, j1: 20 };
    const s = new PlanningService(grid());
    expect(s.submit(req([50, 50], w), 1).ok).toBe(true);
    const o = finish(s);
    expect(o.status).toBe("not_found");
    expect(o.expansionsCharged).toBeLessThanOrEqual(20 * 20);
  });

  it("find the unwindowed path when it lies inside the window", () => {
    const free = new PlanningService(grid());
    free.submit(req([10, 10]), 1);
    const a = finish(free);
    expect(a.status).toBe("found");
    const w = { i0: 0, j0: 0, i1: 64, j1: 64 };
    const windowed = new PlanningService(grid());
    windowed.submit(req([10, 10], w), 1);
    expect(semantic(finish(windowed))).toEqual(semantic(a));
  });

  it("key the result cache by the window: the same endpoints in another window never share an answer", () => {
    const g = grid();
    const s = new PlanningService(g, { cachesEnabled: true });
    const inside = { i0: 0, j0: 0, i1: 64, j1: 64 };
    const tight = { i0: 0, j0: 0, i1: 6, j1: 6 };
    const results: PlanOutcome[] = [];
    let tick = 1;
    for (const w of [inside, tight, inside, tight]) {
      expect(s.submit(req([10, 10], w), tick).ok).toBe(true);
      const o = finish(s, tick);
      results.push(o);
      tick = o.completedTick + 1;
    }
    expect(results.map((o) => o.status)).toEqual(["found", "not_found", "found", "not_found"]);
    expect(results[2]?.cacheHit).toBe(true);
    expect(results[3]?.cacheHit).toBe(true);
    // The same four with caches off give the same outcomes and ticks (a cache hit is charged what the search cost).
    const off = new PlanningService(g, { cachesEnabled: false });
    tick = 1;
    const offResults: PlanOutcome[] = [];
    for (const w of [inside, tight, inside, tight]) {
      off.submit(req([10, 10], w), tick);
      const o = finish(off, tick);
      offResults.push(o);
      tick = o.completedTick + 1;
    }
    expect(offResults.map(semantic)).toEqual(results.map(semantic));
  });

  it("restore a windowed query in flight with the same outcome and ticks", () => {
    const g = grid();
    const w = { i0: 0, j0: 0, i1: 60, j1: 60 };
    const live = new PlanningService(g);
    live.submit(req([50, 50], w), 1);
    live.tick(1);
    live.tick(2);
    const snap = JSON.parse(JSON.stringify(live.snapshot())) as ReturnType<PlanningService["snapshot"]>;
    expect(snap.active[0]?.request.window).toEqual(w);
    expect(snap.active[0]?.charged).toBeGreaterThan(0);
    const expected = finish(live, 3);
    const restored = new PlanningService(g, { cachesEnabled: false });
    restored.restore(snap);
    expect(restored.snapshot()).toEqual(snap);
    expect(semantic(finish(restored, 3))).toEqual(semantic(expected));
  });

  it("restore a windowed strategy query in flight", () => {
    const g = grid();
    const w = { i0: 0, j0: 0, i1: 60, j1: 60 };
    const config = cfg({ strategy: { id: "t", version: 1, hash: "0000abcd", root: { kind: "algorithm", algorithm: "astar" } as unknown as StrategyNode } });
    const live = new PlanningService(g);
    const r = live.submit(req([50, 50], w, config), 1);
    if (!r.ok) throw new Error(r.error.message);
    live.tick(1);
    live.tick(2);
    const snap = JSON.parse(JSON.stringify(live.snapshot())) as ReturnType<PlanningService["snapshot"]>;
    expect(snap.active[0]?.request.window).toEqual(w);
    const expected = finish(live, 3);
    const restored = new PlanningService(g, { cachesEnabled: false });
    restored.restore(snap);
    expect(semantic(finish(restored, 3))).toEqual(semantic(expected));
  });

  it("refuse an empty window or one outside the map", () => {
    const s = new PlanningService(grid());
    for (const w of [{ i0: 5, j0: 0, i1: 5, j1: 10 }, { i0: -1, j0: 0, i1: 10, j1: 10 }, { i0: 0, j0: 0, i1: 65, j1: 10 }, { i0: 0.5, j0: 0, i1: 10, j1: 10 }]) {
      const r = s.submit(req([10, 10], w), 1);
      expect(r.ok).toBe(false);
    }
  });

  it("leave a query without a window as it was: the same result key and the same snapshot", () => {
    const s = new PlanningService(grid());
    s.submit(req([10, 10]), 1);
    s.tick(1);
    expect("window" in (s.snapshot().active[0]?.request ?? {})).toBe(false);
  });
});
