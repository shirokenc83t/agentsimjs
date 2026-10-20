import { describe, expect, it } from "vitest";
import { BeliefGrid, missionOf } from "../belief/belief-grid.ts";
import { BeliefMap } from "../belief/belief-map.ts";
import { GridSpace } from "../grid/grid-space.ts";
import { AgentTopology, DEFAULT_TOPOLOGY } from "./topology.ts";

// ADR-0040, map border rule: the outside of the map is not unknown. A cell outside the grid is never a frontier cell, a frontier group never holds one,
// and a known free cell on the border is a frontier only when an unknown cell inside the map touches it.

const SIZE = 48;

function setup() {
  const world = new GridSpace({ sizeX: SIZE, sizeY: SIZE, resolutionM: 0.5, chunkSize: 8, altitudeLimitsM: { min: 0, max: 100 } });
  const belief = new BeliefMap(SIZE, SIZE, 8);
  const grid = new BeliefGrid(missionOf(world), belief);
  const topo = new AgentTopology(grid, { ...DEFAULT_TOPOLOGY, regionChunks: 2, minFrontierCells: 1 });
  return { belief, grid, topo };
}

const free = (b: BeliefMap, i0: number, j0: number, i1: number, j1: number) => {
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) b.observeFree(i, j, 40);
};

describe("map border rule (ADR-0040)", () => {
  it("a map known free up to every border has no frontier: the outside is not unknown", () => {
    const { belief, topo } = setup();
    free(belief, 0, 0, SIZE, SIZE);
    topo.update();
    expect(topo.frontierGroups()).toEqual([]);
  });

  it("a free strip on the border has frontier only along the unknown cells inside the map", () => {
    const { belief, grid, topo } = setup();
    free(belief, 0, 0, SIZE, 6); // the whole top strip, touching the left, right and top borders
    topo.update();
    const cells = topo.frontierGroups().flatMap((g) => [...g.cells]);
    expect(cells.length).toBe(SIZE); // row 5, next to the unknown row 6
    for (const c of cells) {
      const i = c % SIZE;
      const j = (c / SIZE) | 0;
      expect(grid.inBounds(i, j)).toBe(true);
      expect(j).toBe(5);
      expect(topo.isFrontierCell(c)).toBe(true);
    }
    // The cells of the border itself that nothing unknown touches are no frontier.
    for (const c of [0, SIZE - 1, 2 * SIZE, 2 * SIZE + SIZE - 1]) expect(topo.isFrontierCell(c)).toBe(false);
  });

  it("unknown that touches the border never makes a cell outside a frontier, in any corner", () => {
    const { belief, grid, topo } = setup();
    // Known free islands in all four corners and the middle of each side, each with unknown cells around it inside the map.
    for (const [i0, j0] of [[0, 0], [SIZE - 5, 0], [0, SIZE - 5], [SIZE - 5, SIZE - 5], [21, 0], [21, SIZE - 5], [0, 21], [SIZE - 5, 21]] as const) free(belief, i0, j0, i0 + 5, j0 + 5);
    topo.update();
    const groups = topo.frontierGroups();
    expect(groups.length).toBeGreaterThanOrEqual(8);
    for (const g of groups) {
      for (const c of g.cells) {
        const i = c % SIZE;
        const j = (c / SIZE) | 0;
        expect(grid.inBounds(i, j), `cell ${i},${j}`).toBe(true);
        expect(grid.isUnknown(i, j)).toBe(false);
      }
    }
    // Out-of-range indices are not frontier cells either.
    expect(topo.isFrontierCell(-1)).toBe(false);
    expect(topo.isFrontierCell(SIZE * SIZE)).toBe(false);
  });
});
