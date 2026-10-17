import { atan2, hypot, sin } from "../numerics/detmath/index.ts";
import { maxCurvature, wrapAngle, type UgvParams, type UgvState } from "./kinematics.ts";

export interface PursuitParams extends UgvParams {
  /** Nominal look-ahead distance. */
  readonly lookaheadM: number;
  /** The goal is reached when the vehicle is within this distance of the last waypoint. */
  readonly arrivalToleranceM: number;
}

export interface PursuitCommand {
  speed: number;
  curvature: number;
  distanceToGoalM: number;
  arrived: boolean;
  /** No progress towards the goal for too long (e.g. a goal inside the turning circle). */
  stuck: boolean;
  /** Nearest point on the path to the vehicle, and the distance to it (unsigned cross-track error). */
  nearestX: number;
  nearestY: number;
  crossTrackM: number;
  /** Angle from the heading to the look-ahead point, in (−π, π]. */
  alpha: number;
}

/** Closest-point search looks this many segments ahead of the current progress (never back). */
const SEARCH_WINDOW = 8;
/** Below this distance to the goal the vehicle slows down linearly (m per m/s of speed). */
const SLOWDOWN_S = 1.5;
const MIN_SPEED_FRACTION = 0.25;

/**
 * Pure-pursuit path tracker for car-like vehicles: steers towards a point one look-ahead distance ahead
 * along the path, curvature clamped to the turning radius. Progress along the path is monotonic, so the
 * tracker never turns back to an earlier part of the path. Deterministic and allocation-free per step.
 */
export class PurePursuit {
  private segment = 0;
  private bestDistance = Number.POSITIVE_INFINITY;
  private sinceProgressS = 0;
  private readonly cmd: PursuitCommand = { speed: 0, curvature: 0, distanceToGoalM: 0, arrived: false, stuck: false, nearestX: 0, nearestY: 0, crossTrackM: 0, alpha: 0 };

  /** `path`: x, y pairs (metres), at least one point; the first point is near the vehicle. */
  constructor(
    private path: Float64Array,
    private readonly p: PursuitParams,
    /** Seconds without getting closer to the goal before reporting `stuck`. */
    private readonly stuckAfterS: number = 30,
  ) {
    if (path.length < 2 || path.length % 2 !== 0) throw new RangeError("path needs at least one (x, y) point");
  }

  /**
   * Appends points to the end of the path (a lazy refine's next leg): progress along the path is kept, the goal becomes the
   * new last point, and the no-progress timer starts again. Allocates once per call, never per update.
   */
  extend(more: Float64Array): void {
    if (more.length % 2 !== 0) throw new RangeError("points are (x, y) pairs");
    if (more.length === 0) return;
    const joined = new Float64Array(this.path.length + more.length);
    joined.set(this.path);
    joined.set(more, this.path.length);
    this.path = joined;
    this.bestDistance = Number.POSITIVE_INFINITY;
    this.sinceProgressS = 0;
  }

  private get points(): number {
    return this.path.length / 2;
  }

  private px(k: number): number {
    return this.path[2 * k] ?? 0;
  }

  private py(k: number): number {
    return this.path[2 * k + 1] ?? 0;
  }

  /** Command for the current state; call once per tick before integrating the body. */
  update(s: UgvState, dtS: number): PursuitCommand {
    const c = this.cmd;
    const last = this.points - 1;
    const gx = this.px(last);
    const gy = this.py(last);
    const dGoal = hypot(gx - s.x, gy - s.y);
    c.distanceToGoalM = dGoal;
    c.stuck = false;
    if (dGoal <= this.p.arrivalToleranceM) {
      c.arrived = true;
      c.speed = 0;
      c.curvature = 0;
      return c;
    }
    c.arrived = false;
    if (dGoal < this.bestDistance - 1e-6) {
      this.bestDistance = dGoal;
      this.sinceProgressS = 0;
    } else {
      this.sinceProgressS += dtS;
      if (this.sinceProgressS > this.stuckAfterS) c.stuck = true;
    }

    // Advance progress: closest segment within the window ahead.
    let best = this.segment;
    let bestD = Number.POSITIVE_INFINITY;
    let bestT = 0;
    for (let k = this.segment; k < Math.min(last, this.segment + SEARCH_WINDOW); k++) {
      const ax = this.px(k);
      const ay = this.py(k);
      const ex = this.px(k + 1) - ax;
      const ey = this.py(k + 1) - ay;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((s.x - ax) * ex + (s.y - ay) * ey) / len2)) : 0;
      const qx = ax + t * ex - s.x;
      const qy = ay + t * ey - s.y;
      const d2 = qx * qx + qy * qy;
      if (d2 < bestD) {
        bestD = d2;
        best = k;
        bestT = t;
      }
    }
    this.segment = best;
    {
      const ax = this.px(best);
      const ay = this.py(best);
      c.nearestX = best < last ? ax + bestT * (this.px(best + 1) - ax) : ax;
      c.nearestY = best < last ? ay + bestT * (this.py(best + 1) - ay) : ay;
      c.crossTrackM = Math.sqrt(bestD === Number.POSITIVE_INFINITY ? (ax - s.x) * (ax - s.x) + (ay - s.y) * (ay - s.y) : bestD);
    }

    // Look-ahead point: walk the path from the closest point; shorter near the goal.
    const lookahead = Math.max(this.p.arrivalToleranceM, Math.min(this.p.lookaheadM, dGoal));
    let remaining = lookahead;
    let lx = gx;
    let ly = gy;
    let k = best;
    let t = bestT;
    while (k < last) {
      const ax = this.px(k);
      const ay = this.py(k);
      const ex = this.px(k + 1) - ax;
      const ey = this.py(k + 1) - ay;
      const segLen = hypot(ex, ey);
      const left = segLen * (1 - t);
      if (left >= remaining && segLen > 0) {
        const tt = t + remaining / segLen;
        lx = ax + tt * ex;
        ly = ay + tt * ey;
        break;
      }
      remaining -= left;
      k++;
      t = 0;
    }

    const dx = lx - s.x;
    const dy = ly - s.y;
    const ld = hypot(dx, dy);
    const alpha = wrapAngle(atan2(dy, dx) - s.heading);
    c.alpha = alpha;
    const kMax = maxCurvature(this.p);
    // Target more than 90° off the heading: turn at full curvature towards it (a forward turn-around on the
    // turning circle). Plain pure pursuit would give ~0 curvature for a target straight behind.
    const curvature = Math.abs(alpha) > Math.PI / 2 ? (alpha >= 0 ? kMax : -kMax) : ld > 1e-9 ? (2 * sin(alpha)) / ld : 0;
    c.curvature = Math.min(Math.max(curvature, -kMax), kMax);
    // Slow down near the goal, and in tight turns (smaller tracking error per step).
    const nearGoal = Math.min(1, Math.max(MIN_SPEED_FRACTION, dGoal / (SLOWDOWN_S * this.p.maxSpeedMps)));
    // Half speed at the tightest turn, full speed straight.
    const turning = 1 / (1 + Math.abs(c.curvature) * this.p.turningRadiusM);
    c.speed = this.p.maxSpeedMps * Math.min(nearGoal, Math.max(MIN_SPEED_FRACTION, turning));
    return c;
  }

  /** Index of the path segment the vehicle is on (for UI and tests). */
  get progressSegment(): number {
    return this.segment;
  }
}
