import { Rng } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { isValidPath, pathCost, randomGrid, referenceCost, space, UGV } from "../testing/fixtures.ts";
import { AbstractGraph } from "./abstract-graph.ts";
import { HpaQuery } from "./hpa-query.ts";

const solve = (g: AbstractGraph, a: number, b: number, budget = 1e9) => {
  const q = new HpaQuery(g, a, b, budget);
  while (q.step(1 << 20) === "running");
  return q;
};

describe("HPA*", () => {
  it("finds valid near-optimal paths whenever a path exists (random grids)", () => {
    const rng = Rng.fromSeed(9).derive("hpa");
    let worst = 1;
    for (let trial = 0; trial < 10; trial++) {
      const grid = randomGrid(100 + trial, 64, 0.2, 16);
      const s = space(grid, UGV, { weights: { distance: 1, terrain: trial % 2 } });
      const graph = new AbstractGraph(s);
      for (let q = 0; q < 6; q++) {
        const a = rng.intRange(0, 64 * 64 - 1);
        const b = rng.intRange(0, 64 * 64 - 1);
        const ref = referenceCost(s, a, b);
        const r = solve(graph, a, b);
        if (ref === Infinity) {
          expect(r.status).toBe("not_found"); // completeness both ways
          continue;
        }
        expect(r.status).toBe("found");
        const p = r.path();
        expect(p[0]).toBe(a);
        expect(p.at(-1)).toBe(b);
        expect(isValidPath(s, p)).toBe(true);
        expect(pathCost(s, p)).toBeCloseTo(r.cost, 6);
        expect(r.cost).toBeGreaterThanOrEqual(ref - 1e-9);
        worst = Math.max(worst, r.cost / Math.max(ref, 1e-9));
      }
    }
    expect(worst).toBeLessThan(1.35); // HPA* is near-optimal on these maps
  });

  it("is resumable and deterministic", () => {
    const s = space(randomGrid(5, 64, 0.2, 16));
    const graph = new AbstractGraph(s);
    const big = solve(graph, 1 * 64 + 1, 62 * 64 + 62);
    const sliced = new HpaQuery(graph, 1 * 64 + 1, 62 * 64 + 62, 1e9);
    while (sliced.step(37) === "running");
    expect(sliced.status).toBe(big.status);
    expect(sliced.expanded).toBe(big.expanded);
    expect(sliced.path()).toEqual(big.path());
  });

  it("enforces the total budget", () => {
    const s = space(new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 }));
    const q = solve(new AbstractGraph(s), 0, 64 * 64 - 1, 100);
    expect(q.status).toBe("budget_exceeded");
    expect(q.expanded).toBe(100);
  });

  // With footprint inflation, a mask change reaches a few cells beyond its chunk: still inside the 3×3 block.
  it.each([0, 1.2])("local rebuild after edits equals a full rebuild, and paths stay correct (inflation %s m)", (inflationRadiusM) => {
    const rng = Rng.fromSeed(21).derive("hpa-rebuild");
    const grid = randomGrid(42, 128, 0.15, 16); // 8 × 8 = 64 clusters
    const t = { ...UGV, inflationRadiusM };
    const s = space(grid, t);
    const graph = new AbstractGraph(s);
    for (let round = 0; round < 6; round++) {
      const i = rng.intRange(0, 127);
      const j = rng.intRange(0, 127);
      grid.setCell("occupancy", i, j, grid.isBlocked(i, j) ? 0 : OCCUPANCY_BLOCKED);
      const rebuilt = graph.sync();
      expect(rebuilt.length).toBeGreaterThan(0);
      expect(rebuilt.length).toBeLessThanOrEqual(9); // one edit: only the 3×3 block around its cluster
      const fresh = new AbstractGraph(space(grid, t));
      expect(graph.canonical()).toBe(fresh.canonical());
      const a = rng.intRange(0, 128 * 128 - 1);
      const b = rng.intRange(0, 128 * 128 - 1);
      const ref = referenceCost(s, a, b);
      const r = solve(graph, a, b);
      expect(r.status).toBe(ref === Infinity ? "not_found" : "found");
      if (r.status === "found") expect(isValidPath(s, r.path())).toBe(true);
    }
  });

  it("handles start and goal in the same cluster, and start == goal", () => {
    const s = space(new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 }));
    const graph = new AbstractGraph(s);
    const same = solve(graph, 2 * 64 + 2, 10 * 64 + 9);
    expect(same.status).toBe("found");
    expect(same.cost).toBeCloseTo(referenceCost(s, 2 * 64 + 2, 10 * 64 + 9), 9);
    const self = solve(graph, 5 * 64 + 5, 5 * 64 + 5);
    expect(self.status).toBe("found");
    expect(self.cost).toBe(0);
    expect(self.path()).toEqual([5 * 64 + 5]);
  });
});

