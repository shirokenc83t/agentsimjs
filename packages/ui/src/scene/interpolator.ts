import { POSE_STRIDE } from "@agentsim/core";

/** Tuning of the arrival-interval estimator (ADR-0019). */
export interface InterpolatorOptions {
  /** EMA factor for the measured interval between received states. */
  readonly smoothing: number;
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number;
  /** A gap longer than this multiple of the estimate is a pause, not a slow tick. */
  readonly pauseFactor: number;
}

export const DEFAULT_INTERPOLATOR_OPTIONS: InterpolatorOptions = {
  smoothing: 0.2,
  minIntervalMs: 4,
  maxIntervalMs: 1000,
  pauseFactor: 3,
};

/**
 * Keeps the two latest sim states and blends between them at display rate (ADR-0019).
 * `alpha` uses the *measured* (smoothed) interval between received states, not the nominal tick
 * interval, so it stays smooth under jitter, speed changes and pauses. No extrapolation.
 * Preallocated buffers: no allocation per frame.
 */
export class StateInterpolator {
  private prev = new Float32Array(0);
  private next = new Float32Array(0);
  private out = new Float32Array(0);
  private count = 0;
  private tRecvNext = Number.NaN;
  private intervalEst = Number.NaN;
  private snapNext = true;
  private disabled = false;
  private readonly opts: InterpolatorOptions;

  constructor(opts: Partial<InterpolatorOptions> = {}) {
    this.opts = { ...DEFAULT_INTERPOLATOR_OPTIONS, ...opts };
  }

  /** Feed a newly received state. `nowMs` is the main-thread receive time. */
  push(poses: Float32Array, nowMs: number): void {
    const n = poses.length;
    if (n !== this.next.length) {
      // Entity table changed: resize and show the new state directly.
      this.prev = new Float32Array(n);
      this.next = new Float32Array(n);
      this.out = new Float32Array(n);
      this.count = n / POSE_STRIDE;
      this.snapNext = true;
    }
    if (!Number.isNaN(this.tRecvNext)) {
      const gap = nowMs - this.tRecvNext;
      const isPause = !Number.isNaN(this.intervalEst) && gap > this.opts.pauseFactor * this.intervalEst;
      if (isPause) {
        // Resume after a pause: excluded from the estimate; show the new state without blending across the gap.
        this.snapNext = true;
      } else {
        const g = Math.min(this.opts.maxIntervalMs, Math.max(this.opts.minIntervalMs, gap));
        this.intervalEst = Number.isNaN(this.intervalEst) ? g : this.intervalEst + this.opts.smoothing * (g - this.intervalEst);
      }
    }
    if (this.snapNext) {
      this.prev.set(poses);
      this.snapNext = false;
    } else {
      this.prev.set(this.next);
    }
    this.next.set(poses);
    this.tRecvNext = nowMs;
  }

  /** Forget the interval estimate (speed/tick-rate change); converges within a few states. */
  resetEstimate(): void {
    this.intervalEst = Number.NaN;
  }

  /** Show the next state directly, without blending from the current one (a new run was loaded). */
  snapToNext(): void {
    this.snapNext = true;
  }

  setEnabled(enabled: boolean): void {
    this.disabled = !enabled;
  }

  /** Blend factor in [0, 1] at `nowMs`. */
  alpha(nowMs: number): number {
    if (this.disabled || Number.isNaN(this.tRecvNext) || Number.isNaN(this.intervalEst)) return 1;
    const a = (nowMs - this.tRecvNext) / this.intervalEst;
    return a <= 0 ? 0 : a >= 1 ? 1 : a;
  }

  /** Interpolated poses at `nowMs` (view into an internal buffer; valid until the next call). */
  sample(nowMs: number): Float32Array {
    const a = this.alpha(nowMs);
    const p = this.prev;
    const q = this.next;
    const o = this.out;
    for (let i = 0; i < o.length; i++) {
      const x = p[i] ?? 0;
      const y = q[i] ?? 0;
      if (i % POSE_STRIDE === 3) {
        // yaw: shortest angular path
        let d = y - x;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        o[i] = x + d * a;
      } else {
        o[i] = x + (y - x) * a;
      }
    }
    return o;
  }

  /** The latest received tick state (not interpolated): view, valid until the next push. */
  latest(): Float32Array {
    return this.next;
  }

  get entityCount(): number {
    return this.count;
  }

  get intervalEstimateMs(): number {
    return this.intervalEst;
  }
}
