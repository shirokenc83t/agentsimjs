import { describe, expect, it } from "vitest";
import { ackermannRadiusM, stepDrive, type DriveParams } from "./drive.ts";
import { PathFollower, type PathSegment } from "./follower.ts";
import type { UgvState } from "./kinematics.ts";

const DT = 0.1;
const base = { maxSpeedMps: 2, maxReverseSpeedMps: 0.5, reverseAllowed: true, maxYawRateRadps: 1.5, wheelbaseM: 1, maxSteeringAngleRad: 0.6, maxSteeringRateRadps: 1 };
const differential: DriveParams = { ...base, drive: "differential", turningRadiusM: 0 };
const ackermann: DriveParams = { ...base, drive: "ackermann", turningRadiusM: ackermannRadiusM(1, 0.6) };
const forwardOnly: DriveParams = { ...base, drive: "forward-only", reverseAllowed: false, turningRadiusM: 1.5 };

const state = (heading = 0): UgvState => ({ x: 0, y: 0, heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 });

describe("differential drive (unicycle)", () => {
  it("rotates in place at speed 0, within the yaw-rate limit", () => {
    const s = state();
    stepDrive(s, differential, { speed: 0, curvature: 0, yawRate: 10 }, DT);
    expect([s.x, s.y]).toEqual([0, 0]);
    expect(s.heading).toBeCloseTo(0.15, 12);
    expect(s.lastRotationRad).toBeCloseTo(0.15, 12);
    expect(s.lastStepM).toBe(0);
  });

  it("drives forward and reverse within the speed limits", () => {
    const s = state();
    stepDrive(s, differential, { speed: 5, curvature: 0, yawRate: 0 }, DT);
    expect(s.x).toBeCloseTo(0.2, 12);
    stepDrive(s, differential, { speed: -5, curvature: 0, yawRate: 0 }, DT);
    expect(s.x).toBeCloseTo(0.15, 12); // reverse capped at 0.5 m/s
    expect(s.speed).toBe(-0.5);
    expect(s.lastStepM).toBeCloseTo(0.05, 12);
  });

  it("limits yaw rate while moving (curvature × speed)", () => {
    const s = state();
    stepDrive(s, differential, { speed: 2, curvature: 10, yawRate: 0 }, DT);
    expect(s.heading).toBeCloseTo(0.15, 12);
  });
});

describe("Ackermann drive (kinematic bicycle)", () => {
  it("derives the minimum radius from wheelbase and steering limit", () => {
    expect(ackermannRadiusM(1, 0.6)).toBeCloseTo(1 / Math.tan(0.6), 12);
  });

  it("moves the steering angle at most at the steering rate, within its limit", () => {
    const s = state();
    stepDrive(s, ackermann, { speed: 1, curvature: 100, yawRate: 0 }, DT);
    expect(s.steering).toBeCloseTo(0.1, 12);
    for (let k = 0; k < 20; k++) stepDrive(s, ackermann, { speed: 1, curvature: 100, yawRate: 0 }, DT);
    expect(s.steering).toBeCloseTo(0.6, 12);
  });

  it("never turns tighter than its minimum radius, forward or reverse", () => {
    for (const speed of [1, -0.5]) {
      const s = state();
      s.steering = 0.6;
      const R = ackermannRadiusM(1, 0.6);
      const steps = Math.round((2 * Math.PI * R) / (Math.abs(speed) * DT));
      let maxDist = 0;
      for (let k = 0; k < steps; k++) {
        stepDrive(s, ackermann, { speed, curvature: 100, yawRate: 0 }, DT); // steering stays at +max
        maxDist = Math.max(maxDist, Math.hypot(s.x, s.y));
      }
      expect(maxDist).toBeLessThanOrEqual(2 * R + 1e-6);
      expect(maxDist).toBeGreaterThan(2 * R - 0.05);
    }
  });

  it("reverses with the steering geometry (heading changes opposite to forward)", () => {
    const f = state();
    const r = state();
    f.steering = r.steering = 0.3;
    stepDrive(f, ackermann, { speed: 0.5, curvature: Math.tan(0.3), yawRate: 0 }, DT);
    stepDrive(r, ackermann, { speed: -0.5, curvature: Math.tan(0.3), yawRate: 0 }, DT);
    expect(f.heading).toBeGreaterThan(0);
    expect(r.heading).toBeLessThan(0);
    expect(r.x).toBeLessThan(0);
  });
});

describe("forward-only drive", () => {
  it("never reverses", () => {
    const s = state();
    stepDrive(s, forwardOnly, { speed: -1, curvature: 0, yawRate: 0 }, DT);
    expect([s.x, s.y, s.speed]).toEqual([0, 0, 0]);
  });
});

describe("path follower", () => {
  const seg = (reverse: boolean, ...pts: number[]): PathSegment => ({ pts: Float64Array.from(pts), reverse });

  function drive(p: DriveParams, segments: PathSegment[], heading: number) {
    const s = state(heading);
    const f = new PathFollower(segments, { ...p, lookaheadM: 1.2, arrivalToleranceM: 0.3 });
    const log: { speed: number; yawRate: number; segment: number }[] = [];
    for (let t = 0; t < 3000; t++) {
      const c = f.update(s, DT);
      if (c.arrived || c.stuck) return { s, log, arrived: c.arrived };
      log.push({ speed: c.speed, yawRate: c.yawRate, segment: c.segment });
      stepDrive(s, p, c, DT);
    }
    return { s, log, arrived: false };
  }

  it("differential: rotates in place towards a target behind it, then drives, then reverses", () => {
    const r = drive(differential, [seg(false, 0, 0, -6, 0), seg(true, -6, 0, -3, 0)], 0);
    expect(r.arrived).toBe(true);
    expect(r.log[0]).toMatchObject({ speed: 0 });
    expect(r.log[0]?.yawRate).not.toBe(0);
    expect(r.log.some((c) => c.segment === 1 && c.speed < 0)).toBe(true);
    expect(r.s.x).toBeCloseTo(-3, 0);
  });

  it("Ackermann: forward, stop at the cusp, then pure pursuit in reverse", () => {
    const r = drive(ackermann, [seg(false, 0, 0, 8, 0, 12, 4), seg(true, 12, 4, 9, 7, 6, 7)], 0);
    expect(r.arrived).toBe(true);
    const cusp = r.log.findIndex((c) => c.segment === 1);
    expect(cusp).toBeGreaterThan(0);
    expect(r.log[cusp]?.speed).toBeLessThanOrEqual(0);
    expect(r.log.filter((c) => c.segment === 1).every((c) => c.speed <= 0)).toBe(true);
    expect(Math.hypot(r.s.x - 6, r.s.y - 7)).toBeLessThanOrEqual(0.3);
  });

  it("forward-only refuses reverse segments", () => {
    expect(() => new PathFollower([seg(true, 0, 0, -1, 0)], { ...forwardOnly, lookaheadM: 1.2, arrivalToleranceM: 0.3 })).toThrow();
  });
});
