import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { PlanningService, type PlanOutcome, type PlanningConfig, type PlanRequest } from "./planning-service.ts";
import type { StrategyNode } from "./strategy/schema.ts";
import type { StrategyPlan } from "./strategy/runner.ts";

// F3a M1, T-005 FINDING (stop-and-report): a snapshot taken right after a belief change that the planner has not yet
// seen restores with a different restart/continuation history. In a run the live views are synced after sensing (the
// last thing of a tick), and a query reads that change at the start of its next slice, so at the moment a snapshot is
// taken between ticks the query is, as a rule, one change behind. `PlanningSnapshot` keeps (request, charge, restarts,
// continuations, spent) but not what the query has seen (`ActiveQuery.seen`, `StrategyExec.seenSpace`/`seenGraph`) or what
// its search has read; `restore` starts the query with `seen` at the view's current version, so the pending change is
// never looked at. These tests are the case written first (T-003): they FAIL today and are skipped until the Architect
// decides what the snapshot holds (it needs a dated addition to ADR-0024 and ADR-0037 approved by Max).
const pendingChangeIt = it.skip;

const UGV = { vehicle: "ugv" as const, cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 };
const cfg = (o: Partial<PlanningConfig> = {}): PlanningConfig => ({ algorithm: { kind: "dijkstra" }, onboardComputeExpansionsPerTick: 100, totalBudget: 1_000_000, ...o });
const req = (c: PlanningConfig): PlanRequest => ({ agentId: "ugv-001", traversal: UGV, config: c, from: { x: 2.5, y: 32.5 }, to: { x: 90.5, y: 32.5 } });
const grid = () => new GridSpace({ sizeX: 96, sizeY: 64, resolutionM: 1, chunkSize: 16 });
const wall = (g: GridSpace, x: number, j0: number, j1: number) => {
  for (let j = j0; j < j1; j++) g.setCell("occupancy", x, j, OCCUPANCY_BLOCKED);
};

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
 * Submits, lets the query run one slice, applies `change` to the world and runs the sync point (as the sensing phase does),
 * then snapshots: the change is pending. Returns the reference outcome (the live service going on) and the restored one.
 */
function pending(config: PlanningConfig, change: (g: GridSpace) => void) {
  const g = grid();
  const s = new PlanningService(g);
  expect(s.submit(req(config), 1).ok).toBe(true);
  s.tick(1);
  change(g);
  s.syncViews();
  const snap = JSON.parse(JSON.stringify(s.snapshot())) as ReturnType<PlanningService["snapshot"]>;
  const reference = finish(s, 2);
  const r = new PlanningService(g);
  r.restore(snap);
  return { reference, restored: finish(r, 2) };
}

describe("a snapshot taken with a belief change the query has not seen yet (T-005 finding; skipped until decided)", () => {
  pendingChangeIt("a change away from what the search read: the live query counts a continuation, the restored one must too", () => {
    const { reference, restored } = pending(cfg(), (g) => wall(g, 80, 10, 50));
    expect(reference.outcome.continuations).toBe(1);
    expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
  });

  pendingChangeIt("a change through what the search read: the live query restarts at its next slice, the restored one must too", () => {
    const { reference, restored } = pending(cfg(), (g) => wall(g, 4, 20, 40));
    expect(reference.outcome.restarts).toBe(1);
    expect(reference.restarts).toHaveLength(1);
    expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
    expect(restored.restarts).toEqual(reference.restarts);
  });

  pendingChangeIt("the same for a strategy query (StrategyExec.seenSpace and the chunks its searches read)", () => {
    const root = { kind: "algorithm", algorithm: "dijkstra" } as unknown as StrategyNode;
    const strategy: StrategyPlan = { id: "dijkstra-only", version: 1, hash: "0000abcd", root };
    for (const [change, restarts] of [[(g: GridSpace) => wall(g, 80, 10, 50), 0], [(g: GridSpace) => wall(g, 4, 20, 40), 1]] as const) {
      const { reference, restored } = pending(cfg({ strategy }), change);
      expect(reference.outcome.restarts).toBe(restarts);
      expect(seen(restored.outcome)).toEqual(seen(reference.outcome));
    }
  });

  it("(today) the restored query does not see the pending change: it finishes with no restart and no continuation", () => {
    // Pins the divergence so that it is noticed when the snapshot grows the fields that fix it (then un-skip the three above).
    const away = pending(cfg(), (g) => wall(g, 80, 10, 50));
    expect([away.reference.outcome.continuations, away.restored.outcome.continuations]).toEqual([1, 0]);
    const through = pending(cfg(), (g) => wall(g, 4, 20, 40));
    expect([through.reference.outcome.restarts, through.restored.outcome.restarts]).toEqual([1, 0]);
  });
});
