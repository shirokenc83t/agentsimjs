import { BeliefGrid, BeliefMap, GridSpace, missionOf } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile } from "../cost-profile.ts";
import { GridSearch } from "../grid/grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "../grid/search-space.ts";
import { UAV, UGV } from "../testing/fixtures.ts";
import { PlanningService, type PlanningConfig, type PlanRequest } from "./planning-service.ts";

// ADR-0040, map border rule, planning side: no cell outside the grid is passable in a planning view, none is a goal, and a search that starts in an unknown
// area touching the border never leaves the grid. A belief grid whose unknown area touches every border is the case that matters (an agent that has
// seen little of the map).

const SIZE = 40;
const KINDS: { name: string; traversal: VehicleTraversal }[] = [
  { name: "ugv", traversal: { ...UGV, inflationRadiusM: 1.5 } },
  { name: "uav", traversal: UAV },
];
const cfg: PlanningConfig = { algorithm: { kind: "astar" }, onboardComputeExpansionsPerTick: 1000, totalBudget: 1_000_000 };

function beliefWorld() {
  const world = new GridSpace({ sizeX: SIZE, sizeY: SIZE, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
  const belief = new BeliefMap(SIZE, SIZE, 16);
  for (let j = 14; j < 26; j++) for (let i = 14; i < 26; i++) belief.observeFree(i, j, 20); // a known patch in the middle; the rest, borders included, unknown
  return { world, grid: new BeliefGrid(missionOf(world), belief) };
}

describe("map border rule in the planning view (ADR-0040)", () => {
  it.each(KINDS)("no cell outside the grid is passable, $name, and the border ring is the vehicle's clearance away", ({ traversal }) => {
    const { grid } = beliefWorld();
    const p = compileCostProfile({ weights: { distance: 1 } });
    if (!p.ok) throw new Error("profile");
    const s = new SearchSpace(grid, traversal, p.value);
    for (const [i, j] of [[-1, 5], [5, -1], [SIZE, 5], [5, SIZE], [-1, -1], [SIZE, SIZE], [-100, 7], [SIZE + 100, 7]] as const) expect(s.passable(i, j), `${i},${j}`).toBe(false);
    // The unknown cells touching the border are planned through (the unknown weight), but only the ones inside.
    const i = 20;
    expect(s.passable(i, SIZE - 1) || traversal.vehicle === "ugv").toBe(true);
    if (traversal.vehicle === "ugv") expect(s.passable(i, 0)).toBe(false); // within the footprint of the border
  });

  it.each(KINDS)("a search over unknown that touches the border stays inside the grid, $name", ({ traversal }) => {
    const { grid } = beliefWorld();
    const p = compileCostProfile({ weights: { distance: 1 } });
    if (!p.ok) throw new Error("profile");
    const s = new SearchSpace(grid, traversal, p.value);
    const start = 20 * SIZE + 20;
    for (const goal of [3 * SIZE + 3, 3 * SIZE + (SIZE - 4), (SIZE - 4) * SIZE + 3, (SIZE - 4) * SIZE + (SIZE - 4)]) {
      const q = new GridSearch(s, start, goal, { kind: "astar" }, 1e9);
      q.runToCompletion();
      expect(q.status).toBe("found");
      for (const c of q.path()) expect(c >= 0 && c < SIZE * SIZE).toBe(true);
      expect(q.expanded).toBeLessThanOrEqual(SIZE * SIZE);
    }
  });

  it.each(KINDS)("a goal outside the grid is refused, $name", ({ traversal }) => {
    const { world, grid } = beliefWorld();
    const service = new PlanningService(world, { mapFor: () => grid });
    const base: PlanRequest = { agentId: "a-001", traversal, config: cfg, from: { x: 20.5, y: 20.5 }, to: { x: 30.5, y: 30.5 }, mapKey: "belief" };
    expect(service.submit(base, 1).ok).toBe(true);
    for (const to of [{ x: -0.5, y: 10 }, { x: 10, y: -0.01 }, { x: SIZE, y: 10 }, { x: 10, y: SIZE + 3 }, { x: -5, y: -5 }]) {
      const r = service.submit({ ...base, to }, 1);
      expect(r.ok, JSON.stringify(to)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_endpoint");
    }
  });
});
