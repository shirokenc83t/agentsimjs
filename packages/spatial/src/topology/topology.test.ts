import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { BeliefGrid, missionOf } from "../belief/belief-grid.ts";
import { BeliefMap } from "../belief/belief-map.ts";
import { GridSpace } from "../grid/grid-space.ts";
import type { PlanningGrid } from "../grid/planning-grid.ts";
import { buildSpaceSummary, octantOf } from "./summary.ts";
import { AgentTopology, DEFAULT_TOPOLOGY, type PassabilityView, type TopologyConfig } from "./topology.ts";

const cfg = (o: Partial<TopologyConfig> = {}): TopologyConfig => ({ ...DEFAULT_TOPOLOGY, ...o });

/** A UGV-like view: not believed occupied, and nothing believed occupied within `inflate` cells (Chebyshev). */
function viewOf(g: PlanningGrid, inflate = 0, key = `ugv/${inflate}`): PassabilityView {
  return {
    key,
    passable: (i, j) => {
      if (!g.inBounds(i, j)) return false;
      for (let dj = -inflate; dj <= inflate; dj++) for (let di = -inflate; di <= inflate; di++) if (g.inBounds(i + di, j + dj) && g.isBlocked(i + di, j + dj)) return false;
      return true;
    },
  };
}

function setup(sizeCells = 64, chunk = 8, o: Partial<TopologyConfig> = {}) {
  const world = new GridSpace({ sizeX: sizeCells, sizeY: sizeCells, resolutionM: 0.5, chunkSize: chunk, altitudeLimitsM: { min: 0, max: 100 } });
  const belief = new BeliefMap(sizeCells, sizeCells, chunk);
  const grid = new BeliefGrid(missionOf(world), belief);
  return { world, belief, grid, topo: new AgentTopology(grid, cfg({ regionChunks: 2, minFrontierCells: 1, ...o })) };
}

const free = (b: BeliefMap, i0: number, j0: number, i1: number, j1: number) => {
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) b.observeFree(i, j, 40);
};
const wall = (b: BeliefMap, i0: number, j0: number, i1: number, j1: number) => {
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) b.observeHit(i, j, 0, 40);
};

function snapshot(t: AgentTopology, v: PassabilityView) {
  t.update();
  // Waypoints are memoized per region: the incremental layer must agree with a fresh one after every update.
  return { regions: t.regions(), groups: t.frontierGroups(), edges: t.edges(v), waypoints: t.regions().map((_, r) => t.waypoint(r)) };
}

