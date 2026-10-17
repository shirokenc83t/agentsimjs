import { describe, expect, it } from "vitest";
import { GridSpace } from "../grid/grid-space.ts";
import { BeliefGrid, missionOf } from "./belief-grid.ts";
import { BeliefMap } from "./belief-map.ts";
import { applyPrior, PRIOR_FREE, type PriorMap } from "./prior-map.ts";

const world = () => new GridSpace({ sizeX: 40, sizeY: 10, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });

describe("BeliefGrid: the planner's map from an agent's beliefs (ADR-0012, ADR-0028 additions of 2026-10-09)", () => {
  it("holds no reference to the ground-truth grid: only mission data (size, zones, limits) copied out", () => {
    const g = world();
    const bg = new BeliefGrid(missionOf(g), new BeliefMap(g.sizeX, g.sizeY, g.chunkSize));
    expect(Object.values(bg).some((v) => v === g)).toBe(false);
    expect([bg.sizeX, bg.sizeY, bg.resolutionM, bg.chunkSize]).toEqual([40, 10, 1, 16]);
  });

  it("unknown cells are unknown, passable for every vehicle (not obstacles of unknown height)", () => {
    const g = world();
    const bg = new BeliefGrid(missionOf(g), new BeliefMap(g.sizeX, g.sizeY, g.chunkSize));
    expect(bg.isUnknown(5, 5)).toBe(true);
    expect(bg.isBlocked(5, 5)).toBe(false);
    expect(bg.obstacleTopM(5, 5)).toBe(0);
  });

  it("2.5D: a building seen under a beam at 30 m (lower edge 28 m) is passable at 30 m and blocks at 5 m", () => {
    const g = world();
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    for (let k = 0; k < 2; k++) b.observeUnder(10, 5, 28, 30); // occupied, top below 28 m
    const bg = new BeliefGrid(missionOf(g), b);
    expect(bg.isBlocked(10, 5)).toBe(true); // ground vehicles: any believed obstacle blocks
    expect(bg.obstacleTopM(10, 5)).toBe(28);
    const clearance = 2;
    expect(30 >= bg.obstacleTopM(10, 5) + clearance).toBe(true);
    expect(5 >= bg.obstacleTopM(10, 5) + clearance).toBe(false);
  });

  it("an occupied cell with an unknown upper bound blocks aircraft at every altitude", () => {
    const g = world();
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    b.observeHit(12, 5, 30, 30);
    const bg = new BeliefGrid(missionOf(g), b);
    expect(bg.obstacleTopM(12, 5)).toBe(Number.POSITIVE_INFINITY);
  });

  it("terrain and ground height are nominal without a prior (F2 limitation)", () => {
    const g = world();
    g.setCell("terrainCost", 3, 3, 200); // ground truth marsh: not known to the agent
    const bg = new BeliefGrid(missionOf(g), new BeliefMap(g.sizeX, g.sizeY, g.chunkSize));
    expect(bg.terrainAt(3, 3)).toBe(10);
    expect(bg.groundHeightM(3, 3)).toBe(0);
  });

  it("an occupied cell with an unknown upper bound takes the scenario's defaultObstacleHeightM when set", () => {
    const g = new GridSpace({ sizeX: 40, sizeY: 10, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 }, defaultObstacleHeightM: 12 });
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    b.observeHit(12, 5, 3, 30);
    expect(new BeliefGrid(missionOf(g), b).obstacleTopM(12, 5)).toBe(12);
  });

  it("with a prior: terrain and ground height from the prior where it knows the cell, nominal where it does not", () => {
    const g = world();
    const n = g.sizeX * g.sizeY;
    const prior: PriorMap = {
      id: "survey",
      sizeX: g.sizeX,
      sizeY: g.sizeY,
      confidence: 1,
      knowledge: new Uint8Array(n),
      heightDm: new Uint16Array(n),
      terrainCost: new Uint8Array(n).fill(10),
    };
    const k = (i: number, j: number) => j * g.sizeX + i;
    prior.knowledge[k(3, 3)] = PRIOR_FREE;
    prior.terrainCost?.set([200], k(3, 3));
    prior.heightDm?.set([25], k(3, 3));
    prior.terrainCost?.set([200], k(4, 3)); // not known: ignored
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    applyPrior(b, prior);
    const bg = new BeliefGrid(missionOf(g), b, prior);
    expect(bg.terrainAt(3, 3)).toBe(200);
    expect(bg.groundHeightM(3, 3)).toBe(2.5);
    expect(bg.obstacleTopM(3, 3)).toBe(2.5);
    expect(bg.terrainAt(4, 3)).toBe(10);
    expect(bg.groundHeightM(4, 3)).toBe(0);
  });

  it("its version follows planning-relevant changes only: a log-odds step that keeps the state changes nothing", () => {
    const g = world();
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    const bg = new BeliefGrid(missionOf(g), b);
    const v0 = bg.version;
    b.observeFree(1, 1, 20); // unknown → free: a planning change
    const v1 = bg.version;
    expect(v1).toBeGreaterThan(v0);
    expect(bg.chunksChangedSince(v0)).toEqual([0]);
    b.observeFree(1, 1, 20); // still free
    expect(bg.version).toBe(v1);
  });
});

describe("BeliefGrid.snapshotCopy: the planner's map frozen at a moment (F2b M4, ADR-0037 item 16)", () => {
  it("answers every cell as the original did at the copy, and does not follow later changes", () => {
    const g = world();
    const b = new BeliefMap(g.sizeX, g.sizeY, g.chunkSize);
    for (let k = 0; k < 2; k++) b.observeUnder(10, 5, 28, 30);
    b.observeFree(3, 3, 25);
    const bg = new BeliefGrid(missionOf(g), b);
    const copy = bg.snapshotCopy();
    expect(copy.version).toBe(bg.version);
    for (let j = 0; j < g.sizeY; j++) {
      for (let i = 0; i < g.sizeX; i++) {
        expect([copy.isBlocked(i, j), copy.isUnknown(i, j), copy.obstacleTopM(i, j)]).toEqual([bg.isBlocked(i, j), bg.isUnknown(i, j), bg.obstacleTopM(i, j)]);
      }
    }
    b.observeContact(20, 5, 3);
    expect(bg.isBlocked(20, 5)).toBe(true);
    expect(copy.isBlocked(20, 5)).toBe(false);
    expect(copy.version).not.toBe(bg.version);
  });

  it("keeps the prior's terrain and ground height and the mission data, and shares no belief map", () => {
    const g = world();
    const n = g.sizeX * g.sizeY;
    const prior: PriorMap = {
      id: "p",
      sizeX: g.sizeX,
      sizeY: g.sizeY,
      knowledge: new Uint8Array(n).fill(PRIOR_FREE),
      terrainCost: new Uint8Array(n).fill(20),
      heightDm: new Uint16Array(n).fill(50),
    } as unknown as PriorMap;
    const bg = new BeliefGrid(missionOf(g), new BeliefMap(g.sizeX, g.sizeY, g.chunkSize), prior);
    const copy = bg.snapshotCopy();
    expect(copy.belief).not.toBe(bg.belief);
    expect([copy.terrainAt(4, 4), copy.groundHeightM(4, 4)]).toEqual([20, 5]);
    expect([copy.sizeX, copy.sizeY, copy.chunkSize, copy.altitudeLimitsM]).toEqual([bg.sizeX, bg.sizeY, bg.chunkSize, bg.altitudeLimitsM]);
  });
});
