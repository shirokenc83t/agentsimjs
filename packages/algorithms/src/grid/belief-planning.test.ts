import { applyPrior, BeliefGrid, BeliefMap, GridSpace, missionOf, PRIOR_FREE, PRIOR_OCCUPIED, type PriorMap } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile, type CostProfile } from "../cost-profile.ts";
import { GridSearch } from "./grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "./search-space.ts";

const UAV_AT = (altitudeM: number): VehicleTraversal => ({ vehicle: "uav", cruiseAltitudeM: altitudeM, clearanceM: 2, speedMps: 8, energyWhPerM: 0.02 });
const UGV: VehicleTraversal = { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 };

function profile(p: CostProfile = { weights: { distance: 1 } }) {
  const c = compileCostProfile(p);
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

/** 40 × 20 world at 1 m; the agent's beliefs start empty. */
function setup() {
  const world = new GridSpace({ sizeX: 40, sizeY: 20, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
  const belief = new BeliefMap(world.sizeX, world.sizeY, world.chunkSize);
  return { world, belief, grid: new BeliefGrid(missionOf(world), belief) };
}

function plan(space: SearchSpace, from: [number, number], to: [number, number]): { status: string; cells: readonly number[] } {
  const s = new GridSearch(space, from[1] * space.sizeX + from[0], to[1] * space.sizeX + to[0], { kind: "astar" }, 1_000_000);
  s.step(1_000_000);
  return { status: s.status, cells: s.path() };
}

describe("planning on an agent's belief map (F2 M2b)", () => {
  it("2.5D: a wall of buildings seen under a beam at 30 m is crossed at 30 m and blocks at 5 m", () => {
    const { belief, grid } = setup();
    // A wall across the map at x = 20, observed occupied with tops below 28 m (seen from 30 m).
    for (let j = 0; j < 20; j++) for (let k = 0; k < 2; k++) belief.observeUnder(20, j, 28, 30);
    const high = plan(new SearchSpace(grid, UAV_AT(30), profile()), [2, 10], [37, 10]);
    expect(high.status).toBe("found");
    expect(high.cells.length).toBe(36); // straight across
    const low = plan(new SearchSpace(grid, UAV_AT(5), profile()), [2, 10], [37, 10]);
    expect(low.status).toBe("not_found");
  });

  it("unknown cells are planned through at the default weight 1, and avoided when the profile weighs them", () => {
    const { belief, grid } = setup();
    // The agent knows a free corridor along y = 0..2; everything else is unknown.
    for (let i = 0; i < 40; i++) for (let j = 0; j < 3; j++) belief.observeFree(i, j, 20);
    const optimistic = plan(new SearchSpace(grid, UGV, profile()), [2, 10], [37, 10]);
    expect(optimistic.status).toBe("found");
    expect(optimistic.cells.length).toBe(36); // straight through unknown ground
    const cautious = plan(new SearchSpace(grid, UGV, profile({ weights: { distance: 1, unknown: 20 } })), [2, 10], [37, 10]);
    expect(cautious.status).toBe("found");
    expect(cautious.cells.some((c) => ((c / 40) | 0) <= 2)).toBe(true); // detours through the known corridor
  });

  it("a prior's wall that the world does not have is planned around; the prior's terrain is costed", () => {
    const world = new GridSpace({ sizeX: 40, sizeY: 20, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
    const n = world.sizeX * world.sizeY;
    // Stale survey: a wall at x = 20 except a gap at y = 18, and costly ground (×5) on row y = 10.
    const prior: PriorMap = { id: "stale", sizeX: 40, sizeY: 20, confidence: 1, knowledge: new Uint8Array(n).fill(PRIOR_FREE), heightDm: undefined, terrainCost: new Uint8Array(n).fill(10) };
    for (let j = 0; j < 20; j++) if (j !== 18) prior.knowledge[j * 40 + 20] = PRIOR_OCCUPIED;
    for (let i = 0; i < 40; i++) prior.terrainCost?.set([50], 10 * 40 + i);
    const belief = new BeliefMap(world.sizeX, world.sizeY, world.chunkSize);
    applyPrior(belief, prior);
    const grid = new BeliefGrid(missionOf(world), belief, prior);
    const p = plan(new SearchSpace(grid, UGV, profile({ weights: { distance: 1, terrain: 1 } })), [2, 10], [37, 10]);
    expect(p.status).toBe("found");
    expect(p.cells).toContain(18 * 40 + 20); // through the prior's gap, though the true world is open
    expect(p.cells.filter((c) => ((c / 40) | 0) === 10).length).toBeLessThan(4); // leaves the costly row at once
  });

  it("ground-truth views have no unknown cells: their costs are unchanged", () => {
    const world = new GridSpace({ sizeX: 10, sizeY: 10, resolutionM: 1, chunkSize: 16 });
    expect(new SearchSpace(world, UGV, profile({ weights: { distance: 1, unknown: 5 } })).unknown).toBeNull();
  });
});
