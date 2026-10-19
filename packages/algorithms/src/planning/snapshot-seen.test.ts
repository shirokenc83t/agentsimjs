import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { PlanningService, type PlanOutcome, type PlanningConfig, type PlanningSnapshot, type PlanRequest } from "./planning-service.ts";
import type { StrategyPlan } from "./strategy/runner.ts";
import type { StrategyNode } from "./strategy/schema.ts";

// F3a M1 (ADR-0024 and ADR-0037 additions of 2026-10-17): a snapshot taken right after a belief
// change that the planner has not yet seen carries that change (`pending`, with the chunks the search has read), so the
// restored query restarts or continues exactly as the live one does. In a run the live views are synced after sensing (the
// last thing of a tick) and a query reads the change at the start of its next slice, so at the moment a snapshot is taken
// between ticks the query is, as a rule, one change behind.

const UGV = { vehicle: "ugv" as const, cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 };
const cfg = (o: Partial<PlanningConfig> = {}): PlanningConfig => ({ algorithm: { kind: "dijkstra" }, onboardComputeExpansionsPerTick: 100, totalBudget: 1_000_000, ...o });
const req = (c: PlanningConfig): PlanRequest => ({ agentId: "ugv-001", traversal: UGV, config: c, from: { x: 2.5, y: 32.5 }, to: { x: 90.5, y: 32.5 } });
const grid = () => new GridSpace({ sizeX: 96, sizeY: 64, resolutionM: 1, chunkSize: 16 });
const wall = (g: GridSpace, x: number, j0: number, j1: number) => {
  for (let j = j0; j < j1; j++) g.setCell("occupancy", x, j, OCCUPANCY_BLOCKED);
};
const plan = (root: unknown, id = "t"): StrategyPlan => ({ id, version: 1, hash: "0000abcd", root: root as StrategyNode });

function finish(s: PlanningService, from: number): { outcome: PlanOutcome; restarts: unknown[] } {
  const restarts: unknown[] = [];
  for (let t = from; t < from + 5000; t++) {
    s.tick(t);
    restarts.push(...s.takeRestarts());
    const o = s.takeCompleted()[0];
    if (o) return { outcome: o, restarts };
  }
  throw new Error("no completion");
}

/** What the simulation and the trace can see of an outcome. */
const seen = (o: PlanOutcome) => ({ status: o.status, cells: o.cells, cost: o.cost, expansionsCharged: o.expansionsCharged, completedTick: o.completedTick, restarts: o.restarts, continuations: o.continuations });

/**
 * Submits, runs `slices` ticks, applies `change` to the world and runs the sync point (as the sensing phase does), then
 * snapshots: the change is pending. Returns the reference outcome (the live service going on), the restored one, and the snapshot.
 */
function pending(config: PlanningConfig, change: (g: GridSpace) => void, slices = 1, until?: (snap: PlanningSnapshot) => boolean, prepare?: (g: GridSpace) => void) {
  const g = grid();
  prepare?.(g);
  const s = new PlanningService(g);
  expect(s.submit(req(config), 1).ok).toBe(true);
  let t = 1;
  for (; t <= slices; t++) s.tick(t);
  while (until && !until(s.snapshot()) && t < 400) s.tick(t++);
  change(g);
  s.syncViews();
  const snap = JSON.parse(JSON.stringify(s.snapshot())) as PlanningSnapshot;
  const reference = finish(s, t);
  const r = new PlanningService(g);
  r.restore(snap);
  // A snapshot of the restored service, before the query's next slice, keeps the change it carries: snapshot(restore(s)) equals s,
  // and a second generation restored from it goes on exactly as the original does.
  const again = JSON.parse(JSON.stringify(r.snapshot())) as PlanningSnapshot;
  expect(again).toEqual(snap);
  const r2 = new PlanningService(g);
  r2.restore(again);
  const restored = finish(r, t);
  const second = finish(r2, t);
  expect(seen(second.outcome)).toEqual(seen(restored.outcome));
  expect(second.restarts).toEqual(restored.restarts);
  return { reference, restored, snap };
}

