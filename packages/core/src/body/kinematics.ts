import { atan2, cos, sin } from "../numerics/detmath/index.ts";
import type { StateHasher } from "../numerics/state-hash.ts";

/**
 * Simple kinematic bodies (ROADMAP F1: deliberately simple; the decision layer is what is studied).
 * Frames: metres, x east, y north, z up; heading in radians counter-clockwise from east, in (−π, π].
 * All trigonometry goes through detmath (ADR-0023), so motion is bit-identical across engines.
 */

const TWO_PI = 2 * Math.PI;

/** Wraps an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r;
}

export interface UgvParams {
  readonly maxSpeedMps: number;
  /** Minimum turning radius; 0 = can turn on the spot. */
  readonly turningRadiusM: number;
}

/** Mutable UGV state (one object per agent, updated in place: no allocation per tick). */
export interface UgvState {
  x: number;
  y: number;
  heading: number;
  /** Signed speed (negative = reversing). */
  speed: number;
  /** Ackermann only: current steering angle (radians); 0 for other drives. */
  steering: number;
  /** Distance travelled during the last step, forward or reverse (battery, odometry). */
  lastStepM: number;
  /** Rotation in place during the last step (radians, ≥ 0; battery). */
  lastRotationRad: number;
}

/** Largest curvature a radius-0 vehicle is integrated with (turn on the spot ≈ very tight arc). */
const MAX_CURVATURE = 1e3;

export function maxCurvature(p: UgvParams): number {
  return p.turningRadiusM > 0 ? 1 / p.turningRadiusM : MAX_CURVATURE;
}

/**
 * One step of a car-like vehicle along a circular arc (exact integration of constant speed and
 * curvature): speed is clamped to [0, max], curvature to ±1/turningRadius. Forward motion only in F1.
 */
export function stepUgv(s: UgvState, p: UgvParams, speedCmd: number, curvatureCmd: number, dtS: number): void {
  const v = Math.min(Math.max(speedCmd, 0), p.maxSpeedMps);
  const kMax = maxCurvature(p);
  const k = Math.min(Math.max(curvatureCmd, -kMax), kMax);
  const d = v * dtS;
  if (Math.abs(k) < 1e-9) {
    s.x += d * cos(s.heading);
    s.y += d * sin(s.heading);
  } else {
    const h1 = s.heading + k * d;
    s.x += (sin(h1) - sin(s.heading)) / k;
    s.y += (cos(s.heading) - cos(h1)) / k;
    s.heading = wrapAngle(h1);
  }
  s.speed = v;
  s.lastStepM = d;
  s.lastRotationRad = 0;
}

export interface UavParams {
  readonly maxSpeedMps: number;
  readonly climbRateMps: number;
}

export interface UavState {
  x: number;
  y: number;
  z: number;
  heading: number;
  airborne: boolean;
  lastStepM: number;
}

/**
 * One step of a holonomic UAV towards (tx, ty, tz): horizontal speed ≤ max, vertical ≤ climb rate, each
 * axis group clamped so the target is reached exactly, never overshot. Heading follows horizontal motion.
 * Returns true when the target is reached.
 */
export function stepUavTowards(s: UavState, p: UavParams, tx: number, ty: number, tz: number, dtS: number): boolean {
  const dx = tx - s.x;
  const dy = ty - s.y;
  const dz = tz - s.z;
  const dh = Math.sqrt(dx * dx + dy * dy);
  const maxH = p.maxSpeedMps * dtS;
  let moved = 0;
  if (dh > 0) {
    const f = dh <= maxH ? 1 : maxH / dh;
    s.x = f === 1 ? tx : s.x + dx * f;
    s.y = f === 1 ? ty : s.y + dy * f;
    s.heading = atan2(dy, dx);
    moved = dh * f;
  }
  const maxV = p.climbRateMps * dtS;
  const vz = Math.abs(dz) <= maxV ? dz : Math.sign(dz) * maxV;
  s.z = Math.abs(dz) <= maxV ? tz : s.z + vz;
  moved = Math.sqrt(moved * moved + vz * vz);
  s.lastStepM = moved;
  return s.x === tx && s.y === ty && s.z === tz;
}

export function hashUgv(h: StateHasher, s: UgvState): void {
  h.f64(s.x, "ugv.x").f64(s.y, "ugv.y").f64(s.heading, "ugv.heading").f64(s.speed, "ugv.speed").f64(s.steering, "ugv.steering");
}

export function hashUav(h: StateHasher, s: UavState): void {
  h.f64(s.x, "uav.x").f64(s.y, "uav.y").f64(s.z, "uav.z").f64(s.heading, "uav.heading").u32(s.airborne ? 1 : 0);
}
