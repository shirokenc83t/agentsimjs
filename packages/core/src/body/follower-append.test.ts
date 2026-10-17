import { describe, expect, it } from "vitest";
import { ackermannRadiusM, stepDrive, type DriveParams } from "./drive.ts";
import { PathFollower, type FollowerParams } from "./follower.ts";
import type { UgvState } from "./kinematics.ts";

// ADR-0037 fourth addition (F2b M3): a lazy refine appends legs to the path being followed. The follower keeps its progress,
// treats the end of the path as it does a goal (slow down, stop within the tolerance), and goes on when more points arrive.

const DT = 0.1;
const base = { maxSpeedMps: 2, maxReverseSpeedMps: 0.5, reverseAllowed: true, maxYawRateRadps: 1.5, wheelbaseM: 1, maxSteeringAngleRad: 0.6, maxSteeringRateRadps: 1 };
const KINDS: [string, DriveParams][] = [
  ["differential", { ...base, drive: "differential", turningRadiusM: 0 }],
  ["ackermann", { ...base, drive: "ackermann", turningRadiusM: ackermannRadiusM(1, 0.6) }],
];
const asFollower = (p: DriveParams): FollowerParams => ({ ...p, lookaheadM: 1.2, arrivalToleranceM: 0.3 });
const follower = (p: DriveParams, pts: number[]) => new PathFollower([{ pts: Float64Array.from(pts), reverse: false }], asFollower(p));
const fresh = (): UgvState => ({ x: 0, y: 0, heading: 0, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 });
const snap = (s: UgvState) => [s.x, s.y, s.heading, s.speed, s.steering];

/** A wiggling 60 m path of 5 m steps. */
const PATH: number[] = [];
for (let k = 0; k <= 12; k++) PATH.push(5 * k, k % 2 === 0 ? 0 : 1.5);

describe.each(KINDS)("PathFollower.append (%s drive)", (_name, p) => {
  it("driving a path appended in pieces, each piece arriving before the vehicle nears the provisional end, is driving the whole path", () => {
    const whole = follower(p, PATH);
    const s1 = fresh();
    const w: number[][] = [];
    for (let t = 0; t < 1500; t++) {
      const c = whole.update(s1, DT);
      if (c.arrived) break;
      stepDrive(s1, p, c, DT);
      w.push(snap(s1));
    }
    const pieces = follower(p, PATH.slice(0, 2 * 3)); // the first 3 points
    const s2 = fresh();
    const a: number[][] = [];
    let next = 3;
    let arrivedA = false;
    for (let t = 0; t < 1500; t++) {
      // A leg arrives whenever the vehicle is still well clear of the provisional end (further than the slow-down and look-ahead distances).
      const last = pieces.currentSegment.pts;
      const ex = last[last.length - 2] ?? 0;
      const ey = last[last.length - 1] ?? 0;
      if (next <= 12 && Math.sqrt((ex - s2.x) ** 2 + (ey - s2.y) ** 2) <= 12) {
        pieces.append(Float64Array.from(PATH.slice(2 * next, 2 * (next + 2))));
        next += 2;
      }
      const c = pieces.update(s2, DT);
      if (c.arrived && next > 12) {
        arrivedA = true;
        break;
      }
      stepDrive(s2, p, c, DT);
      a.push(snap(s2));
    }
    expect(arrivedA).toBe(true);
    expect(next).toBeGreaterThan(12);
    expect(a).toEqual(w); // bit for bit: the same commands at every tick
  });

  it("holds at the end of what it has: slows to a stop within the arrival tolerance, does not overshoot, never reports stuck", () => {
    const end = 10;
    const f = follower(p, [0, 0, 5, 0, end, 0]);
    const s = fresh();
    let arrivedAt = -1;
    let maxX = 0;
    for (let t = 0; t < 600; t++) {
      const c = f.update(s, DT);
      if (c.arrived) {
        arrivedAt = t;
        break;
      }
      expect(c.stuck).toBe(false);
      stepDrive(s, p, c, DT);
      maxX = Math.max(maxX, s.x);
    }
    expect(arrivedAt).toBeGreaterThan(0);
    expect(maxX).toBeLessThanOrEqual(end + 0.3); // no further than an eager arrival at a goal
    const held = snap(s).slice(0, 3); // position and heading when it arrived
    // Waiting for the next leg for a long time (well beyond the stuck timeout): the vehicle stays where it is and is not stuck.
    for (let t = 0; t < 600; t++) {
      const c = f.update(s, DT);
      expect(c.arrived).toBe(true);
      expect(c.stuck).toBe(false);
      stepDrive(s, p, c, DT);
    }
    expect(snap(s).slice(0, 3)).toEqual(held);
    expect(s.speed).toBe(0);
  });

  it("goes on when a leg arrives after the hold: arrived is false again and the vehicle drives to the new end", () => {
    const f = follower(p, [0, 0, 4, 0]);
    const s = fresh();
    for (let t = 0; t < 600; t++) {
      const c = f.update(s, DT);
      if (c.arrived) break;
      stepDrive(s, p, c, DT);
    }
    expect(f.update(s, DT).arrived).toBe(true);
    f.append(Float64Array.from([4, 3, 4, 8]));
    let arrived = false;
    for (let t = 0; t < 1500 && !arrived; t++) {
      const c = f.update(s, DT);
      arrived = c.arrived;
      if (!arrived) stepDrive(s, p, c, DT);
    }
    expect(arrived).toBe(true);
    expect(Math.sqrt((s.x - 4) ** 2 + (s.y - 8) ** 2)).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("copies once per append, keeps the progress along the path, and extends the segment it reports", () => {
    const f = follower(p, [0, 0, 20, 0]);
    const s = fresh();
    for (let t = 0; t < 40; t++) stepDrive(s, p, f.update(s, DT), DT);
    const progress = f.progressSegment;
    f.append(Float64Array.from([20, 5]));
    expect(f.progressSegment).toBe(progress);
    expect(Array.from(f.currentSegment.pts)).toEqual([0, 0, 20, 0, 20, 5]);
  });

  it("is for a forward path of one segment: anything else is refused", () => {
    expect(() => new PathFollower([{ pts: Float64Array.from([0, 0, 1, 0]), reverse: true }], asFollower(p)).append(Float64Array.from([2, 0]))).toThrow(RangeError);
    const two = new PathFollower([{ pts: Float64Array.from([0, 0, 1, 0]), reverse: false }, { pts: Float64Array.from([1, 0, 2, 0]), reverse: true }], asFollower(p));
    expect(() => two.append(Float64Array.from([3, 0]))).toThrow(RangeError);
    expect(() => follower(p, [0, 0, 1, 0]).append(Float64Array.from([1, 2, 3]))).toThrow(RangeError); // odd length
  });
});
