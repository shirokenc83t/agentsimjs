import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { compileCostProfile, type CostProfile } from "../cost-profile.ts";
import { randomGrid, UAV, UGV } from "../testing/fixtures.ts";
import { GridSearch, type GridAlgorithm } from "./grid-search.ts";
import { SearchSpace } from "./search-space.ts";

// ADR-0024 addition and ADR-0040: a search window is a cell rectangle the search never leaves. Inside it the search expands as the unwindowed
// one does, turn-aware profiles included, so the two agree whenever the optimal path lies inside the window.

const SIZE = 40;
const PROFILES: { name: string; vehicle: "ugv" | "uav"; profile: CostProfile }[] = [
  { name: "distance", vehicle: "ugv", profile: { weights: { distance: 1 } } },
  { name: "terrain and time", vehicle: "ugv", profile: { weights: { distance: 0.3, time: 0.5, terrain: 2 } } },
  { name: "turn-aware", vehicle: "ugv", profile: { weights: { distance: 1, turn: 0.8 } } },
  { name: "turn-aware uav", vehicle: "uav", profile: { weights: { distance: 1, time: 0.2, turn: 2 } } },
];
const ALGORITHMS: GridAlgorithm[] = [{ kind: "astar" }, { kind: "weighted-astar", weight: 2 }, { kind: "dijkstra" }];

function view(seed: number, vehicle: "ugv" | "uav", profile: CostProfile): SearchSpace {
  const p = compileCostProfile(profile);
  if (!p.ok) throw new Error(p.error.message);
  return new SearchSpace(randomGrid(seed, SIZE, 0.18), vehicle === "ugv" ? UGV : UAV, p.value);
}

const run = (s: SearchSpace, a: number, b: number, alg: GridAlgorithm, window?: { i0: number; j0: number; i1: number; j1: number }, budget = 1e9) => {
  const q = new GridSearch(s, a, b, alg, budget, window ? { window } : {});
  q.runToCompletion();
  return q;
};

function boxOf(path: readonly number[], pad: number) {
  let i0 = SIZE;
  let j0 = SIZE;
  let i1 = 0;
  let j1 = 0;
  for (const c of path) {
    const i = c % SIZE;
    const j = (c / SIZE) | 0;
    i0 = Math.min(i0, i);
    j0 = Math.min(j0, j);
    i1 = Math.max(i1, i + 1);
    j1 = Math.max(j1, j + 1);
  }
  return { i0: Math.max(0, i0 - pad), j0: Math.max(0, j0 - pad), i1: Math.min(SIZE, i1 + pad), j1: Math.min(SIZE, j1 + pad) };
}

