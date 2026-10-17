import type { DriveCommand, DriveParams } from "./drive.ts";
import type { UgvState } from "./kinematics.ts";
import { PurePursuit, type PursuitSnapshot } from "./pure-pursuit.ts";

/** A path piece driven in one direction; consecutive segments of opposite direction meet at a cusp. */
export interface PathSegment {
  readonly pts: Float64Array;
  readonly reverse: boolean;
}

export interface FollowerParams extends DriveParams {
  readonly lookaheadM: number;
  readonly arrivalToleranceM: number;
}

export interface FollowCommand extends DriveCommand {
  arrived: boolean;
  stuck: boolean;
  nearestX: number;
  nearestY: number;
  crossTrackM: number;
  distanceToGoalM: number;
  /** Index of the segment being driven. */
  segment: number;
}

/** What a `PathFollower` keeps between ticks (a snapshot; see `PathFollower.snapshot`). */
export interface FollowerSnapshot {
  readonly segments: readonly { readonly pts: Float64Array; readonly reverse: boolean }[];
  readonly index: number;
  readonly pursuit: PursuitSnapshot;
  readonly stuckAfterS: number;
  readonly arrivalToleranceM: number;
}

/** A differential drive rotates in place when the look-ahead point is further off its heading than this. */
const ROTATE_IN_PLACE_RAD = Math.PI / 4;
/** Arrival tolerance at a cusp (end of a non-final segment): direction changes happen where the path says. */
const CUSP_TOLERANCE_M = 0.1;

/**
 * Multi-segment path follower for every drive model (ADR-0033): pure pursuit on forward segments and,
 * mirrored, on reverse segments (the vehicle is treated as facing backwards; the curvature changes sign);
 * the vehicle stops at each cusp before the next segment. Deterministic and allocation-free per step.
 * Paths with cusps can come from recovery manoeuvres now and from kinematically aware planners later.
 */
export class PathFollower {
  private index = 0;
  private pursuit: PurePursuit;
  private readonly virt: UgvState = { x: 0, y: 0, heading: 0, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 };
  private readonly cmd: FollowCommand = {
    speed: 0,
    curvature: 0,
    yawRate: 0,
    arrived: false,
    stuck: false,
    nearestX: 0,
    nearestY: 0,
    crossTrackM: 0,
    distanceToGoalM: 0,
    segment: 0,
  };

  private readonly segments: PathSegment[];

  constructor(
    segments: readonly PathSegment[],
    private readonly p: FollowerParams,
    private readonly stuckAfterS = 30,
  ) {
    this.segments = [...segments];
    if (segments.length === 0) throw new RangeError("a path needs at least one segment");
    if (p.drive === "forward-only" && segments.some((s) => s.reverse)) throw new RangeError("forward-only vehicles cannot follow reverse segments");
    this.pursuit = this.pursuitFor(0);
  }

  private pursuitFor(i: number): PurePursuit {
    const seg = this.segments[i];
    if (!seg) throw new RangeError("segment index");
    const p = this.p;
    return new PurePursuit(
      seg.pts,
      {
        maxSpeedMps: seg.reverse ? p.maxReverseSpeedMps : p.maxSpeedMps,
        turningRadiusM: p.drive === "differential" ? 0 : p.turningRadiusM,
        lookaheadM: p.lookaheadM,
        arrivalToleranceM: i + 1 < this.segments.length ? Math.min(p.arrivalToleranceM, CUSP_TOLERANCE_M) : p.arrivalToleranceM,
      },
      this.stuckAfterS,
    );
  }

  /**
   * Extends a forward path of one segment with more points (the next leg of a lazy refine; the first of them follows the
   * path's last point). The follower keeps its progress; the end of the path acts as a goal until more arrives, so the
   * vehicle slows and stops within the arrival tolerance there, and `arrived` is false again once points are appended.
   */
  append(pts: Float64Array): void {
    const only = this.segments[0];
    if (this.segments.length !== 1 || !only || only.reverse) throw new RangeError("only a forward path of one segment can be extended");
    if (pts.length % 2 !== 0) throw new RangeError("points are (x, y) pairs");
    if (pts.length === 0) return;
    const joined = new Float64Array(only.pts.length + pts.length);
    joined.set(only.pts);
    joined.set(pts, only.pts.length);
    this.segments[0] = { pts: joined, reverse: false };
    this.pursuit.extend(pts);
  }

