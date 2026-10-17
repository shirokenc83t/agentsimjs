import { compileCostProfile, GridSearch, SearchSpace, smoothPath } from "@agentsim/algorithms";
import { PurePursuit, stepUgv, type UgvState } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { BUILTIN_BODY_DEFAULTS } from "./body-defaults.ts";

/**
 * Plan → track integration for a car-like UGV (F1 requirement): the planner keeps footprint + tracking
 * margin from obstacles (inflated mask), pure pursuit respects the turning radius, and the footprint never
 * touches an occupied cell, also in tight turns.
 */
const body = BUILTIN_BODY_DEFAULTS.ugv;
const RES = 0.5;

function rect(g: GridSpace, x0: number, y0: number, x1: number, y1: number): void {
  for (let j = Math.floor(y0 / RES); j < Math.ceil(y1 / RES); j++) for (let i = Math.floor(x0 / RES); i < Math.ceil(x1 / RES); i++) g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED);
}

/** Smallest distance from (x, y) to any occupied cell square near it. */
function clearance(g: GridSpace, x: number, y: number): number {
  const reach = Math.ceil((body.footprintRadiusM + 1) / RES);
  const ci = Math.floor(x / RES);
  const cj = Math.floor(y / RES);
  let best = Number.POSITIVE_INFINITY;
  for (let j = cj - reach; j <= cj + reach; j++) {
    for (let i = ci - reach; i <= ci + reach; i++) {
      if (!g.isBlocked(i, j)) continue; // out of bounds counts as blocked
      const dx = Math.max(i * RES - x, 0, x - (i + 1) * RES);
      const dy = Math.max(j * RES - y, 0, y - (j + 1) * RES);
      best = Math.min(best, Math.hypot(dx, dy));
    }
  }
  return best;
}

function planAndTrack(g: GridSpace, from: [number, number], heading: number, to: [number, number]) {
  const profile = compileCostProfile({ weights: { distance: 1 } });
  if (!profile.ok) throw new Error("profile");
  const space = new SearchSpace(
    g,
    { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: body.maxSpeedMps, energyWhPerM: body.energy.movingWhPerM, inflationRadiusM: body.footprintRadiusM + body.trackingMarginM },
    profile.value,
  );
  const cell = ([x, y]: [number, number]) => Math.floor(y / RES) * g.sizeX + Math.floor(x / RES);
  const q = new GridSearch(space, cell(from), cell(to), { kind: "astar" }, 5_000_000);
  q.runToCompletion();
  expect(q.status).toBe("found");
  const waypoints = smoothPath(space, q.path());
  const path = Float64Array.from([from[0], from[1], ...waypoints.slice(1).flat()]);
  const pp = new PurePursuit(path, body);
  const s: UgvState = { x: from[0], y: from[1], heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 };
  let minClearance = Number.POSITIVE_INFINITY;
  let maxCurvature = 0;
  const dt = 0.1;
  for (let t = 0; t < 300; t += dt) {
    const c = pp.update(s, dt);
    maxCurvature = Math.max(maxCurvature, Math.abs(c.curvature));
    if (c.arrived || c.stuck) return { ...c, minClearance, maxCurvature, s };
    stepUgv(s, body, c.speed, c.curvature, dt);
    minClearance = Math.min(minClearance, clearance(g, s.x, s.y));
  }
  return { arrived: false, stuck: false, distanceToGoalM: Number.NaN, minClearance, maxCurvature, s };
}

describe("UGV plan → pure pursuit tracking", () => {
  it("takes a right-angle turn in a corridor without touching the walls", () => {
    // 40 × 40 m; an L-shaped corridor 4 m wide: east along y ∈ [4, 8], then north along x ∈ [30, 34].
    const g = new GridSpace({ sizeX: 80, sizeY: 80, resolutionM: RES, chunkSize: 16 });
    rect(g, 0, 0, 40, 4);
    rect(g, 0, 8, 30, 40);
    rect(g, 34, 4, 40, 40);
    const r = planAndTrack(g, [2, 6], 0, [32, 36]);
    expect(r.arrived).toBe(true);
    expect(r.distanceToGoalM).toBeLessThanOrEqual(body.arrivalToleranceM);
    expect(r.maxCurvature).toBeLessThanOrEqual(1 / body.turningRadiusM + 1e-12);
    expect(r.minClearance).toBeGreaterThanOrEqual(body.footprintRadiusM); // no collision
  });

  it("makes a hairpin turn around a wall end at its minimum radius without touching the walls", () => {
    // East along the bottom lane, around the end of a dividing wall, back west along the top lane.
    const g = new GridSpace({ sizeX: 80, sizeY: 80, resolutionM: RES, chunkSize: 16 });
    rect(g, 0, 0, 40, 2);
    rect(g, 0, 14, 40, 40);
    rect(g, 0, 7.5, 30, 8.5); // dividing wall, ends 10 m before the far side
    rect(g, 38, 0, 40, 40);
    const r = planAndTrack(g, [2, 4.75], 0, [2, 11.25]);
    expect(r.arrived).toBe(true);
    expect(r.maxCurvature).toBeLessThanOrEqual(1 / body.turningRadiusM + 1e-12);
    expect(r.minClearance).toBeGreaterThanOrEqual(body.footprintRadiusM);
  });
});