describe("HPA* coarse path (ADR-0037 addition of 2026-10-13, §6: refine's coarse node)", () => {
  const solveCoarse = (g: AbstractGraph, a: number, b: number) => {
    const q = new HpaQuery(g, a, b, 1e9, { coarseOnly: true });
    while (q.step(1 << 20) === "running");
    return q;
  };

  it("ends at the end of the abstract phase with the same charge as the full query, and its coarse cells are the full path's entrances", () => {
    const rng = Rng.fromSeed(31).derive("hpa-coarse");
    let checked = 0;
    for (let trial = 0; trial < 6; trial++) {
      const s = space(randomGrid(300 + trial, 64, 0.18, 16), UGV, { weights: { distance: 1, terrain: trial % 2 } });
      const graph = new AbstractGraph(s);
      for (let q = 0; q < 6; q++) {
        const a = rng.intRange(0, 64 * 64 - 1);
        const b = rng.intRange(0, 64 * 64 - 1);
        const full = solve(graph, a, b);
        const coarse = solveCoarse(graph, a, b);
        expect(coarse.status).toBe(full.status);
        if (full.status !== "found") continue;
        // Refinement costs no expansions (ADR-0024), so both charge the same.
        expect(coarse.expanded).toBe(full.expanded);
        expect(coarse.cost).toBeCloseTo(full.cost, 9);
        expect(coarse.path()).toEqual([]); // a coarse query returns waypoints, not a path
        const waypoints = coarse.coarseCells();
        expect(waypoints[0]).toBe(a);
        expect(waypoints.at(-1)).toBe(b);
        // Every waypoint lies on the refined path, in order.
        const path = full.path();
        let at = 0;
        for (const w of waypoints) {
          const k = path.indexOf(w, at);
          expect(k, `waypoint ${w}`).toBeGreaterThanOrEqual(at);
          at = k;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("start and goal in one cluster, and start == goal, give just those cells", () => {
    const s = space(new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 }));
    const graph = new AbstractGraph(s);
    const same = solveCoarse(graph, 2 * 64 + 2, 10 * 64 + 9);
    expect(same.status).toBe("found");
    expect(same.coarseCells()).toEqual([2 * 64 + 2, 10 * 64 + 9]);
    const self = solveCoarse(graph, 5 * 64 + 5, 5 * 64 + 5);
    expect(self.status).toBe("found");
    expect(self.coarseCells()).toEqual([5 * 64 + 5, 5 * 64 + 5]);
  });

  it("a coarse query that finds nothing has no coarse cells", () => {
    const g = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 64; j++) g.setCell("occupancy", 32, j, OCCUPANCY_BLOCKED); // a wall across the map
    const graph = new AbstractGraph(space(g));
    const q = solveCoarse(graph, 5 * 64 + 5, 5 * 64 + 60);
    expect(q.status).toBe("not_found");
    expect(q.coarseCells()).toEqual([]);
  });
});
