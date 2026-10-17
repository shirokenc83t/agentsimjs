import { describe, expect, it } from "vitest";
import { ackermannRadiusM, stepDrive } from "../body/drive.ts";
import { PathFollower, type FollowerParams, type PathSegment } from "../body/follower.ts";
import type { UgvState } from "../body/kinematics.ts";
import type { PlanMap } from "./ports.ts";
import { predictTracking } from "./predrive.ts";

// F2b M3: a lazy refine checks leg k from the predicted end pose of leg k-1 (ADR-0037 fourth addition, item 5).

const DT = 0.1;
const params: FollowerParams = {
  maxSpeedMps: 2,
  maxReverseSpeedMps: 0.5,
  reverseAllowed: true,
  maxYawRateRadps: 1.5,
  wheelbaseM: 1,
  maxSteeringAngleRad: 0.6,
  maxSteeringRateRadps: 1,
  drive: "ackermann",
  turningRadiusM: ackermannRadiusM(1, 0.6),
  lookaheadM: 1.2,
  arrivalToleranceM: 0.3,
};
const open: PlanMap = { version: 1, clearanceM: (_x, _y, maxM) => maxM };
const wall: PlanMap = { version: 1, clearanceM: (x, _y, maxM) => Math.min(maxM, Math.max(0, 8 - x)) }; // an obstacle at x = 8
const start = (): UgvState => ({ x: 0, y: 0, heading: 0, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 });
const seg = (...pts: number[]): PathSegment => ({ pts: Float64Array.from(pts), reverse: false });

describe("predictTracking reports where the vehicle ends up", () => {
  it("returns the pose at which the follower arrived, the same pose an independent run of the follower reaches", () => {
    const path = seg(0, 0, 6, 0, 10, 4);
    const r = predictTracking([path], start(), params, 0.5, DT, open);
    expect(r.ok).toBe(true);
    const s = start();
    const f = new PathFollower([path], params);
    for (let t = 0; t < 5000; t++) {
      const c = f.update(s, DT);
      if (c.arrived) break;
      stepDrive(s, params, c, DT);
    }
    expect(r.end).toEqual({ x: s.x, y: s.y, heading: s.heading, speed: s.speed, steering: s.steering });
  });

  it("does not change the start state it was given, and has no end when the check fails", () => {
    const s0 = start();
    const before = { ...s0 };
    predictTracking([seg(0, 0, 6, 0)], s0, params, 0.5, DT, open);
    expect(s0).toEqual(before);
    const bad = predictTracking([seg(0, 0, 12, 0)], s0, params, 0.5, DT, wall);
    expect(bad.ok).toBe(false);
    expect(bad.end).toBeUndefined();
  });

  it("chains: leg 1 checked from leg 0's predicted end pose, and the chain is a function of the legs alone", () => {
    const leg0 = predictTracking([seg(0, 0, 5, 0)], start(), params, 0.5, DT, open);
    if (!leg0.end) throw new Error("no end pose");
    const from = { ...leg0.end, lastStepM: 0, lastRotationRad: 0 };
    const leg1 = predictTracking([seg(5, 0, 9, 3)], from, params, 0.5, DT, open);
    expect(leg1.ok).toBe(true);
    expect(leg1.end).toBeDefined();
    expect(predictTracking([seg(5, 0, 9, 3)], from, params, 0.5, DT, open).end).toEqual(leg1.end);
  });
});
