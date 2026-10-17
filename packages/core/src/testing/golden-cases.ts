import { drainBattery, hashBattery } from "../body/battery.ts";
import { ackermannRadiusM, stepDrive } from "../body/drive.ts";
import { PathFollower, type FollowerParams, type PathSegment } from "../body/follower.ts";
import { hashUav, hashUgv, stepUavTowards, stepUgv, type UavState, type UgvState } from "../body/kinematics.ts";
import { PurePursuit } from "../body/pure-pursuit.ts";
import * as dm from "../numerics/detmath/index.ts";
import { Rng } from "../numerics/rng.ts";
import { StateHasher } from "../numerics/state-hash.ts";
import { Scheduler } from "../time/scheduler.ts";
import { ProbeWorld } from "./probe-world.ts";

/**
 * Golden cases for cross-engine determinism (ADR-0023). The same functions run in Node, Chromium and
 * Firefox; their output bits must equal `golden.json` (generated in Node by tools/golden).
 */
const view = new DataView(new ArrayBuffer(8));
export function bitsHex(x: number): string {
  view.setFloat64(0, x, true);
  return view.getUint32(4, true).toString(16).padStart(8, "0") + view.getUint32(0, true).toString(16).padStart(8, "0");
}

const SPECIAL = [0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 5e-324, 1e-8, 3.141592653589793, 1.5707963267948966, 6.283185307179586, 100, -100, 12345.678, 1e6, -1e6];

type Unary = "sin" | "cos" | "tan" | "atan" | "asin" | "acos" | "exp" | "log";
type Binary = "atan2" | "pow" | "hypot";

export interface GoldenCase {
  readonly fn: Unary | Binary | "sqrt";
  readonly args: readonly string[]; // input bits
  readonly out: string; // output bits
}

function inputs(rng: Rng, n: number, lo: number, hi: number): number[] {
  return Array.from({ length: n }, () => lo + (hi - lo) * rng.nextFloat01());
}

/** Deterministic input set (from the Rng itself) × every detmath function. */
export function computeDetmathCases(): GoldenCase[] {
  const rng = Rng.fromSeed(20261003).derive("golden/detmath");
  const cases: GoldenCase[] = [];
  const unary = (fn: Unary | "sqrt", f: (x: number) => number, xs: number[]) => {
    for (const x of xs) cases.push({ fn, args: [bitsHex(x)], out: bitsHex(f(x)) });
  };
  const binary = (fn: Binary, f: (a: number, b: number) => number, pairs: [number, number][]) => {
    for (const [a, b] of pairs) cases.push({ fn, args: [bitsHex(a), bitsHex(b)], out: bitsHex(f(a, b)) });
  };
  const wide = [...SPECIAL, ...inputs(rng, 60, -50, 50), ...inputs(rng, 20, -1e5, 1e5)];
  unary("sin", dm.sin, wide);
  unary("cos", dm.cos, wide);
  unary("tan", dm.tan, wide);
  unary("atan", dm.atan, wide);
  const unit = [...inputs(rng, 40, -1, 1), 0, 1, -1, 0.5, -0.5];
  unary("asin", dm.asin, unit);
  unary("acos", dm.acos, unit);
  unary("exp", dm.exp, [...SPECIAL.filter((x) => Math.abs(x) < 800), ...inputs(rng, 60, -700, 700)]);
  const pos = [...SPECIAL.filter((x) => x > 0), ...inputs(rng, 60, 1e-6, 1e6)];
  unary("log", dm.log, pos);
  unary("sqrt", Math.sqrt, pos);
  const pairs = (n: number, lo: number, hi: number): [number, number][] =>
    Array.from({ length: n }, () => [lo + (hi - lo) * rng.nextFloat01(), lo + (hi - lo) * rng.nextFloat01()]);
  binary("atan2", dm.atan2, [...pairs(60, -100, 100), [0, 0], [-0, -1], [1, 0], [0, -1]]);
  binary("pow", dm.pow, [...pairs(40, 0.01, 10), [2, 10], [-2, 3], [0.5, -3], [10, 0.5]]);
  binary("hypot", dm.hypot, [...pairs(40, -1e3, 1e3), [3, 4], [1e300, 1e300], [1e-300, 1e-300]]);
  return cases;
}

/** State hash of the probe world after `ticks` steps. */
export function computeProbeHash(seed: number, ticks: number): string {
  const world = new ProbeWorld(seed);
  new Scheduler(world, 0.05).run(ticks);
  return world.hash();
}