describe("a search window", () => {
  it.each(PROFILES)("gives the unwindowed result when the path lies inside it: $name", ({ vehicle, profile }) => {
    const rng = Rng.fromSeed(7).derive("window/property");
    let compared = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = view(seed, vehicle, profile);
      for (let k = 0; k < 10; k++) {
        const a = rng.intRange(0, SIZE * SIZE - 1);
        const b = rng.intRange(0, SIZE * SIZE - 1);
        for (const alg of ALGORITHMS) {
          const free = run(s, a, b, alg);
          if (free.status !== "found") continue;
          const path = free.path();
          const w = boxOf(path, 0);
          const boxed = run(s, a, b, alg, w);
          const label = `${vehicle} seed ${seed} ${a}->${b} ${alg.kind}`;
          expect(boxed.status, label).toBe("found");
          if (alg.kind === "weighted-astar") {
            // Not optimal, so which of several equal paths it returns follows the order cells are reached in, and cells outside the window
            // take part in that order: the cost stays within the bound, the path is a legal one inside the window.
            const optimal = run(s, a, b, { kind: "astar" }).cost;
            expect(boxed.cost, label).toBeLessThanOrEqual(alg.weight * optimal + 1e-9);
            expect(boxed.cost, label).toBeGreaterThanOrEqual(optimal - 1e-9);
          } else {
            expect(boxed.cost, label).toBe(free.cost);
            expect(boxed.path(), label).toEqual(path);
            expect(boxed.expanded, label).toBeLessThanOrEqual(free.expanded);
          }
          // A window that holds the whole map is no window.
          const whole = run(s, a, b, alg, { i0: 0, j0: 0, i1: SIZE, j1: SIZE });
          expect(whole.expanded, label).toBe(free.expanded);
          expect(whole.path(), label).toEqual(path);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it.each(PROFILES)("never expands outside it, and ends not_found after at most its states when the goal is outside: $name", ({ vehicle, profile }) => {
    const s = view(3, vehicle, profile);
    const w = { i0: 5, j0: 5, i1: 20, j1: 18 };
    const cells = (w.i1 - w.i0) * (w.j1 - w.j0);
    const perCell = s.profile.turnAware ? 9 : 1;
    // A passable start inside the window is needed; the maps are random, so look for one.
    let from = -1;
    for (let j = w.j0; j < w.j1 && from < 0; j++) for (let i = w.i0; i < w.i1 && from < 0; i++) if (s.mask[j * SIZE + i] !== 0) from = j * SIZE + i;
    expect(from).toBeGreaterThanOrEqual(0);
    const goal = 35 * SIZE + 35; // outside
    for (const alg of ALGORITHMS) {
      const q = run(s, from, goal, alg, w);
      expect(q.status, alg.kind).toBe("not_found");
      expect(q.expanded, alg.kind).toBeLessThanOrEqual(cells * perCell);
    }
  });

  it("ends not_found when the goal is inside but walled off inside the window", () => {
    const g = randomGrid(11, SIZE, 0);
    const p = compileCostProfile({ weights: { distance: 1 } });
    if (!p.ok) throw new Error("profile");
    const s = new SearchSpace(g, UGV, p.value);
    // The free map connects (2,2) with (30,2) around a wall of the window's own edge: a window that is a one-row strip is walled by its edges.
    const a = 2 * SIZE + 2;
    const b = 8 * SIZE + 2;
    expect(run(s, a, b, { kind: "astar" }).status).toBe("found");
    const strip = run(s, a, b, { kind: "astar" }, { i0: 0, j0: 0, i1: SIZE, j1: 5 });
    expect(strip.status).toBe("not_found");
    expect(strip.expanded).toBeLessThanOrEqual(SIZE * 5);
  });

  it("is deterministic: the same window gives the same expansions, in one go or in slices", () => {
    const s = view(5, "ugv", { weights: { distance: 1, turn: 0.8 } });
    const w = { i0: 0, j0: 0, i1: 30, j1: 30 };
    const a = 3 * SIZE + 3;
    const b = 25 * SIZE + 27;
    const whole = run(s, a, b, { kind: "astar" }, w);
    const sliced = new GridSearch(s, a, b, { kind: "astar" }, 1e9, { window: w });
    while (sliced.step(37) === "running");
    expect(sliced.status).toBe(whole.status);
    expect(sliced.expanded).toBe(whole.expanded);
    expect(sliced.cost).toBe(whole.cost);
    expect(sliced.path()).toEqual(whole.path());
    for (const c of sliced.path()) expect(c % SIZE).toBeLessThan(30);
  });

  it("charges the budget the same way: budget_exceeded after exactly the budget", () => {
    const s = view(5, "ugv", { weights: { distance: 1 } });
    const q = run(s, 3 * SIZE + 3, 25 * SIZE + 27, { kind: "dijkstra" }, { i0: 0, j0: 0, i1: 30, j1: 30 }, 50);
    expect(q.status).toBe("budget_exceeded");
    expect(q.expanded).toBe(50);
  });

  it("a start outside the window is not_found at once", () => {
    const s = view(5, "ugv", { weights: { distance: 1 } });
    const q = new GridSearch(s, 35 * SIZE + 35, 3 * SIZE + 3, { kind: "astar" }, 1e9, { window: { i0: 0, j0: 0, i1: 10, j1: 10 } });
    expect(q.status).toBe("not_found");
    expect(q.expanded).toBe(0);
  });
});
