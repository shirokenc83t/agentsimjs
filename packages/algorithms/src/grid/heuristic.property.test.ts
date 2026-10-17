import { Rng } from "@agentsim/core";
import { BeliefGrid, BeliefMap, GridSpace, missionOf } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile, type CostProfile } from "../cost-profile.ts";
import { randomGrid, referenceCost, UAV, UGV } from "../testing/fixtures.ts";
import { GridSearch, type GridAlgorithm } from "./grid-search.ts";
import { checkHeuristicScale } from "./heuristic-scale.ts";
import { SearchSpace, type VehicleTraversal } from "./search-space.ts";

// ADR-0037 addition of 2026-10-13, §7: both heuristics are admissible whatever the cost profile, because they are scaled
// by the view's lower bound on cost per metre. A profile that makes a move cost less than its geometric length
// (a distance weight below 1, an `unknown` weight below 1) lowers the heuristic instead of overestimating.

const SIZE = 30;
const PROFILES: { name: string; vehicle: "ugv" | "uav"; profile: CostProfile }[] = [
  { name: "distance 1", vehicle: "ugv", profile: { weights: { distance: 1 } } },
  { name: "distance 0.5", vehicle: "ugv", profile: { weights: { distance: 0.5 } } },
  { name: "distance 0.2", vehicle: "ugv", profile: { weights: { distance: 0.2 } } },
  { name: "time only", vehicle: "ugv", profile: { weights: { time: 1 } } },
  { name: "energy only", vehicle: "ugv", profile: { weights: { energy: 1 } } },
  { name: "distance 0.3 + time 0.5 + terrain 2", vehicle: "ugv", profile: { weights: { distance: 0.3, time: 0.5, terrain: 2 } } },
  { name: "terrain only", vehicle: "ugv", profile: { weights: { terrain: 1 } } },
  { name: "uav distance 0.5", vehicle: "uav", profile: { weights: { distance: 0.5, time: 0.2 } } },
  { name: "uav energy only", vehicle: "uav", profile: { weights: { energy: 2 } } },
];
const UNKNOWN_PROFILES: { name: string; vehicle: "ugv" | "uav"; profile: CostProfile }[] = [
  { name: "distance 1, unknown 0.3", vehicle: "ugv", profile: { weights: { distance: 1, unknown: 0.3 } } },
  { name: "distance 0.5, unknown 0.1", vehicle: "ugv", profile: { weights: { distance: 0.5, unknown: 0.1 } } },
  { name: "distance 1, unknown 5", vehicle: "ugv", profile: { weights: { distance: 1, unknown: 5 } } },
  { name: "uav distance 0.4, unknown 0.5", vehicle: "uav", profile: { weights: { distance: 0.4, unknown: 0.5 } } },
];

const traversal = (v: "ugv" | "uav"): VehicleTraversal => (v === "ugv" ? UGV : UAV);
function view(grid: ConstructorParameters<typeof SearchSpace>[0], vehicle: "ugv" | "uav", profile: CostProfile): SearchSpace {
  const p = compileCostProfile(profile);
  if (!p.ok) throw new Error(p.error.message);
  return new SearchSpace(grid, traversal(vehicle), p.value);
}

