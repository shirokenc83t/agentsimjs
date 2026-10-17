import { OCCUPANCY_BLOCKED, type GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { isValidPath, randomGrid, UGV } from "../testing/fixtures.ts";
import { PlanningService, type LazyPlanLeg, type LazyPlanProgress, type PlanOutcome, type PlanningConfig, type PlanRequest } from "./planning-service.ts";
import type { StrategyNode } from "./strategy/schema.ts";

// ADR-0037 fourth addition (F2b M3): a lazy refine hands out each leg when its search completes, keeps planning after the first
// leg, is interrupted (not restarted) by a map change once a leg is out, and snapshots/restores mid-leg.

const algo = (algorithm: string, extra: Record<string, unknown> = {}) => ({ kind: "algorithm", algorithm, ...extra }) as unknown as StrategyNode;
const refine = (mode: "lazy" | "eager") => ({ kind: "refine", mode, coarse: algo("hpa"), local: algo("astar") }) as unknown as StrategyNode;
const cfg = (root: StrategyNode, over: Partial<PlanningConfig> = {}): PlanningConfig => ({
  algorithm: { kind: "astar" },
  onboardComputeExpansionsPerTick: 100,
  totalBudget: 1_000_000,
  strategy: { id: "lazy-test", version: 1, hash: "0000abcd", root },
  ...over,
});
const req = (config: PlanningConfig, agentId = "ugv-001"): PlanRequest => ({ agentId, traversal: UGV, config, from: { x: 1.5, y: 1.5 }, to: { x: 60.5, y: 60.5 } });

function workloadGrid(): GridSpace {
  const g = randomGrid(8, 64, 0.18, 16);
  for (const [i, j] of [[1, 1], [60, 60], [5, 5], [30, 30]] as [number, number][]) {
    g.setCell("occupancy", i, j, 0);
    g.setCell("terrainCost", i, j, 10);
  }
  return g;
}

interface Taken {
  readonly tick: number;
  readonly legs: readonly LazyPlanLeg[];
  readonly progress: LazyPlanProgress;
}
/** Ticks the service, reading the legs of `queryId` each tick; returns what was taken when, and the final outcome. */
function drive(service: PlanningService, queryId: string, agentId: string, from: number, to: number, between?: (tick: number) => void): { taken: Taken[]; outcome: PlanOutcome | undefined } {
  const taken: Taken[] = [];
  let outcome: PlanOutcome | undefined;
  for (let t = from; t <= to; t++) {
    between?.(t);
    service.tick(t);
    const p = service.takeLegs(agentId, queryId);
    if (p) taken.push({ tick: t, legs: p.legs, progress: p });
    outcome ??= service.takeCompleted().find((o) => o.agentId === agentId);
    if (p?.done) break;
  }
  return { taken, outcome };
}
const flatLegs = (taken: readonly Taken[]) => taken.flatMap((t) => t.legs.map((l) => ({ ...l, takenAt: t.tick })));

describe("lazy refine through the service", () => {
  it("is the eager query with its legs handed out early: the same whole-query outcome", () => {
    const grid = workloadGrid();
    const eagerService = new PlanningService(grid);
    const sub = eagerService.submit(req(cfg(refine("eager"))), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    let eager: PlanOutcome | undefined;
    for (let t = 1; t < 5000 && !eager; t++) {
      eagerService.tick(t);
      eager = eagerService.takeCompleted()[0];
    }
    const lazyService = new PlanningService(grid);
    const lsub = lazyService.submit(req(cfg(refine("lazy"))), 1);
    if (!lsub.ok) throw new Error(lsub.error.message);
    const { outcome: lazy } = drive(lazyService, lsub.value, "ugv-001", 1, 5000);
    expect(lazy && { ...lazy, queryId: "", cacheHit: false, strategy: undefined, space: undefined }).toEqual(eager && { ...eager, queryId: "", cacheHit: false, strategy: undefined, space: undefined });
    expect(lazy?.strategy?.searches).toEqual(eager?.strategy?.searches);
  });

  it("hands out the first leg earlier than eager finishes, one leg per search, in order, once each", () => {
    const grid = workloadGrid();
    const eagerService = new PlanningService(grid);
    eagerService.submit(req(cfg(refine("eager"))), 1);
    let eager: PlanOutcome | undefined;
    for (let t = 1; t < 5000 && !eager; t++) {
      eagerService.tick(t);
      eager = eagerService.takeCompleted()[0];
    }
    const s = new PlanningService(grid);
    const sub = s.submit(req(cfg(refine("lazy"))), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    const { taken, outcome } = drive(s, sub.value, "ugv-001", 1, 5000);
    const legs = flatLegs(taken);
    expect(legs.length).toBeGreaterThan(2);
    // The first leg is out strictly before the whole path would be ready (eager's completion tick), and the legs come in the ticks their searches ended.
    expect(legs[0]?.takenAt).toBeLessThan(eager?.completedTick ?? 0);
    expect(legs.map((l) => l.index)).toEqual(legs.map((_, k) => k));
    expect(legs.map((l) => l.tick)).toEqual((outcome?.strategy?.searches ?? []).filter((x) => x.role === "leg").map((x) => x.endedTick));
    expect(taken.at(-1)?.progress).toMatchObject({ done: true, status: "found" });
    expect(taken.slice(0, -1).every((t) => !t.progress.done)).toBe(true);
    // The legs are the eager legs: joined, they are eager's path (as metre waypoints of each leg's cells).
    expect(outcome?.cells).toEqual(eager?.cells);
    expect(legs.at(-1)?.waypoints.at(-1)).toEqual([60.5, 60.5]);
    // Each leg is handed out once; a second call finds nothing, and a plain query has no legs at all.
    expect(s.takeLegs("ugv-001", sub.value)).toBeUndefined();
    const plain = new PlanningService(grid);
    const q = plain.submit(req(cfg(refine("eager"))), 1);
    if (!q.ok) throw new Error(q.error.message);
    plain.tick(1);
    expect(plain.takeLegs("ugv-001", q.value)).toBeUndefined();
  });

  it("legs are real paths on the view: each leg's cells are valid moves and start where the previous one ended", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const sub = s.submit(req(cfg(refine("lazy"))), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    const { outcome } = drive(s, sub.value, "ugv-001", 1, 5000);
    const view = new PlanningService(grid).view(undefined, UGV, cfg(refine("eager")));
    if (!view.ok) throw new Error("no view");
    expect(outcome && isValidPath(view.value, outcome.cells)).toBe(true);
  });

  it("a failing leg ends the query with its status: legs before it were handed out, none is the last", () => {
    // A map where the coarse path exists but a leg cannot be planned: the strategy's local stage has a tiny budget.
    const grid = workloadGrid();
    const root = { kind: "refine", mode: "lazy", coarse: algo("hpa"), local: algo("astar", { stageBudget: 100 }) } as unknown as StrategyNode;
    const s = new PlanningService(grid);
    const sub = s.submit(req(cfg(root, { totalBudget: 100_000 })), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    const { taken, outcome } = drive(s, sub.value, "ugv-001", 1, 5000);
    const last = taken.at(-1)?.progress;
    expect(last?.done).toBe(true);
    if (outcome?.status === "found") return; // every leg fit in 100 expansions on this map: nothing to assert about failure
    expect(last?.status).toBe(outcome?.status);
    expect(outcome?.status).not.toBe("found");
  });
});

describe("a lazy plan always ends: the cumulative totalBudget bounds the hold (ADR-0037 sixth addition)", () => {
  it("with a budget that covers the coarse path and the first leg only, the query ends budget_exceeded within the bound, after that one leg", () => {
    const grid = workloadGrid();
    const full = new PlanningService(grid);
    const fsub = full.submit(req(cfg(refine("lazy"))), 1);
    if (!fsub.ok) throw new Error(fsub.error.message);
    const { outcome } = drive(full, fsub.value, "ugv-001", 1, 5000);
    const searches = outcome?.strategy?.searches ?? [];
    const upToFirstLeg = searches.filter((x, k) => x.role === "coarse" || k <= searches.findIndex((y) => y.role === "leg")).reduce((a, x) => a + x.expansions, 0);
    expect(searches.filter((x) => x.role === "leg").length).toBeGreaterThan(2);
    const perTick = 100;
    const totalBudget = Math.max(perTick, upToFirstLeg + 1);
    const s = new PlanningService(grid);
    const sub = s.submit(req(cfg(refine("lazy"), { totalBudget, onboardComputeExpansionsPerTick: perTick })), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    const { taken } = drive(s, sub.value, "ugv-001", 1, 5000);
    const end = taken.at(-1)?.progress;
    expect(end).toMatchObject({ done: true, status: "budget_exceeded" });
    expect(flatLegs(taken).length).toBe(1); // only the first leg fitted
    // The bound: every tick spends its per-tick budget until the total is gone, plus at most one tick per search to notice an end.
    expect(end?.expansionsCharged).toBeLessThanOrEqual(totalBudget);
    expect((end?.completedTick ?? 0) - 1).toBeLessThanOrEqual(Math.ceil(totalBudget / perTick) + searches.length);
  });
});

describe("a map change under a lazy query", () => {
  const lazy = () => req(cfg(refine("lazy"), { onboardComputeExpansionsPerTick: 100 }));

  it("before the first leg is out it restarts like any strategy (nothing has left the planner)", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const sub = s.submit(lazy(), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    s.tick(1);
    grid.setCell("occupancy", 3, 3, OCCUPANCY_BLOCKED); // next to the start, in the coarse search's read set
    const { taken, outcome } = drive(s, sub.value, "ugv-001", 2, 5000);
    const events = s.takeRestarts();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => (e.reason === "read_set_overlap" || e.reason === "graph_changed") && e.interrupted === undefined)).toBe(true);
    expect(outcome?.restarts).toBeGreaterThanOrEqual(1);
    expect(taken.at(-1)?.progress.done).toBe(true);
    expect(taken.at(-1)?.progress.interrupted).toBeUndefined();
  });

  it("after a leg is out, a change in a chunk that was read interrupts the query: no restart, the action replans from where it is", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const sub = s.submit(lazy(), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    let firstLegTick = 0;
    for (let t = 1; t < 5000 && firstLegTick === 0; t++) {
      s.tick(t);
      const p = s.takeLegs("ugv-001", sub.value);
      if (p?.legs.length) firstLegTick = t;
    }
    expect(firstLegTick).toBeGreaterThan(0);
    s.takeRestarts();
    grid.setCell("occupancy", 3, 3, OCCUPANCY_BLOCKED); // the first leg's search certainly read the chunk around the start
    s.tick(firstLegTick + 1);
    const p = s.takeLegs("ugv-001", sub.value);
    expect(p).toMatchObject({ done: true, interrupted: "map_changed", legs: [] });
    const events = s.takeRestarts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: "ugv-001", interrupted: true });
    expect(["read_set_overlap", "graph_changed"]).toContain(events[0]?.reason); // an hpa coarse stage makes any map change a graph change
    expect(s.isPlanning("ugv-001")).toBe(false);
    expect(s.takeCompleted()).toEqual([]); // an interrupted query has no outcome
    expect(s.takeLegs("ugv-001", sub.value)).toBeUndefined();
  });

  it("a change in a chunk nobody has read lets the query go on (without an hpa stage: its graph changes with any map change, as for a plain hpa query)", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const noHpa = { kind: "refine", mode: "lazy", coarse: algo("weighted-astar", { weight: 5 }), local: algo("astar") } as unknown as StrategyNode;
    const sub = s.submit(req(cfg(noHpa, { onboardComputeExpansionsPerTick: 100 })), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    let tick = 1;
    for (; tick < 5000; tick++) {
      s.tick(tick);
      if (s.takeLegs("ugv-001", sub.value)?.legs.length) break;
    }
    s.takeRestarts();
    grid.setCell("occupancy", 62, 2, OCCUPANCY_BLOCKED); // far corner, away from the coarse path's neighbourhood
    const rest = drive(s, sub.value, "ugv-001", tick + 1, 5000);
    expect(s.takeRestarts()).toEqual([]);
    expect(rest.taken.at(-1)?.progress).toMatchObject({ done: true, status: "found" });
    expect(rest.taken.at(-1)?.progress.interrupted).toBeUndefined();
  });

  it("cancelling drops the query and its legs", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const sub = s.submit(lazy(), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    s.tick(1);
    s.cancel("ugv-001");
    expect(s.isPlanning("ugv-001")).toBe(false);
    expect(s.takeLegs("ugv-001", sub.value)).toBeUndefined();
  });

  it("a new submission replaces the query and its pending legs", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const first = s.submit(lazy(), 1);
    if (!first.ok) throw new Error(first.error.message);
    for (let t = 1; t < 40; t++) s.tick(t);
    const second = s.submit(lazy(), 41);
    if (!second.ok) throw new Error(second.error.message);
    expect(s.takeLegs("ugv-001", first.value)).toBeUndefined();
    expect(second.value).not.toBe(first.value);
  });
});

