import { Rng } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile } from "../cost-profile.ts";
import { GridSearch } from "./grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "./search-space.ts";

const profile = (() => {
  const r = compileCostProfile({ weights: { distance: 1 } });
  if (!r.ok) throw new Error("profile");
  return r.value;
})();

const ugv = (inflationRadiusM: number): VehicleTraversal => ({ vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.5, inflationRadiusM });

function grid(size = 40): GridSpace {
  return new GridSpace({ sizeX: size, sizeY: size, resolutionM: 0.5, chunkSize: 16 });
}

const free = (s: SearchSpace, i: number, j: number) => s.passable(i, j);

describe("footprint inflation of planning masks (UGV footprint + tracking margin)", () => {
  it("blocks every cell whose footprint disk would overlap an obstacle cell", () => {
    const g = grid();
    g.setCell("occupancy", 20, 20, OCCUPANCY_BLOCKED);
    const s = new SearchSpace(g, ugv(0.75), profile);
    // r = 0.75 m at 0.5 m cells: the 3 × 3 block around the obstacle; (2, 0) and (2, 1) offsets are clear.
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) expect(free(s, 20 + di, 20 + dj), `${di},${dj}`).toBe(false);
    expect(free(s, 22, 20)).toBe(true);
    expect(free(s, 22, 21)).toBe(true);
    // A larger radius blocks further out.
    const wide = new SearchSpace(g, ugv(1.3), profile);
    // 1.3 m = 2.6 cells: the square at (2, 2) is 2.12 cells away (blocked), at (3, 3) 3.54 cells (clear).
    expect(free(wide, 22, 20)).toBe(false);
    expect(free(wide, 22, 22)).toBe(false);
    expect(free(wide, 23, 23)).toBe(true);
  });

  it("treats the map border as an obstacle", () => {
    const s = new SearchSpace(grid(), ugv(0.75), profile);
    expect(free(s, 0, 10)).toBe(false);
    expect(free(s, 1, 10)).toBe(true);
    expect(free(s, 39, 10)).toBe(false);
    expect(free(s, 38, 38)).toBe(true);
  });

  it("radius 0 leaves the mask unchanged, and the radius is part of the view's cache key", () => {
    const g = grid();
    g.setCell("occupancy", 5, 5, OCCUPANCY_BLOCKED);
    const none = new SearchSpace(g, ugv(0), profile);
    const legacy = new SearchSpace(g, { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.5 }, profile);
    expect(none.mask).toEqual(legacy.mask);
    expect(free(none, 0, 0)).toBe(true);
    expect(SearchSpace.key(ugv(0.75), profile)).not.toBe(SearchSpace.key(ugv(0.5), profile));
  });

  it("local sync after edits equals a fresh build, including edits near chunk borders", () => {
    const g = grid(64);
    const rng = Rng.fromSeed(3).derive("inflation/edits");
    const current = new SearchSpace(g, ugv(1.1), profile); // live: synced in place
    for (let round = 0; round < 30; round++) {
      const i = rng.intRange(0, 63);
      const j = rng.intRange(0, 63);
      g.setCell("occupancy", i, j, g.isBlocked(i, j) ? 0 : OCCUPANCY_BLOCKED);
      if (round % 3 === 0) g.setCell("occupancy", 15, j, OCCUPANCY_BLOCKED); // chunk border column
      current.sync();
      expect(current.mask, `round ${round}`).toEqual(new SearchSpace(g, ugv(1.1), profile).mask);
    }
  });

  it("planned paths keep the inflation distance from obstacles", () => {
    const g = grid();
    for (let j = 0; j < 30; j++) g.setCell("occupancy", 20, j, OCCUPANCY_BLOCKED); // wall with a gap at the top
    const s = new SearchSpace(g, ugv(0.75), profile);
    const q = new GridSearch(s, 10 * 40 + 5, 10 * 40 + 35, { kind: "astar" }, 1_000_000);
    q.runToCompletion();
    expect(q.status).toBe("found");
    for (const cell of q.path()) {
      const ci = cell % 40;
      const cj = (cell / 40) | 0;
      for (let j = 0; j < 30; j++) {
        const dx = Math.max(Math.abs(ci - 20) - 0.5, 0) * 0.5;
        const dy = Math.max(Math.abs(cj - j) - 0.5, 0) * 0.5;
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(0.75);
      }
    }
  });
});
