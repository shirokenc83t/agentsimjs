import { describe, expect, it } from "vitest";
import { StateHasher } from "../numerics/state-hash.ts";
import { drainBattery, isBatteryCritical } from "./battery.ts";
import { hashUgv, stepUavTowards, stepUgv, wrapAngle, type UavState, type UgvState } from "./kinematics.ts";
import { PurePursuit } from "./pure-pursuit.ts";

const ugv = (x = 0, y = 0, heading = 0): UgvState => ({ x, y, heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 });

describe("UGV kinematics", () => {
  it("drives straight and clamps speed", () => {
    const s = ugv();
    stepUgv(s, { maxSpeedMps: 2, turningRadiusM: 1 }, 5, 0, 0.5);
    expect(s.x).toBeCloseTo(1, 12);
    expect(s.speed).toBe(2);
    expect(s.lastStepM).toBe(1);
    stepUgv(s, { maxSpeedMps: 2, turningRadiusM: 1 }, -3, 0, 0.5); // no reverse in F1
    expect(s.x).toBeCloseTo(1, 12);
  });

  it("never turns tighter than the turning radius: a full max-curvature circle has radius R", () => {
    const R = 2;
    const s = ugv();
    const dt = 0.1;
    const v = 1;
    const steps = Math.round((2 * Math.PI * R) / (v * dt));
    let maxDist = 0;
    for (let k = 0; k < steps; k++) {
      stepUgv(s, { maxSpeedMps: 2, turningRadiusM: R }, v, 100, dt); // commanded far tighter than 1/R
      maxDist = Math.max(maxDist, Math.hypot(s.x, s.y));
    }
    expect(maxDist).toBeCloseTo(2 * R, 3); // diameter of the circle
    expect(Math.hypot(s.x, s.y)).toBeLessThan(0.1);
  });

  it("wraps headings to (−π, π]", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-0.5)).toBe(-0.5);
  });

  it("is deterministic: same commands give bit-identical state hashes", () => {
    const run = () => {
      const s = ugv(1, 2, 0.3);
      for (let k = 0; k < 500; k++) stepUgv(s, { maxSpeedMps: 2, turningRadiusM: 1.5 }, 1.7, Math.sin(k * 0.01) * 0.5, 0.1);
      const h = new StateHasher();
      hashUgv(h, s);
      return h.digest();
    };
    expect(run()).toBe(run());
  });
});

describe("UAV kinematics", () => {
  it("moves at most max speed horizontally and climb rate vertically, and lands exactly on the target", () => {
    const s: UavState = { x: 0, y: 0, z: 0, heading: 0, airborne: true, lastStepM: 0 };
    const p = { maxSpeedMps: 4, climbRateMps: 1 };
    expect(stepUavTowards(s, p, 10, 0, 3, 1)).toBe(false);
    expect([s.x, s.y, s.z]).toEqual([4, 0, 1]);
    let reached = false;
    for (let k = 0; k < 10 && !reached; k++) reached = stepUavTowards(s, p, 10, 0, 3, 1);
    expect(reached).toBe(true);
    expect([s.x, s.y, s.z]).toEqual([10, 0, 3]);
  });
});

describe("battery", () => {
  it("drains with distance and time, floors at zero, and flags the critical level", () => {
    const b = { soc: 1 };
    const battery = { capacityWh: 100, criticalSoc: 0.2 };
    const energy = { movingWhPerM: 0.1, idleW: 360 };
    drainBattery(b, battery, energy, 100, 10); // 10 Wh moving + 1 Wh idle
    expect(b.soc).toBeCloseTo(0.89, 12);
    expect(isBatteryCritical(b, battery)).toBe(false);
    drainBattery(b, battery, energy, 700, 0);
    expect(isBatteryCritical(b, battery)).toBe(true);
    drainBattery(b, battery, energy, 1e6, 0);
    expect(b.soc).toBe(0);
  });
});

describe("pure pursuit", () => {
  const params = { maxSpeedMps: 2, turningRadiusM: 1.5, lookaheadM: 2, arrivalToleranceM: 0.5 };

  function drive(path: number[], start: UgvState, maxS = 120) {
    const pp = new PurePursuit(Float64Array.from(path), params);
    const dt = 0.1;
    let maxK = 0;
    for (let t = 0; t < maxS; t += dt) {
      const c = pp.update(start, dt);
      maxK = Math.max(maxK, Math.abs(c.curvature));
      if (c.arrived || c.stuck) return { ...c, maxK };
      stepUgv(start, params, c.speed, c.curvature, dt);
    }
    return { arrived: false, stuck: false, maxK, distanceToGoalM: Number.NaN };
  }

  it("follows a straight path and stops within the arrival tolerance", () => {
    const r = drive([0, 0, 10, 0], ugv());
    expect(r.arrived).toBe(true);
    expect(r.distanceToGoalM).toBeLessThanOrEqual(0.5);
  });

  it("takes a right-angle corner without exceeding the turning curvature", () => {
    const r = drive([0, 0, 10, 0, 10, 10], ugv());
    expect(r.arrived).toBe(true);
    expect(r.maxK).toBeLessThanOrEqual(1 / 1.5 + 1e-12);
  });

  it("reports stuck when the goal lies inside the turning circle", () => {
    // Goal 0.8 m to the left of a vehicle facing east, radius 1.5 m: unreachable without reversing.
    const pp = new PurePursuit(Float64Array.from([0, 0.8]), params, 5);
    const s = ugv();
    let stuck = false;
    for (let t = 0; t < 60 && !stuck; t += 0.1) {
      const c = pp.update(s, 0.1);
      if (c.arrived) throw new Error("should not arrive");
      stuck = c.stuck;
      stepUgv(s, params, c.speed, c.curvature, 0.1);
    }
    expect(stuck).toBe(true);
  });
});