describe("topological layer v0 (ADR-0039)", () => {
  it("region IDs come from position and are clipped at the map edge; a 100 m map with regionChunks 1 gets 4 × 4", () => {
    const world = new GridSpace({ sizeX: 200, sizeY: 200, resolutionM: 0.5, chunkSize: 64 });
    const t = new AgentTopology(new BeliefGrid(missionOf(world), new BeliefMap(200, 200, 64)), cfg({ regionChunks: 1 }));
    t.update();
    const r = t.regions();
    expect(r.map((x) => x.id).slice(0, 5)).toEqual(["r-00-00", "r-01-00", "r-02-00", "r-03-00", "r-00-01"]);
    expect(r).toHaveLength(16);
    expect(r[3]).toMatchObject({ i0: 192, i1: 200, cells: 8 * 64 }); // clipped column
    expect(r[15]?.cells).toBe(8 * 8);
  });

  it("incremental maintenance equals a full rebuild after every random update (property)", () => {
    for (let s = 0; s < 30; s++) {
      const r = Rng.fromSeed(39).derive(`topology/${s}`);
      const { belief, grid, topo } = setup(48, 8);
      const v = viewOf(grid, 1);
      for (let step = 0; step < 60; step++) {
        const i = r.nextU32() % 48;
        const j = r.nextU32() % 48;
        const w = 1 + (r.nextU32() % 6);
        const h = 1 + (r.nextU32() % 6);
        if (r.nextU32() % 3 === 0) wall(belief, i, j, Math.min(48, i + w), Math.min(48, j + h));
        else free(belief, i, j, Math.min(48, i + w), Math.min(48, j + h));
        const inc = snapshot(topo, v);
        const full = snapshot(new AgentTopology(grid, topo.config), v);
        expect(inc, `seed ${s} step ${step}`).toEqual(full);
      }
    }
  });

  it("region statistics equal a brute-force count", () => {
    const { belief, grid, topo } = setup(64, 8);
    free(belief, 0, 0, 30, 20);
    wall(belief, 10, 5, 12, 40);
    topo.update();
    for (const reg of topo.regions()) {
      let known = 0;
      let occ = 0;
      for (let j = reg.j0; j < reg.j1; j++) {
        for (let i = reg.i0; i < reg.i1; i++) {
          if (grid.isUnknown(i, j)) continue;
          known++;
          if (grid.isBlocked(i, j)) occ++;
        }
      }
      expect([reg.known, reg.occupied, reg.free]).toEqual([known, occ, known - occ]);
    }
  });

  it("connectivity: a wall along a border removes the edge; unknown gaps are unexplored, known gaps open; views differ", () => {
    // Regions of 16 cells (2 chunks of 8): r-00-00 is x ∈ [0, 16), r-01-00 is [16, 32).
    const { belief, grid, topo } = setup(64, 8);
    const v = viewOf(grid);
    topo.update();
    const edge = (a: string, b: string) => topo.edges(v).find((e) => e.a === a && e.b === b)?.cls;
    expect(edge("r-00-00", "r-01-00")).toBe("unexplored"); // all unknown, passable under unknown = passable
    wall(belief, 15, 0, 16, 16);
    topo.update();
    expect(edge("r-00-00", "r-01-00")).toBeUndefined();
    free(belief, 15, 6, 17, 7);
    belief.observeFree(15, 6, 40); // a known one-cell gap through the wall
    topo.update();
    expect(edge("r-00-00", "r-01-00")).toBe("open");
    // A wider vehicle (inflated by 1 cell) cannot pass the one-cell gap.
    expect(topo.edges(viewOf(grid, 1)).find((e) => e.a === "r-00-00" && e.b === "r-01-00")).toBeUndefined();
  });

  it("small frontier groups are filtered and groups never span two regions", () => {
    const { belief, grid } = setup(64, 8);
    free(belief, 10, 2, 22, 5); // a strip crossing the border at x = 16
    belief.observeFree(40, 40, 40); // a lone cell: 1 frontier cell
    const topo = new AgentTopology(grid, cfg({ regionChunks: 2, minFrontierCells: 3 }));
    topo.update();
    const groups = topo.frontierGroups();
    expect(groups.some((g) => g.cells.includes(40 * 64 + 40))).toBe(false);
    for (const g of groups) {
      const regs = new Set(g.cells.map((c) => topo.regionOfCell(c % 64, (c / 64) | 0)));
      expect(regs.size).toBe(1);
    }
    expect(new Set(groups.map((g) => g.region))).toEqual(new Set(["r-00-00", "r-01-00"]));
  });

  it("an ideal agent's topology (ground truth) has no frontiers and every region fully known", () => {
    const world = new GridSpace({ sizeX: 32, sizeY: 32, resolutionM: 1, chunkSize: 8 });
    const t = new AgentTopology(world, cfg({ regionChunks: 2 }));
    t.update();
    expect(t.frontierGroups()).toEqual([]);
    expect(t.regions().every((r) => r.known === r.cells)).toBe(true);
  });

  it("summary: limits, orders, rounding and omitted counts", () => {
    const { belief, grid, topo } = setup(64, 8, { maxRegions: 3, maxFrontiers: 2 });
    free(belief, 0, 0, 20, 20); // the agent's surroundings, crossing into r-01-00 and r-00-01
    topo.update();
    const v = viewOf(grid);
    const s = buildSpaceSummary(topo, v, { xM: 2.2, yM: 3.9 });
    expect(s.region).toBe("r-00-00");
    expect(s.inRegionM).toEqual({ x: 2, y: 4 });
    expect(s.regions.map((r) => r.id)).toEqual(["r-00-00", "r-00-01", "r-01-00"]); // own, then 1 hop by ID
    expect(s.regions[0]).toMatchObject({ knownPct: 100, freePct: 100, waypoint: { id: "w-r-00-00" } });
    expect(s.omitted.regions).toBe(16 - 3);
    const all = topo.frontierGroups().length;
    expect(s.frontiers).toHaveLength(2);
    expect(s.omitted.frontiers).toBe(all - 2);
    expect(s.frontiers[0]?.distanceM).toBeLessThanOrEqual(s.frontiers[1]?.distanceM ?? 0);
    // Marked groups are omitted and counted.
    const marked = buildSpaceSummary(topo, v, { xM: 2.2, yM: 3.9 }, (g) => g.region === "r-01-00");
    expect(marked.omitted.markedFrontiers).toBe(topo.frontierGroups().filter((g) => g.region === "r-01-00").length);
    expect(marked.frontiers.every((f) => f.region !== "r-01-00")).toBe(true);
  });

  it("compass octants from coordinate comparisons", () => {
    expect([octantOf(1, 0), octantOf(1, 1), octantOf(0, 1), octantOf(-1, 1), octantOf(-1, 0), octantOf(-1, -1), octantOf(0, -1), octantOf(1, -1)]).toEqual(["E", "NE", "N", "NW", "W", "SW", "S", "SE"]);
    expect(octantOf(10, 4)).toBe("E"); // below 22.5°
    expect(octantOf(10, 5)).toBe("NE");
  });

  it("locality: two agents with different beliefs over the same world get different summaries", () => {
    const a = setup(64, 8);
    const b = setup(64, 8);
    free(a.belief, 0, 0, 20, 20);
    free(b.belief, 0, 0, 20, 20);
    wall(b.belief, 5, 0, 6, 20);
    a.topo.update();
    b.topo.update();
    const sa = buildSpaceSummary(a.topo, viewOf(a.grid), { xM: 1, yM: 1 });
    const sb = buildSpaceSummary(b.topo, viewOf(b.grid), { xM: 1, yM: 1 });
    expect(sa).not.toEqual(sb);
  });
});