describe("snapshot and restore mid-leg (service level; World restore is F3)", () => {
  for (const cachesEnabled of [true, false]) {
    it(`a restored service hands out exactly the legs the uninterrupted one does, with the same ticks (caches ${cachesEnabled ? "on" : "off"})`, () => {
      const grid = workloadGrid();
      const a = new PlanningService(grid, { cachesEnabled: true });
      const sub = a.submit(req(cfg(refine("lazy"))), 1);
      if (!sub.ok) throw new Error(sub.error.message);
      // Run until one leg has been taken and at least one more is still to come, then snapshot.
      let snapTick = 0;
      let takenBefore = 0;
      for (let t = 1; t < 5000 && snapTick === 0; t++) {
        a.tick(t);
        const p = a.takeLegs("ugv-001", sub.value);
        takenBefore += p?.legs.length ?? 0;
        if (takenBefore >= 1 && !p?.done) snapTick = t;
      }
      expect(snapTick).toBeGreaterThan(0);
      const snap = JSON.parse(JSON.stringify(a.snapshot()));
      expect(snap.active[0].strategy.legs).toEqual({ produced: takenBefore, taken: takenBefore });
      const rest = drive(a, sub.value, "ugv-001", snapTick + 1, 5000);
      const b = new PlanningService(grid, { cachesEnabled });
      b.restore(snap);
      const restored = drive(b, sub.value, "ugv-001", snapTick + 1, 5000);
      expect(flatLegs(restored.taken).length).toBeGreaterThan(0);
      expect(flatLegs(restored.taken)).toEqual(flatLegs(rest.taken));
      const ends = (t: Taken | undefined) => t && { done: t.progress.done, status: t.progress.status, interrupted: t.progress.interrupted, charged: t.progress.expansionsCharged, tick: t.progress.completedTick };
      expect(ends(restored.taken.at(-1))).toEqual(ends(rest.taken.at(-1)));
      expect(restored.outcome?.cells).toEqual(rest.outcome?.cells);
      expect(JSON.stringify(restored.outcome?.strategy)).toBe(JSON.stringify(rest.outcome?.strategy));
    });
  }

  it("legs produced but not yet taken at the snapshot are handed out after a restore, none twice", () => {
    const grid = workloadGrid();
    const a = new PlanningService(grid);
    const sub = a.submit(req(cfg(refine("lazy"), { onboardComputeExpansionsPerTick: 100 })), 1);
    if (!sub.ok) throw new Error(sub.error.message);
    // Tick without taking, so legs pile up produced-but-untaken.
    let t = 1;
    for (; t < 5000; t++) {
      a.tick(t);
      if ((a.snapshot().active[0]?.strategy?.legs?.produced ?? 0) >= 2) break;
    }
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    expect(snap.active[0].strategy.legs).toMatchObject({ taken: 0 });
    expect(snap.active[0].strategy.legs.produced).toBeGreaterThanOrEqual(2);
    const uninterrupted = drive(a, sub.value, "ugv-001", t + 1, 5000);
    const b = new PlanningService(grid, { cachesEnabled: false });
    b.restore(snap);
    const restored = drive(b, sub.value, "ugv-001", t + 1, 5000);
    const idx = (taken: readonly Taken[]) => flatLegs(taken).map((l) => l.index);
    expect(idx(restored.taken)).toEqual(idx(uninterrupted.taken));
    expect(idx(restored.taken)[0]).toBe(0); // the legs produced before the snapshot are still to be taken, from the first
    expect(new Set(idx(restored.taken)).size).toBe(idx(restored.taken).length);
  });
});
