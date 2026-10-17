import { Rng } from "@agentsim/core";
import { OCCUPANCY_BLOCKED, type GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { randomGrid, UGV } from "../testing/fixtures.ts";
import { PlanningService, type PlanOutcome, type PlanningConfig, type PlanRequest } from "./planning-service.ts";
import type { StrategyNode } from "./strategy/schema.ts";

// ADR-0024: caches never change results or completion ticks. A search that ends without a path is noticed by the call
// after its last expansion, so when it used a call's whole budget it completes in the next tick; a cache hit must complete
// on the same tick as the cold search, whatever the budgets, including exact tick-budget boundaries. Plain queries and the
// searches of strategies share one rule.

const SIZE = 48;
const node = (n: unknown) => n as StrategyNode;
const leaf = (algorithm: string, extra: Record<string, unknown> = {}) => node({ kind: "algorithm", algorithm, ...extra });

interface Variant {
  readonly name: string;
  readonly config: (perTick: number, total: number) => PlanningConfig;
}
const plain = (algorithm: PlanningConfig["algorithm"]): Variant["config"] => (perTick, total) => ({ algorithm, onboardComputeExpansionsPerTick: perTick, totalBudget: total });
const strategy = (root: StrategyNode): Variant["config"] => (perTick, total) => ({
  algorithm: { kind: "astar" },
  onboardComputeExpansionsPerTick: perTick,
  totalBudget: total,
  strategy: { id: "prop", version: 1, hash: "00000000", root },
});
const VARIANTS: Variant[] = [
  { name: "plain astar", config: plain({ kind: "astar" }) },
  { name: "plain dijkstra", config: plain({ kind: "dijkstra" }) },
  { name: "plain weighted-astar", config: plain({ kind: "weighted-astar", weight: 2 }) },
  { name: "plain hpa", config: plain({ kind: "hpa" }) },
  { name: "strategy astar", config: strategy(leaf("astar")) },
  { name: "strategy hpa", config: strategy(leaf("hpa")) },
  { name: "strategy fallback", config: strategy(node({ kind: "fallback", stages: [leaf("astar", { stageBudget: 100 }), leaf("dijkstra")] })) },
  { name: "strategy anytime", config: strategy(node({ kind: "anytime", weights: [3, 1.5, 1] })) },
  // Lazy refine hands out each leg in the tick its search ended: those ticks must not depend on the cache either.
  { name: "strategy lazy refine", config: strategy(node({ kind: "refine", mode: "lazy", coarse: leaf("hpa"), local: leaf("astar") })) },
  { name: "strategy lazy refine (astar coarse)", config: strategy(node({ kind: "refine", mode: "lazy", coarse: leaf("weighted-astar", { weight: 4 }), local: leaf("dijkstra") })) },
];

const ENDS: [number, number][] = [[2, 2], [SIZE - 3, SIZE - 3]];

/** A map with a reachable pair and an enclosed goal (its search ends not_found after exploring the open region). */
function maps(seed: number): { reachable: GridSpace; enclosed: GridSpace } {
  const reachable = randomGrid(seed, SIZE, 0.15, 16);
  for (const [i, j] of ENDS) {
    reachable.setCell("occupancy", i, j, 0);
    reachable.setCell("terrainCost", i, j, 10);
  }
  const enclosed = randomGrid(seed, SIZE, 0.15, 16);
  for (const [i, j] of ENDS) {
    enclosed.setCell("occupancy", i, j, 0);
    enclosed.setCell("terrainCost", i, j, 10);
  }
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (di !== 0 || dj !== 0) enclosed.setCell("occupancy", SIZE - 3 + di, SIZE - 3 + dj, OCCUPANCY_BLOCKED);
  return { reachable, enclosed };
}

const req = (config: PlanningConfig): PlanRequest => ({ agentId: "ugv-001", traversal: UGV, config, from: { x: 2.5, y: 2.5 }, to: { x: SIZE - 2.5, y: SIZE - 2.5 } });

interface Solved {
  readonly outcome: PlanOutcome;
  /** Lazy queries: the offset (from the submission) of the tick each leg was handed out in, and the leg's own ready tick. */
  readonly legs: readonly (readonly [number, number, number])[];
}
function solve(service: PlanningService, r: PlanRequest, tick: number): Solved {
  const sub = service.submit(r, tick);
  if (!sub.ok) throw new Error(`${sub.error.code}: ${sub.error.message}`);
  const legs: [number, number, number][] = [];
  for (let t = tick; t < tick + 100_000; t++) {
    service.tick(t);
    for (const l of service.takeLegs(r.agentId, sub.value)?.legs ?? []) legs.push([l.index, t - tick, l.tick - tick]);
    const o = service.takeCompleted()[0];
    if (o) return { outcome: o, legs };
  }
  throw new Error("query did not complete");
}
/** What the simulation can see of an outcome: its result and when it completed (offsets, so it does not depend on the start tick). */
const seen = ({ outcome: o, legs }: Solved) => ({ status: o.status, cost: o.cost, cells: o.cells, expansionsCharged: o.expansionsCharged, ticks: o.completedTick - o.submittedTick, restarts: o.restarts, legs });

describe("a cache hit completes on the same tick as the cold search (ADR-0024), whatever the budgets", () => {
  let cases = 0;
  const statuses = new Set<string>();
  const boundaries = { exactTick: 0, nonFoundOnBoundary: 0 };
  let lazyLegs = 0;

  for (const variant of VARIANTS) {
    it(`${variant.name}: found, not_found and budget_exceeded, with budgets at and around exact tick boundaries`, () => {
      const rng = Rng.fromSeed(404).derive(`cache-invisible/${variant.name}`);
      for (let seed = 1; seed <= 3; seed++) {
        const { reachable, enclosed } = maps(seed * 17);
        for (const [mapName, grid] of [["reachable", reachable], ["enclosed", enclosed]] as const) {
          // The reference search without any budget pressure: how many expansions it needs and how it ends.
          const ref = solve(new PlanningService(grid, { cachesEnabled: false }), req(variant.config(1_000_000, 10_000_000)), 1).outcome;
          const E = ref.expansionsCharged;
          const perTicks = new Set<number>([100, 128, 250 + rng.intRange(0, 200)]);
          for (const p of [E, E - 1, E + 1, Math.ceil(E / 2), Math.ceil(E / 3), Math.floor(E / 2), Math.ceil(E / 4)]) if (p >= 100 && p <= 1_000_000) perTicks.add(p);
          for (const perTick of [...perTicks].sort((a, b) => a - b)) {
            // No cap, and caps at exact multiples of the tick budget and around the search's own length.
            const totals = new Set<number>([10_000_000, perTick, 2 * perTick, 3 * perTick, Math.max(perTick, E), Math.max(perTick, E - 1), Math.max(perTick, E + 1), Math.max(perTick, Math.floor(E / 2))]);
            for (const total of [...totals].sort((a, b) => a - b)) {
              const config = variant.config(perTick, total);
              const cold = solve(new PlanningService(grid, { cachesEnabled: false }), req(config), 1);
              const service = new PlanningService(grid, { cachesEnabled: true });
              const first = solve(service, req(config), 1); // fills the cache
              const warm = solve(service, req(config), 500); // answered from it
              const label = `${variant.name} ${mapName} seed ${seed} perTick ${perTick} total ${total} (E ${E})`;
              expect(seen(first), `${label}: first run`).toEqual(seen(cold));
              expect(seen(warm), `${label}: warm`).toEqual(seen(cold));
              statuses.add(cold.outcome.status);
              cases++;
              if (cold.outcome.expansionsCharged % perTick === 0) boundaries.exactTick++;
              if (cold.outcome.status !== "found" && cold.outcome.expansionsCharged % perTick === 0) boundaries.nonFoundOnBoundary++;
              if (variant.name.includes("lazy") && cold.legs.length > 0) lazyLegs++;
            }
          }
        }
      }
    }, 300_000);
  }

  it("exercised every ending and exact boundaries", () => {
    expect(cases).toBeGreaterThan(500);
    expect([...statuses].sort()).toEqual(["budget_exceeded", "found", "not_found"]);
    expect(boundaries.exactTick).toBeGreaterThan(50); // searches whose whole charge is a multiple of the tick budget
    expect(boundaries.nonFoundOnBoundary).toBeGreaterThan(10); // the case the rule is about: a failure ending exactly on a boundary
    expect(lazyLegs).toBeGreaterThan(20); // lazy queries that handed out legs, whose ticks were compared
  });
});
