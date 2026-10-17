import { Rng } from "@agentsim/core";
import { OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { expect, it } from "vitest";
import { measure, recordResults, summarize } from "../../../tools/bench/measure.ts";
import { buildReferenceWorld } from "@agentsim/spatial";
import { compileCostProfile, type CostProfile } from "./cost-profile.ts";
import { GridSearch } from "./grid/grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "./grid/search-space.ts";
import { AbstractGraph } from "./hpa/abstract-graph.ts";
import { HpaQuery } from "./hpa/hpa-query.ts";
import { PlanningService, type PlanningConfig, type PlanRequest } from "./planning/planning-service.ts";
import { presetStrategy, strategyContentHash, type PlanningStrategy } from "./planning/strategy/index.ts";

// Budgets (ADR-0024, F1 plan): cross-map HPA* query p95 ≤ 50 ms and ≤ 50k expansions (graph built);
// a 20k-expansion slice p95 ≤ 8 ms per agent. Graph build (target ≤ 2 s), local rebuild, mask builds and
// the N-agent per-tick total are reported. CI gates the time budgets on the median at 2× (ADR-0030), so
// sample counts are kept high (≥ 40 queries, ≥ 60 slices).
const UGV: VehicleTraversal = { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.5 };

function compiled(p: CostProfile) {
  const r = compileCostProfile(p);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Free far-apart cell pairs (deterministic), corner to corner across the map. */
function crossMapPairs(space: SearchSpace, n: number): [number, number][] {
  const rng = Rng.fromSeed(4).derive("bench/pairs");
  const pick = (i0: number, j0: number) => {
    for (;;) {
      const i = i0 + rng.intRange(0, 199);
      const j = j0 + rng.intRange(0, 199);
      if (space.passable(i, j)) return j * space.sizeX + i;
    }
  };
  return Array.from({ length: n }, (_, k) => (k % 2 === 0 ? [pick(0, 0), pick(1800, 1800)] : [pick(0, 1800), pick(1800, 0)]));
}

it("planning benchmarks on the 1 km² / 0.5 m reference world", () => {
  const grid = buildReferenceWorld();
  const profile = compiled({ weights: { distance: 1, terrain: 1 } });

  const space = new SearchSpace(grid, UGV, profile);
  const t0 = performance.now();
  const graph = new AbstractGraph(space);
  const graphBuildMs = performance.now() - t0;

  const maskBuild = measure({ iterations: 5, warmup: 1, setup: () => null, run: () => void new SearchSpace(grid, UGV, profile) });
  const heavy = compiled({
    weights: { distance: 1, terrain: 1, time: 0.5 },
    constraints: ["terrain < 5", "slope < 2", "altitude < 50", "terrain * 2 < 9", "not (terrain > 4.5)", "slope * slope < 3", "vehicle == \"ugv\"", "altitude + terrain < 60", "distance < 2", "turn < 3"],
  });
  const heavyMaskBuild = measure({ iterations: 3, warmup: 1, setup: () => null, run: () => void new SearchSpace(grid, UGV, heavy) });

  // Cross-map HPA* queries (graph built).
  const pairs = crossMapPairs(space, 40);
  const expansions: number[] = [];
  let p = 0;
  const hpaQuery = measure({
    iterations: pairs.length,
    warmup: 0,
    setup: (): [number, number] => pairs[p++ % pairs.length] ?? [0, 0],
    run: ([a, b]) => {
      const q = new HpaQuery(graph, a, b, 10_000_000);
      while (q.step(1 << 20) === "running");
      expansions.push(q.expanded);
      expect(q.status).toBe("found");
    },
  });

  // One 20k-expansion slice of a long A* query (per-agent budget, ADR-0024).
  let s = 0;
  const slice = measure({
    iterations: 60,
    warmup: 2,
    setup: () => {
      const [a, b] = pairs[s++ % pairs.length] ?? [0, 0];
      return new GridSearch(space, a, b, { kind: "astar" }, 10_000_000, { trackReads: true }); // as planning queries run (read-set rule)
    },
    run: (q) => void q.step(20_000),
  });

  // Constraint-heavy vs plain A* on the same queries (20k-expansion slices).
  const heavySpace = new SearchSpace(grid, UGV, heavy);
  let hs = 0;
  const heavySlice = measure({
    iterations: 10,
    warmup: 1,
    setup: () => {
      const [a, b] = pairs[hs++ % pairs.length] ?? [0, 0];
      return new GridSearch(heavySpace, a, b, { kind: "astar" }, 10_000_000, { trackReads: true });
    },
    run: (q) => void q.step(20_000),
  });

  // Global per-tick work with 20 agents planning at once (one 20k slice each).
  const perTick = measure({
    iterations: 5,
    warmup: 1,
    setup: () => pairs.slice(0, 20).map(([a, b]) => new GridSearch(space, a, b, { kind: "astar" }, 10_000_000, { trackReads: true })),
    run: (qs) => {
      for (const q of qs) q.step(20_000);
    },
  });

  // Planning strategies (ADR-0037, F2b M2): one tick of 20 agents through the PlanningService, each stepping one 20k-expansion
  // slice of a cross-map query, for the plain algorithm, the same algorithm as a one-node strategy (the runner's overhead)
  // and two shipped strategies. Report only (A/B against the plain row). Every iteration plans fresh pairs, so no result
  // cache hit hides the search work; this runs before the local-rebuild bench below, which edits the grid.
  const stratPairs = crossMapPairs(space, 140);
  const strategyPlan = (s: PlanningStrategy) => ({ id: s.id, version: s.version, hash: strategyContentHash(s), root: s.root });
  const named = (id: string): PlanningStrategy => {
    const s = presetStrategy({ ref: id, version: 1 });
    if (!s) throw new Error(`no preset ${id}`);
    return s;
  };
  const serviceTick20 = (strategy: PlanningStrategy | undefined): ReturnType<typeof measure> => {
    const config: PlanningConfig = {
      algorithm: { kind: "astar" },
      onboardComputeExpansionsPerTick: 20_000,
      totalBudget: 2_000_000,
      costProfile: { weights: { distance: 1, terrain: 1 } },
      ...(strategy ? { strategy: strategyPlan(strategy) } : {}),
    };
    const service = new PlanningService(grid);
    service.prepare([{ traversal: UGV, config }]); // views and graph built before the measured ticks
    const xy = (cell: number) => ({ x: ((cell % space.sizeX) + 0.5) * grid.resolutionM, y: (Math.floor(cell / space.sizeX) + 0.5) * grid.resolutionM });
    let round = 0;
    return measure({
      iterations: 5,
      warmup: 1,
      setup: () => {
        round++;
        for (let k = 0; k < 20; k++) {
          const [a, b] = stratPairs[(round * 20 + k) % stratPairs.length] ?? [0, 0];
          const r: PlanRequest = { agentId: `ugv-${String(k).padStart(3, "0")}`, traversal: UGV, config, from: xy(a), to: xy(b) };
          if (!service.submit(r, round).ok) throw new Error("submit failed");
        }
        return round;
      },
      run: (t) => service.tick(t),
    });
  };
  const serviceTickPlain = serviceTick20(undefined);
  const serviceTickOneNode = serviceTick20({ schemaVersion: 0, id: "one-node", version: 1, root: { kind: "algorithm", algorithm: "astar" } });
  const serviceTickAstarThenHpa = serviceTick20(named("astar-then-hpa"));
  const serviceTickShortLong = serviceTick20(named("short-astar-long-hpa"));

  // Local rebuild after a scenario-editor edit (one cell toggled).
  const rng = Rng.fromSeed(6).derive("bench/edits");
  const localRebuild = measure({
    iterations: 20,
    warmup: 2,
    setup: () => {
      const i = rng.intRange(0, 1999);
      const j = rng.intRange(0, 1999);
      grid.setCell("occupancy", i, j, grid.isBlocked(i, j) ? 0 : OCCUPANCY_BLOCKED);
      return graph;
    },
    run: (gr) => void gr.sync(),
  });

  recordResults("node.json", {
    "planning.maskBuild": maskBuild,
    "planning.maskBuildConstraintHeavy": heavyMaskBuild,
    "planning.hpaGraphBuild": summarize([graphBuildMs]),
    "planning.hpaCrossMapQuery": hpaQuery,
    "planning.hpaCrossMapExpansions": summarize(expansions, "count"),
    "planning.slice20k": slice,
    "planning.slice20kConstraintHeavy": heavySlice,
    "planning.perTick20Agents": perTick,
    "planning.serviceTick20Plain": serviceTickPlain,
    "planning.serviceTick20OneNodeStrategy": serviceTickOneNode,
    "planning.strategySlice20AstarThenHpa": serviceTickAstarThenHpa,
    "planning.strategySlice20ShortLong": serviceTickShortLong,
    "planning.hpaLocalRebuild": localRebuild,
  });
  console.log(`HPA* graph: ${graph.nodeCount} nodes, built in ${graphBuildMs.toFixed(0)} ms`);
});
