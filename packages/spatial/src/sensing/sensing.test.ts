import { describe, expect, it } from "vitest";
import { GridSpace, OCCUPANCY_BLOCKED } from "../grid/grid-space.ts";
import { cameraSees, newCameraScratch } from "./camera.ts";
import { newRangeScratch, senseRay, type RangeSink } from "./range-sensor.ts";
import { periodUs, readsAtTick, sensorPhaseUs } from "./schedule.ts";

/** 40 × 10 m grid at 1 m: flat, free ground unless painted. */
function grid(): GridSpace {
  return new GridSpace({ sizeX: 40, sizeY: 10, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 120 } });
}

function wall(g: GridSpace, i: number, heightM?: number): void {
  for (let j = 0; j < 10; j++) {
    g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED);
    if (heightM !== undefined) g.setCell("heightDm", i, j, Math.round(heightM * 10));
  }
}

/** Records what a ray reported, in order. */
function recorder(): RangeSink & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    free: (i, j) => log.push(`free ${i},${j}`),
    under: (i, j, up) => log.push(`under ${i},${j} <${up}`),
    hit: (i, j, low) => log.push(`hit ${i},${j} >=${low}`),
  };
}

const ray = (over: Partial<Parameters<typeof senseRay>[1]> = {}): Parameters<typeof senseRay>[1] => ({
  x: 0.5, y: 5.5, zM: 0.5, beamLowerM: 0, dirX: 1, dirY: 0, rangeM: 30, noiseM: 0, marginM: 0, ...over,
});

describe("2.5D range sensing (ADR-0012 addition of 2026-10-09)", () => {
  it("free ground is observed free, cell by cell, up to the range; nothing past it", () => {
    const s = recorder();
    const d = senseRay(grid(), ray({ rangeM: 3.2 }), s, newRangeScratch(4, 1));
    expect(s.log).toEqual(["free 0,5", "free 1,5", "free 2,5", "free 3,5"]);
    expect(d).toBe(-1);
  });

  it("a hit stops the ray and bounds the obstacle's top from below at the beam's lower edge", () => {
    const g = grid();
    wall(g, 5); // unknown height without a default: unlimited
    const s = recorder();
    const d = senseRay(g, ray({ zM: 0.5, beamLowerM: 0 }), s, newRangeScratch(30, 1));
    expect(s.log).toEqual(["free 0,5", "free 1,5", "free 2,5", "free 3,5", "free 4,5", "hit 5,5 >=0"]);
    expect(d).toBeCloseTo(4.5);
  });

  it("an obstacle under the beam is observed occupied with an upper bound, never free, and the ray goes on", () => {
    const g = grid();
    wall(g, 5, 12); // a 12 m building
    wall(g, 9); // an unlimited wall further on
    const s = recorder();
    senseRay(g, ray({ zM: 30, beamLowerM: 28 }), s, newRangeScratch(30, 1));
    expect(s.log).toContain("under 5,5 <28");
    expect(s.log).not.toContain("free 5,5");
    expect(s.log.at(-1)).toBe("hit 9,5 >=28");
    // The same building reaches a beam lower down: a hit.
    const low = recorder();
    senseRay(g, ray({ zM: 5, beamLowerM: 3 }), low, newRangeScratch(30, 1));
    expect(low.log.at(-1)).toBe("hit 5,5 >=3");
  });

  it("a UGV beam raised above a 0.1 m curb marks it occupied (not free) and continues past it", () => {
    const g = grid();
    wall(g, 3, 0.1);
    const s = recorder();
    senseRay(g, ray({ zM: 0.5, beamLowerM: 0.3, rangeM: 6.2 }), s, newRangeScratch(7, 1));
    expect(s.log).toEqual(["free 0,5", "free 1,5", "free 2,5", "under 3,5 <0.3", "free 4,5", "free 5,5", "free 6,5"]);
  });

  it("noise can move the hit to an earlier cell (never past the obstacle); cells after the reported hit are not observed", () => {
    const g = grid();
    wall(g, 8);
    const short = recorder();
    senseRay(g, ray({ noiseM: -2.2 }), short, newRangeScratch(30, 1));
    expect(short.log.at(-1)).toBe("hit 5,5 >=0"); // 7.5 − 2.2 = 5.3 m: cell 5
    expect(short.log).not.toContain("free 6,5");
    const long = recorder();
    senseRay(g, ray({ noiseM: 3 }), long, newRangeScratch(30, 1));
    expect(long.log.at(-1)).toBe("hit 8,5 >=0");
  });

  it("inverse sensor model margin (ADR-0012 clarification of 2026-10-10): no free evidence within the margin before the measured hit", () => {
    const g = grid();
    wall(g, 8); // the wall face is at 7.5 m from the origin (x = 8)
    // A reading 0.3 m short (7.2 m) with a 1 m margin: still attributed to the wall's cell. Cell k ends at k + 0.5 m
    // along the ray, so only cells ending by 6.2 m (up to cell 5) are free; cells 6 and 7 get no update.
    const s = recorder();
    senseRay(g, ray({ noiseM: -0.3, marginM: 1 }), s, newRangeScratch(30, 1));
    expect(s.log).toEqual(["free 0,5", "free 1,5", "free 2,5", "free 3,5", "free 4,5", "free 5,5", "hit 8,5 >=0"]);
    // Shortened by more than the margin: a false early return, in the cell it ends in.
    const early = recorder();
    senseRay(g, ray({ noiseM: -2.2, marginM: 1 }), early, newRangeScratch(30, 1));
    expect(early.log.at(-1)).toBe("hit 5,5 >=0");
    expect(early.log).not.toContain("free 4,5"); // 5.3 − 1 = 4.3 m: cell 4 ends at 4.5 m
    // Without noise there is no margin: every cell before the wall is free.
    const exact = recorder();
    senseRay(g, ray(), exact, newRangeScratch(30, 1));
    expect(exact.log).toEqual(["free 0,5", "free 1,5", "free 2,5", "free 3,5", "free 4,5", "free 5,5", "free 6,5", "free 7,5", "hit 8,5 >=0"]);
  });

  it("stops at the map edge without a hit", () => {
    const s = recorder();
    expect(senseRay(grid(), ray({ x: 37.5, rangeM: 30 }), s, newRangeScratch(30, 1))).toBe(-1);
    expect(s.log).toEqual(["free 37,5", "free 38,5", "free 39,5"]);
  });
});

