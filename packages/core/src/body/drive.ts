import { atan, cos, sin, tan } from "../numerics/detmath/index.ts";
import { stepUgv, wrapAngle, type UgvState } from "./kinematics.ts";

/**
 * Ground vehicle drive models (ADR-0033). The body keeps one state shape (`UgvState`); a drive model turns
 * a command into motion along an exact arc with a signed distance. New models (e.g. a road-network
 * electric car, F14) plug in here without changing the body.
 */
export type DriveKind = "differential" | "ackermann" | "forward-only";

export interface DriveParams {
  readonly drive: DriveKind;
  readonly maxSpeedMps: number;
  /** Always false for forward-only. */
  readonly reverseAllowed: boolean;
  readonly maxReverseSpeedMps: number;
  /** Effective minimum turning radius: forward-only's parameter, Ackermann's derived radius, 0 for differential. */
  readonly turningRadiusM: number;
  /** Differential only. */
  readonly maxYawRateRadps: number;
  /** Ackermann only. */
  readonly wheelbaseM: number;
  readonly maxSteeringAngleRad: number;
  readonly maxSteeringRateRadps: number;
}

/**
 * One tick's command: a signed speed and a signed curvature (heading change per metre travelled, in the
 * direction of travel). A differential drive with speed 0 rotates in place at `yawRate`.
 */
export interface DriveCommand {
  speed: number;
  curvature: number;
  yawRate: number;
}

/** Minimum turning radius of an Ackermann vehicle: wheelbase / tan(max steering angle). */
export function ackermannRadiusM(wheelbaseM: number, maxSteeringAngleRad: number): number {
  return wheelbaseM / tan(maxSteeringAngleRad);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Moves along an arc of signed length d and curvature k (dh = k·d), exactly. */
function arc(s: UgvState, d: number, k: number): void {
  if (Math.abs(k) < 1e-9) {
    s.x += d * cos(s.heading);
    s.y += d * sin(s.heading);
    return;
  }
  const h1 = s.heading + k * d;
  s.x += (sin(h1) - sin(s.heading)) / k;
  s.y += (cos(s.heading) - cos(h1)) / k;
  s.heading = wrapAngle(h1);
}

/** Advances the body by one tick with the drive model's limits. */
export function stepDrive(s: UgvState, p: DriveParams, cmd: DriveCommand, dtS: number): void {
  s.lastRotationRad = 0;
  if (p.drive === "forward-only") {
    stepUgv(s, p, cmd.speed, cmd.curvature, dtS);
    return;
  }
  const v = clamp(cmd.speed, p.reverseAllowed ? -p.maxReverseSpeedMps : 0, p.maxSpeedMps);
  const d = v * dtS;
  if (p.drive === "differential") {
    if (v === 0) {
      const w = clamp(cmd.yawRate, -p.maxYawRateRadps, p.maxYawRateRadps);
      s.heading = wrapAngle(s.heading + w * dtS);
      s.lastRotationRad = Math.abs(w * dtS);
    } else {
      // Yaw rate = curvature × speed, within the limit (the follower slows down before it binds).
      const w = clamp(cmd.curvature * v, -p.maxYawRateRadps, p.maxYawRateRadps);
      arc(s, d, w / v);
    }
    s.speed = v;
    s.lastStepM = Math.abs(d);
    return;
  }
  // Ackermann: the steering angle moves towards the target at the steering rate.
  const target = clamp(atan(cmd.curvature * p.wheelbaseM), -p.maxSteeringAngleRad, p.maxSteeringAngleRad);
  const maxDelta = p.maxSteeringRateRadps * dtS;
  s.steering = clamp(s.steering + clamp(target - s.steering, -maxDelta, maxDelta), -p.maxSteeringAngleRad, p.maxSteeringAngleRad);
  arc(s, d, tan(s.steering) / p.wheelbaseM);
  s.speed = v;
  s.lastStepM = Math.abs(d);
}