export const GOLDEN_PROBE = { seed: 42, ticks: 10_000 } as const;

/**
 * State hash after driving the F1 bodies (milestone d): a UGV tracking a random winding path with pure
 * pursuit, a UAV flying through random waypoints, both draining their batteries. Any engine difference in
 * the kinematics or the tracker changes it.
 */
export function computeBodiesHash(seed: number): string {
  const rng = Rng.fromSeed(seed).derive("golden/bodies");
  const path: number[] = [0, 0];
  let px = 0;
  let py = 0;
  for (let k = 0; k < 40; k++) {
    px += 4 + rng.nextFloat01() * 4;
    py += (rng.nextFloat01() - 0.5) * 8;
    path.push(px, py);
  }
  const params = { maxSpeedMps: 2, turningRadiusM: 1.5, lookaheadM: 1.5, arrivalToleranceM: 0.5 };
  const pp = new PurePursuit(Float64Array.from(path), params);
  const ugv: UgvState = { x: 0, y: 0, heading: 0, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 };
  const uav: UavState = { x: 0, y: 0, z: 0, heading: 0, airborne: true, lastStepM: 0 };
  const bU = { soc: 1 };
  const bA = { soc: 1 };
  const battery = { capacityWh: 500, criticalSoc: 0.1 };
  const energy = { movingWhPerM: 0.05, idleW: 10 };
  let target = [rng.nextFloat01() * 100, rng.nextFloat01() * 100, 10 + rng.nextFloat01() * 30];
  for (let t = 0; t < 3000; t++) {
    const c = pp.update(ugv, 0.1);
    if (!c.arrived) stepUgv(ugv, params, c.speed, c.curvature, 0.1);
    drainBattery(bU, battery, energy, ugv.lastStepM, 0.1);
    if (stepUavTowards(uav, { maxSpeedMps: 8, climbRateMps: 2 }, target[0] ?? 0, target[1] ?? 0, target[2] ?? 0, 0.1)) {
      target = [rng.nextFloat01() * 100, rng.nextFloat01() * 100, 10 + rng.nextFloat01() * 30];
    }
    drainBattery(bA, battery, { movingWhPerM: 0.02, idleW: 150 }, uav.lastStepM, 0.1);
  }
  const h = new StateHasher();
  hashUgv(h, ugv);
  hashUav(h, uav);
  hashBattery(h, bU);
  hashBattery(h, bA);
  return h.hex();
}

export const GOLDEN_BODIES = { seed: 7 } as const;

const DRIVE_BASE = { maxSpeedMps: 2, maxReverseSpeedMps: 0.5, reverseAllowed: true, maxYawRateRadps: 1.5, wheelbaseM: 1, maxSteeringAngleRad: 0.6, maxSteeringRateRadps: 1, lookaheadM: 1.2, arrivalToleranceM: 0.3 };

function driveHash(params: FollowerParams, segments: PathSegment[], heading: number, ticks: number): string {
  const s: UgvState = { x: 0, y: 0, heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 };
  const f = new PathFollower(segments, params);
  const h = new StateHasher();
  for (let t = 0; t < ticks; t++) {
    const c = f.update(s, 0.1);
    if (c.arrived) break;
    stepDrive(s, params, c, 0.1);
    if (t % 50 === 0) hashUgv(h, s);
  }
  hashUgv(h, s);
  return h.hex();
}

/**
 * State hashes of the ADR-0033 drive models: a differential robot that rotates in place towards a target
 * behind it and then reverses, and an Ackermann car that drives forward and reverses through a cusp.
 */
export function computeDrivesHash(): { differential: string; ackermann: string } {
  const seg = (reverse: boolean, ...pts: number[]): PathSegment => ({ pts: Float64Array.from(pts), reverse });
  const differential = driveHash(
    { ...DRIVE_BASE, drive: "differential", turningRadiusM: 0 },
    [seg(false, 0, 0, -6, 2, -10, 1), seg(true, -10, 1, -7, 4)],
    0,
    3000,
  );
  const ackermann = driveHash(
    { ...DRIVE_BASE, drive: "ackermann", turningRadiusM: ackermannRadiusM(1, 0.6) },
    [seg(false, 0, 0, 8, 0, 12, 4), seg(true, 12, 4, 9, 7, 6, 7)],
    0,
    3000,
  );
  return { differential, ackermann };
}
