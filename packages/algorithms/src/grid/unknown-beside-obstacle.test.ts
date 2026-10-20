import { BeliefGrid, BeliefMap, GridSpace, missionOf } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile } from "../cost-profile.ts";
import { GridSearch } from "./grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "./search-space.ts";

// ADR-0040 addition of 2026-10-19 (second): in the planning view an unknown cell 4-adjacent to a cell the belief map knows as blocked (at the vehicle's
// altitude for a UAV) counts as blocked while it stays unknown, for ground and aerial vehicles; inflation applies to it as to any blocked cell; once it
// is observed it takes its observed value. A lidar sees the near face of a wall: the unseen body behind it is not a way through.

const UAV: VehicleTraversal = { vehicle: "uav", cruiseAltitudeM: 20, clearanceM: 2, speedMps: 8, energyWhPerM: 0.02 };
const UGV: VehicleTraversal = { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 };
const UGV_FAT: VehicleTraversal = { ...UGV, inflationRadiusM: 1.2 };
const SIZE = 30;

function profile() {
  const c = compileCostProfile({ weights: { distance: 1 } });
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

/** A belief map in which only a free band y = 4 … 6 (north of the wall) and a wall segment x = 10 … 14, y = 3 are known; everything else is unknown. */
function world() {
  const gs = new GridSpace({ sizeX: SIZE, sizeY: SIZE, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
  const belief = new BeliefMap(SIZE, SIZE, 16);
  for (let i = 0; i < SIZE; i++) for (let j = 4; j <= 6; j++) belief.observeFree(i, j, 20);
  for (let i = 10; i <= 14; i++) belief.observeHit(i, 3, 0, 40); // the near (north) face of a wall: what a lidar to the north sees
  return { belief, grid: new BeliefGrid(missionOf(gs), belief) };
}

const cell = (i: number, j: number) => j * SIZE + i;

function search(space: SearchSpace, from: [number, number], to: [number, number]) {
  const q = new GridSearch(space, cell(...from), cell(...to), { kind: "astar" }, 1_000_000);
  q.step(1_000_000);
  return q;
}

describe.each([
  ["ground", UGV],
  ["aerial", UAV],
])("an unknown cell beside a known obstacle, %s vehicle", (_, traversal) => {
  it("is blocked in the planning view while it stays unknown, and a path never crosses it", () => {
    const { grid } = world();
    const space = new SearchSpace(grid, traversal, profile());
    expect(grid.isUnknown(12, 2)).toBe(true);
    // South of the known face of the wall: unknown and 4-adjacent to the known blocked cell (12, 3).
    expect(space.passable(12, 2)).toBe(false);
    expect(space.passable(9, 3)).toBe(false); // beside the wall's end: unknown, 4-adjacent to (10, 3)
    expect(space.passable(15, 3)).toBe(false);
    // Unknown but not beside any known obstacle: still planned through (optimistic, weight 1).
    expect(space.passable(12, 0)).toBe(true);
    expect(space.passable(20, 10)).toBe(true);
    // A path south of the wall from one side to the other cannot go through (12, 2), (9, 3) or (15, 3).
    const p = search(space, [6, 3], [18, 3]);
    expect(p.status === "found" ? p.path() : []).not.toContain(cell(12, 2));
    const crossing = search(space, [12, 5], [12, 1]); // straight through the wall's body to the unknown beyond
    expect(crossing.status === "found" ? crossing.path().some((c) => c === cell(12, 3) || c === cell(12, 2)) : false).toBe(false);
  });

  it("takes its observed value once it is observed: free opens it, occupied keeps it blocked", () => {
    const { belief, grid } = world();
    const space = new SearchSpace(grid, traversal, profile());
    expect(space.passable(12, 2)).toBe(false);
    belief.observeFree(12, 2, 20);
    space.sync();
    expect(grid.isUnknown(12, 2)).toBe(false);
    expect(space.passable(12, 2)).toBe(true);
    expect(space.passable(11, 2)).toBe(false); // its neighbour is still unknown and still beside the wall
    belief.observeHit(11, 2, 0, 40);
    space.sync();
    expect(space.passable(11, 2)).toBe(false);
    expect(space.passable(10, 2)).toBe(false); // now beside a second known obstacle
  });

  it("a view synced cell by cell equals a view built from scratch (change stamps and caches)", () => {
    const { belief, grid } = world();
    const live = new SearchSpace(grid, traversal, profile());
    for (const [i, j] of [[12, 2], [11, 2], [10, 2], [16, 5], [16, 4]] as const) {
      if (j === 2 || (i === 16 && j === 5)) belief.observeFree(i, j, 20);
      else belief.observeHit(i, j, 0, 40);
      live.sync();
      const fresh = new SearchSpace(grid, traversal, profile());
      expect(Array.from(live.mask), `after (${i}, ${j})`).toEqual(Array.from(fresh.mask));
    }
  });
});

describe("the inflation applies to the blocked unknown cell", () => {
  it("a ground vehicle with a footprint keeps its distance from the unseen body of a wall, too", () => {
    const { grid } = world();
    const plain = new SearchSpace(grid, UGV, profile());
    const fat = new SearchSpace(grid, UGV_FAT, profile());
    // (12, 4) is known free beside the wall's face (12, 3); (12, 1) is unknown, one cell south of the unknown-blocked row y = 2.
    expect(plain.passable(12, 4)).toBe(true);
    expect(fat.passable(12, 4)).toBe(false); // 1.2 m of inflation reaches the wall
    expect(plain.passable(12, 1)).toBe(true); // not beside any known obstacle
    expect(fat.passable(12, 1)).toBe(false); // but within reach of the blocked unknown row y = 2: the inflation applies to it as to any blocked cell
  });

  it("an aerial view treats an obstacle below its altitude as no obstacle: nothing beside it is blocked", () => {
    const gs = new GridSpace({ sizeX: SIZE, sizeY: SIZE, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
    const belief = new BeliefMap(SIZE, SIZE, 16);
    for (let i = 10; i <= 14; i++) belief.observeUnder(i, 3, 5, 30); // a low wall, top 5 m, seen from 30 m
    const grid = new BeliefGrid(missionOf(gs), belief);
    const space = new SearchSpace(grid, UAV, profile()); // at 20 m with 2 m of clearance
    expect(space.passable(12, 3)).toBe(true);
    expect(space.passable(12, 2)).toBe(true); // unknown, beside a cell that is no obstacle at this altitude
  });
});

describe("ground-truth views are unchanged", () => {
  it("a view over the ground truth has no unknown cells and so no such rule", () => {
    const gs = new GridSpace({ sizeX: 10, sizeY: 10, resolutionM: 1, chunkSize: 16 });
    gs.setCell("occupancy", 5, 5, 1);
    const space = new SearchSpace(gs, UGV, profile());
    expect(space.passable(5, 5)).toBe(false);
    expect(space.passable(5, 6)).toBe(true);
    expect(space.passable(4, 5)).toBe(true);
  });
});