describe("a snapshot taken with a belief change the query has not seen yet", () => {
  it("a change away from what the search read: the live query counts a continuation, the restored one does too", () => {
    const { reference, restored, snap } = pending(cfg(), (g) => wall(g, 80, 10, 50));
    expect(reference.outcome.continuations).toBe(1);
    expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
    expect(snap.active[0]?.pending).toEqual({ chunks: expect.any(Array), graphChanged: false });
    expect(snap.active[0]?.pending?.chunks.length).toBeGreaterThan(0);
    expect(snap.active[0]?.read).toBeDefined();
  });

  it("a change through what the search read: the live query restarts at its next slice, the restored one does too", () => {
    const { reference, restored, snap } = pending(cfg(), (g) => wall(g, 4, 20, 40));
    expect(reference.outcome.restarts).toBe(1);
    expect(reference.restarts).toHaveLength(1);
    expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
    expect(restored.restarts).toEqual(reference.restarts);
    const p = snap.active[0]?.pending?.chunks ?? [];
    const read = snap.active[0]?.read ?? [];
    expect(p.some((k) => read.includes(k))).toBe(true); // the overlap the restart is for
  });

  it("a change in chunks the search never read, with caches on and off: a continuation both ways", () => {
    for (const cachesEnabled of [true, false]) {
      const g = grid();
      const s = new PlanningService(g, { cachesEnabled });
      s.submit(req(cfg()), 1);
      s.tick(1);
      wall(g, 90, 0, 20); // the far corner: no search that has expanded 100 cells reads it
      s.syncViews();
      const snap = JSON.parse(JSON.stringify(s.snapshot())) as PlanningSnapshot;
      expect(snap.active[0]?.pending?.chunks.every((k) => !(snap.active[0]?.read ?? []).includes(k))).toBe(true);
      const live = finish(s, 2);
      const r = new PlanningService(g, { cachesEnabled });
      r.restore(snap);
      const restored = finish(r, 2);
      expect([live.outcome.restarts, live.outcome.continuations]).toEqual([0, 1]);
      expect(seen(restored.outcome)).toEqual(seen(live.outcome));
      expect(restored.restarts).toEqual([]);
    }
  });

  it("a restored query also applies changes that come after the restore, together with the pending one", () => {
    const g = grid();
    const s = new PlanningService(g);
    s.submit(req(cfg()), 1);
    s.tick(1);
    wall(g, 80, 10, 50); // pending at the snapshot: away from the search
    s.syncViews();
    const snap = JSON.parse(JSON.stringify(s.snapshot())) as PlanningSnapshot;
    const r = new PlanningService(g);
    r.restore(snap);
    wall(g, 4, 20, 40); // after the snapshot: the same world for both services, each sees it at its next sync
    const live = finish(s, 2);
    const restored = finish(r, 2);
    expect(live.outcome.restarts).toBe(1);
    expect(seen(restored.outcome)).toEqual(seen(live.outcome));
  });

  it("an HPA* query whose graph moved restarts when restored, as the live one does", () => {
    // A maze of three walls with their gaps at alternate ends makes the path long, so the query is still running after a slice.
    const maze = (g: GridSpace) => {
      wall(g, 20, 5, 64);
      wall(g, 40, 0, 59);
      wall(g, 60, 5, 64);
    };
    const config = cfg({ algorithm: { kind: "hpa" }, onboardComputeExpansionsPerTick: 100 });
    const { reference, restored, snap } = pending(config, (g) => wall(g, 80, 10, 50), 1, undefined, maze);
    expect(snap.active[0]?.pending?.graphChanged).toBe(true);
    expect(snap.active[0]?.read).toBeUndefined();
    expect(reference.outcome.restarts).toBeGreaterThan(0);
    expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
  });

  it("the same for a strategy query: a change away from what its searches read, and one through it", () => {
    const strategy = plan({ kind: "algorithm", algorithm: "dijkstra" }, "dijkstra-only");
    for (const [change, restarts] of [[(g: GridSpace) => wall(g, 80, 10, 50), 0], [(g: GridSpace) => wall(g, 4, 20, 40), 1]] as const) {
      const { reference, restored, snap } = pending(cfg({ strategy }), change);
      expect(reference.outcome.restarts).toBe(restarts);
      expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
      expect(snap.active[0]?.strategy?.pending).toBeDefined();
      expect(snap.active[0]?.pending).toBeUndefined(); // a strategy query keeps it in its strategy snapshot
    }
  });

  it("a strategy query mid stage 2 (the first search done, the union of its reads kept), with a change through the first stage's reads", () => {
    // Stage 1 cannot find the path within 150 expansions, so the query goes on to stage 2 and stays there for a while.
    const fallback = plan({ kind: "fallback", stages: [{ kind: "algorithm", algorithm: "dijkstra", stageBudget: 150 }, { kind: "algorithm", algorithm: "dijkstra" }] }, "fallback");
    const config = cfg({ strategy: fallback, onboardComputeExpansionsPerTick: 100 });
    const inStage2 = (s: PlanningSnapshot) => (s.active[0]?.strategy?.stages.length ?? 0) >= 1 && s.active[0]?.strategy?.current !== undefined;
    for (const change of [(g: GridSpace) => wall(g, 80, 10, 50), (g: GridSpace) => wall(g, 4, 20, 40)]) {
      const { reference, restored, snap } = pending(config, change, 1, inStage2);
      expect(snap.active[0]?.strategy?.stages.length).toBeGreaterThanOrEqual(1);
      expect(snap.active[0]?.strategy?.read?.length).toBeGreaterThan(0);
      expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
    }
  });

  describe("a strategy with an HPA* stage whose graph moved", () => {
    // Three walls with their gaps at alternate ends keep a search running; stage 1 cannot finish in its budget of 150 expansions.
    const maze = (g: GridSpace) => {
      wall(g, 20, 5, 64);
      wall(g, 40, 0, 59);
      wall(g, 60, 5, 64);
    };
    const toHpa = plan({ kind: "fallback", stages: [{ kind: "algorithm", algorithm: "dijkstra", stageBudget: 150 }, { kind: "algorithm", algorithm: "hpa" }] }, "dijkstra-then-hpa");
    const config = cfg({ strategy: toHpa, onboardComputeExpansionsPerTick: 100 });
    const change = (g: GridSpace) => wall(g, 80, 10, 50);

    it("moved while stage 1 runs: the snapshot keeps the plain inequality and the restored query restarts when stage 2 starts, as the live one does", () => {
      const { reference, restored, snap } = pending(config, change, 1, undefined, maze);
      expect(snap.active[0]?.strategy?.current).toBeDefined();
      expect(snap.active[0]?.strategy?.stages).toHaveLength(0); // still stage 1: no HPA* stage has run
      expect(snap.active[0]?.strategy?.pending?.graphChanged).toBe(true);
      expect(reference.restarts.length).toBeGreaterThan(0);
      expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
      expect(restored.restarts).toEqual(reference.restarts);
    });

    it("moved while stage 2 (HPA*) runs", () => {
      const inStage2 = (x: PlanningSnapshot) => (x.active[0]?.strategy?.stages.length ?? 0) >= 1 && x.active[0]?.strategy?.current !== undefined;
      const { reference, restored, snap } = pending(config, change, 1, inStage2, maze);
      expect(snap.active[0]?.strategy?.stages.length).toBeGreaterThanOrEqual(1);
      expect(snap.active[0]?.strategy?.pending?.graphChanged).toBe(true);
      expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
      expect(restored.restarts).toEqual(reference.restarts);
    });
  });

  it("nothing is pending when nothing changed: no pending, no read set, in the snapshot", () => {
    const g = grid();
    const s = new PlanningService(g);
    s.submit(req(cfg()), 1);
    s.tick(1);
    s.syncViews();
    const a = s.snapshot().active[0];
    expect(a).toBeDefined();
    expect(a && "pending" in a).toBe(false);
    expect(a && "read" in a).toBe(false);
  });
});