describe("camera (ADR-0012 addition of 2026-10-09)", () => {
  const cam = { x: 0.5, y: 5.5, z: 1, headingRad: 0, fovRad: Math.PI / 2, rangeM: 20 };

  it("detects an entity in range, in the field of view and in line of sight", () => {
    expect(cameraSees(grid(), cam, { x: 10.5, y: 5.5, z: 0.5 }, newCameraScratch())).toBe(true);
  });

  it("does not detect it out of range, outside the field of view, or behind a wall taller than the sight line", () => {
    const g = grid();
    const scratch = newCameraScratch();
    expect(cameraSees(g, cam, { x: 25.5, y: 5.5, z: 0.5 }, scratch)).toBe(false); // 25 m > 20 m
    expect(cameraSees(g, { ...cam, headingRad: Math.PI }, { x: 10.5, y: 5.5, z: 0.5 }, scratch)).toBe(false); // behind
    wall(g, 5, 3);
    expect(cameraSees(g, cam, { x: 10.5, y: 5.5, z: 0.5 }, scratch)).toBe(false);
    // From 30 m up, the 3 m wall no longer hides it.
    expect(cameraSees(g, { ...cam, z: 30 }, { x: 10.5, y: 5.5, z: 0.5 }, scratch)).toBe(true);
  });
});

describe("sensor schedule (ADR-0012 addition of 2026-10-09)", () => {
  it("reads once per period at ticks fixed by a phase hashed from stable names", () => {
    const P = periodUs(10);
    expect(P).toBe(100_000);
    const phi = sensorPhaseUs("rover/lidar", P);
    expect(phi).toBe(sensorPhaseUs("rover/lidar", P)); // deterministic
    expect(phi).toBeGreaterThanOrEqual(0);
    expect(phi).toBeLessThan(P);
    const dt = 50_000; // 20 Hz ticks
    const ticks: number[] = [];
    for (let t = 1; t <= 40; t++) if (readsAtTick(t * dt, (t - 1) * dt, P, phi)) ticks.push(t);
    expect(ticks).toHaveLength(20); // 2 s at 10 Hz
    for (let k = 1; k < ticks.length; k++) expect((ticks[k] ?? 0) - (ticks[k - 1] ?? 0)).toBe(2);
  });

  it("phases differ across names and do not depend on load order", () => {
    const P = periodUs(10);
    const names = ["rover/lidar", "rover/camera", "scout/lidar", "low/lidar"];
    const a = names.map((n) => sensorPhaseUs(n, P));
    const b = [...names].reverse().map((n) => sensorPhaseUs(n, P)).reverse();
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(names.length);
  });
});