/** A belief grid whose agent has seen only random patches: the rest of the map is unknown (and planned through). */
function beliefGrid(seed: number): BeliefGrid {
  const rng = Rng.fromSeed(seed).derive("heuristic/belief");
  const world = new GridSpace({ sizeX: SIZE, sizeY: SIZE, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
  const belief = new BeliefMap(world.sizeX, world.sizeY, world.chunkSize);
  for (let k = 0; k < 14; k++) {
    const ci = rng.intRange(0, SIZE - 1);
    const cj = rng.intRange(0, SIZE - 1);
    for (let i = Math.max(0, ci - 4); i <= Math.min(SIZE - 1, ci + 4); i++) for (let j = Math.max(0, cj - 3); j <= Math.min(SIZE - 1, cj + 3); j++) belief.observeFree(i, j, 20);
  }
  return new BeliefGrid(missionOf(world), belief);
}

const run = (s: SearchSpace, a: number, b: number, alg: GridAlgorithm, heuristic: "octile" | "euclidean") => {
  const q = new GridSearch(s, a, b, alg, 1e9, { heuristic });
  q.runToCompletion();
  return q;
};

function check(s: SearchSpace, rng: ReturnType<typeof Rng.fromSeed>, queries: number, label: string): number {
  let cases = 0;
  for (let k = 0; k < queries; k++) {
    const a = rng.intRange(0, SIZE * SIZE - 1);
    const b = rng.intRange(0, SIZE * SIZE - 1);
    const ref = referenceCost(s, a, b);
    for (const heuristic of ["octile", "euclidean"] as const) {
      const astar = run(s, a, b, { kind: "astar" }, heuristic);
      if (ref === Infinity) {
        expect(astar.status, `${label} ${heuristic}`).toBe("not_found");
        continue;
      }
      expect(astar.status, `${label} ${heuristic}`).toBe("found");
      // Exactly optimal: an overestimating heuristic would return a more expensive path here.
      expect(astar.cost, `${label} ${heuristic} ${a}->${b}`).toBeCloseTo(ref, 8);
      for (const weight of [1.5, 3, 10]) {
        const w = run(s, a, b, { kind: "weighted-astar", weight }, heuristic);
        expect(w.status).toBe("found");
        expect(w.cost, `${label} ${heuristic} w=${weight}`).toBeLessThanOrEqual(weight * ref + 1e-9);
        expect(w.cost).toBeGreaterThanOrEqual(ref - 1e-9);
      }
      cases++;
    }
  }
  return cases;
}

describe("A* is optimal with both heuristics, whatever the cost profile", () => {
  it("on known maps: distance weights below 1, time-only, energy-only, terrain", () => {
    const rng = Rng.fromSeed(2026).derive("heuristic/known");
    let cases = 0;
    for (const p of PROFILES) {
      for (let m = 0; m < 3; m++) cases += check(view(randomGrid(100 + m, SIZE), p.vehicle, p.profile), rng, 3, p.name);
    }
    expect(cases).toBeGreaterThanOrEqual(100);
  });

  it("on belief maps with unknown cells: an `unknown` weight below 1, equal to 1 and above 1", () => {
    const rng = Rng.fromSeed(2027).derive("heuristic/unknown");
    let cases = 0;
    for (const p of UNKNOWN_PROFILES) {
      for (let m = 0; m < 3; m++) {
        const s = view(beliefGrid(200 + m), p.vehicle, p.profile);
        expect(s.unknown, "the view flags unknown cells").not.toBeNull();
        cases += check(s, rng, 3, p.name);
      }
    }
    expect(cases).toBeGreaterThanOrEqual(60);
  });

  it("the heuristic scale follows the profile: it is the cheapest cost per metre, so it can only go down", () => {
    const plain = view(new GridSpace({ sizeX: 8, sizeY: 8, resolutionM: 0.5, chunkSize: 8 }), "uav", { weights: { distance: 1 } });
    const half = view(new GridSpace({ sizeX: 8, sizeY: 8, resolutionM: 0.5, chunkSize: 8 }), "uav", { weights: { distance: 0.5 } });
    expect(half.heuristicPerCell).toBeCloseTo(plain.heuristicPerCell / 2, 12);
    const lowUnknown = view(beliefGrid(5), "uav", { weights: { distance: 1, unknown: 0.25 } });
    expect(lowUnknown.heuristicPerCell).toBeCloseTo(0.25, 12);
    const highUnknown = view(beliefGrid(5), "uav", { weights: { distance: 1, unknown: 4 } });
    expect(highUnknown.heuristicPerCell).toBeCloseTo(1, 12); // never above the cheapest (known) cell
  });
});

describe("the euclidean heuristic", () => {
  it("is deterministic and resumable like the octile one (same path and expansions however it is sliced)", () => {
    const s = view(randomGrid(9, SIZE), "ugv", { weights: { distance: 1, terrain: 1 } });
    const a = 0;
    const b = SIZE * SIZE - 1;
    const big = run(s, a, b, { kind: "astar" }, "euclidean");
    const sliced = new GridSearch(s, a, b, { kind: "astar" }, 1e9, { heuristic: "euclidean" });
    while (sliced.step(5) === "running");
    expect(sliced.expanded).toBe(big.expanded);
    expect(sliced.path()).toEqual(big.path());
    const again = run(s, a, b, { kind: "astar" }, "euclidean");
    expect(again.expanded).toBe(big.expanded);
  });

  it("finds the same cost as octile and never expands fewer cells than Dijkstra needs to be right", () => {
    const s = view(randomGrid(11, SIZE), "ugv", { weights: { distance: 0.5 } });
    const o = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }, "octile");
    const e = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }, "euclidean");
    const d = run(s, 0, SIZE * SIZE - 1, { kind: "dijkstra" }, "octile");
    expect(e.cost).toBeCloseTo(o.cost, 9);
    expect(o.expanded).toBeLessThanOrEqual(d.expanded);
    expect(e.expanded).toBeLessThanOrEqual(d.expanded);
  });

  it("applies to the general search path as well (turn-aware profile), with the same optimal cost", () => {
    const s = view(randomGrid(13, SIZE), "ugv", { weights: { distance: 1, turn: 0.5 } });
    expect(s.profile.turnAware).toBe(true);
    for (const [a, b] of [[0, SIZE * SIZE - 1], [3, 700], [450, 12]] as const) {
      const o = run(s, a, b, { kind: "astar" }, "octile");
      const e = run(s, a, b, { kind: "astar" }, "euclidean");
      const d = run(s, a, b, { kind: "dijkstra" }, "octile");
      expect(o.cost).toBeCloseTo(d.cost, 8);
      expect(e.cost).toBeCloseTo(d.cost, 8);
    }
  });
});

describe("checkHeuristicScale (ADR-0037 addition, §7: the guard)", () => {
  it("accepts every view whose scale is the cheapest cost per metre", () => {
    for (const p of PROFILES) expect(checkHeuristicScale(view(randomGrid(1, SIZE), p.vehicle, p.profile)).ok, p.name).toBe(true);
    for (const p of UNKNOWN_PROFILES) expect(checkHeuristicScale(view(beliefGrid(2), p.vehicle, p.profile)).ok, p.name).toBe(true);
  });

  it("reports a view whose scale is above its cheapest move, with the stable code", () => {
    const s = view(randomGrid(1, SIZE), "ugv", { weights: { distance: 0.5 } });
    const inflated = Object.create(s, { heuristicPerCell: { value: s.heuristicPerCell * 2 } }) as SearchSpace;
    const r = checkHeuristicScale(inflated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("heuristic_not_admissible");
    // The inflated view really does overestimate: A* on it can return a path that is not optimal.
    const rng = Rng.fromSeed(5).derive("inflated");
    let worse = 0;
    for (let k = 0; k < 30; k++) {
      const a = rng.intRange(0, SIZE * SIZE - 1);
      const b = rng.intRange(0, SIZE * SIZE - 1);
      const ref = referenceCost(s, a, b);
      if (ref === Infinity) continue;
      const q = new GridSearch(inflated, a, b, { kind: "astar" }, 1e9);
      q.runToCompletion();
      if (q.cost > ref + 1e-9) worse++;
    }
    expect(worse).toBeGreaterThan(0);
  });
});