  /**
   * The follower's run state as plain data (ADR-0035 addition of 2026-10-17, item 8): the path of every segment (legs
   * appended by a lazy plan included), the segment being driven, the tracker's progress, and the arrival tolerance this
   * follower was built with (a back-off or escape follower is tighter than the body's, so a restore rebuilds that variant).
   */
  snapshot(): FollowerSnapshot {
    return {
      segments: this.segments.map((s) => ({ pts: s.pts.slice(), reverse: s.reverse })),
      index: this.index,
      pursuit: this.pursuit.snapshot(),
      stuckAfterS: this.stuckAfterS,
      arrivalToleranceM: this.p.arrivalToleranceM,
    };
  }

  /** A follower with the snapshot's state, over the body's parameters (the snapshot supplies the arrival tolerance it was built with). */
  static restore(s: FollowerSnapshot, params: FollowerParams): PathFollower {
    const f = new PathFollower(
      s.segments.map((x) => ({ pts: x.pts.slice(), reverse: x.reverse })),
      { ...params, arrivalToleranceM: s.arrivalToleranceM },
      s.stuckAfterS,
    );
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= f.segments.length) throw new RangeError(`follower segment index ${s.index} of ${f.segments.length}`);
    f.index = s.index;
    f.pursuit = f.pursuitFor(s.index);
    f.pursuit.restore(s.pursuit);
    return f;
  }

  get segmentIndex(): number {
    return this.index;
  }

  /** Progress along the current segment (for checks of the path still ahead). */
  get progressSegment(): number {
    return this.pursuit.progressSegment;
  }

  get currentSegment(): PathSegment {
    return this.segments[this.index] ?? this.segments[0] as PathSegment;
  }

  update(s: UgvState, dtS: number): FollowCommand {
    const c = this.cmd;
    const p = this.p;
    const seg = this.currentSegment;
    const v = this.virt;
    v.x = s.x;
    v.y = s.y;
    v.heading = seg.reverse ? s.heading + Math.PI : s.heading;
    v.speed = Math.abs(s.speed);
    const pc = this.pursuit.update(v, dtS);
    c.segment = this.index;
    c.nearestX = pc.nearestX;
    c.nearestY = pc.nearestY;
    c.crossTrackM = pc.crossTrackM;
    c.distanceToGoalM = pc.distanceToGoalM;
    c.stuck = pc.stuck;
    c.arrived = false;
    c.speed = 0;
    c.curvature = 0;
    c.yawRate = 0;
    if (pc.arrived) {
      if (this.index + 1 >= this.segments.length) {
        c.arrived = true;
        return c;
      }
      // Cusp: stop this tick, then drive the next segment.
      this.index++;
      this.pursuit = this.pursuitFor(this.index);
      return c;
    }
    if (pc.stuck) return c;
    const dir = seg.reverse ? -1 : 1;
    if (p.drive === "differential" && Math.abs(pc.alpha) > ROTATE_IN_PLACE_RAD) {
      // Rotate in place towards the look-ahead point (rotating the vehicle rotates the virtual one too).
      c.yawRate = Math.max(-p.maxYawRateRadps, Math.min(p.maxYawRateRadps, pc.alpha / dtS));
      return c;
    }
    let speed = dir * pc.speed;
    const curvature = dir * pc.curvature;
    if (p.drive === "differential" && curvature !== 0) {
      // Slow down so that yaw rate = curvature × speed stays within the limit.
      const vMax = p.maxYawRateRadps / Math.abs(curvature);
      if (Math.abs(speed) > vMax) speed = dir * vMax;
    }
    c.speed = speed;
    c.curvature = curvature;
    return c;
  }
}
