import { stepDrive } from "../body/drive.ts";
import { PathFollower, type FollowerParams, type PathSegment } from "../body/follower.ts";
import type { UgvState } from "../body/kinematics.ts";
import type { PlanMap } from "./ports.ts";

export interface PredriveOutcome {
  readonly ok: boolean;
  /** Smallest predicted distance from the vehicle's centre to an obstacle of the plan's map. */
  readonly predictedMinClearanceM: number;
  /** Why the path was rejected (absent when ok). */
  readonly reason?: "contact" | "no_progress" | "too_long";
  /**
   * Where the check ended (when ok): the pose at which the follower arrived. The next leg of a lazy refine is checked from
   * it (ADR-0037 fourth addition, item 5), so the chain depends only on the legs.
   */
  readonly end?: { readonly x: number; readonly y: number; readonly heading: number; readonly speed: number; readonly steering: number };
}

/**
 * Pre-drive check (ADR-0024 clarification, ADR-0033): runs the same follower and drive model, at the same
 * time step, along the path segments on the **plan's map** (never ground truth, ADR-0005), and reports
 * whether the footprint stays clear. Reverse segments, cusps and rotations in place are included (the
 * footprint is a disc, so a rotation in place sweeps nothing new). Deterministic: if it passes, the real
 * drive is identical until the world differs from the map. Costs no sim time and no expansions.
 */
export function predictTracking(
  segments: readonly PathSegment[],
  start: Readonly<UgvState>,
  params: FollowerParams,
  footprintRadiusM: number,
  dtS: number,
  map: PlanMap,
): PredriveOutcome {
  const s: UgvState = { ...start, lastStepM: 0, lastRotationRad: 0 };
  const follower = new PathFollower(segments, params);
  let pathLength = 0;
  for (const seg of segments) {
    const path = seg.pts;
    for (let k = 0; k + 3 < path.length; k += 2) {
      const ex = (path[k + 2] ?? 0) - (path[k] ?? 0);
      const ey = (path[k + 3] ?? 0) - (path[k + 1] ?? 0);
      pathLength += Math.sqrt(ex * ex + ey * ey);
    }
  }
  // Generous bound: the slowest speed the follower uses (reverse included), twice over, plus turning.
  const slowest = 0.25 * Math.min(params.maxSpeedMps, params.reverseAllowed ? params.maxReverseSpeedMps : params.maxSpeedMps);
  const maxTicks = Math.ceil((2 * pathLength) / (slowest * dtS) + 600 * segments.length);
  const cap = footprintRadiusM + 1;
  let minClear = map.clearanceM(s.x, s.y, cap);
  for (let t = 0; t < maxTicks; t++) {
    const c = follower.update(s, dtS);
    if (c.arrived) return { ok: true, predictedMinClearanceM: minClear, end: { x: s.x, y: s.y, heading: s.heading, speed: s.speed, steering: s.steering } };
    if (c.stuck) return { ok: false, predictedMinClearanceM: minClear, reason: "no_progress" };
    stepDrive(s, params, c, dtS);
    const clear = map.clearanceM(s.x, s.y, cap);
    if (clear < minClear) minClear = clear;
    if (clear < footprintRadiusM) return { ok: false, predictedMinClearanceM: minClear, reason: "contact" };
  }
  return { ok: false, predictedMinClearanceM: minClear, reason: "too_long" };
}
