import { TRAIL_MAX_POINTS, TRAIL_STRIDE } from "@agentsim/core";
import type { TrailBatch } from "./trail-recorder.ts";

/** An agent's executed path as the renderer reads it: a view of its points, their count and a replace counter. */
export interface ExecutedPath {
  /** x, y, z per point (`count` points), a view into a preallocated buffer: valid until the next `apply`. */
  readonly points: Float32Array;
  readonly count: number;
  /** Increments whenever the worker replaced the whole trail (thinning): the renderer then rebuilds it. */
  readonly version: number;
}

/**
 * The main thread's copy of the executed paths (F2 M1b): one preallocated `Float32Array` of `TRAIL_MAX_POINTS`
 * points per agent, fed by the worker's `trail` messages (replaces first, then appends). Bounded memory:
 * `TRAIL_MAX_POINTS` × 12 bytes per agent.
 */
export class TrailStore {
  private readonly bufs: Float32Array[] = [];
  private readonly counts: Uint32Array;
  private readonly versions: Uint32Array;

  constructor(agentCount: number) {
    for (let i = 0; i < agentCount; i++) this.bufs.push(new Float32Array(TRAIL_MAX_POINTS * TRAIL_STRIDE));
    this.counts = new Uint32Array(agentCount);
    this.versions = new Uint32Array(agentCount);
  }

  apply(m: TrailBatch): void {
    const r = m.replace;
    if (r) {
      for (let k = 0; k < r.agents.length; k++) {
        const i = r.agents[k] ?? -1;
        const buf = this.bufs[i];
        if (!buf) continue;
        const from = r.offsets[k] ?? 0;
        const n = Math.min(TRAIL_MAX_POINTS, (r.offsets[k + 1] ?? from) - from);
        buf.set(r.points.subarray(from * TRAIL_STRIDE, (from + n) * TRAIL_STRIDE));
        this.counts[i] = n;
        this.versions[i] = (this.versions[i] ?? 0) + 1;
      }
    }
    for (let k = 0; k < m.agents.length; k++) {
      const i = m.agents[k] ?? -1;
      const buf = this.bufs[i];
      const n = this.counts[i] ?? 0;
      if (!buf || n >= TRAIL_MAX_POINTS) continue;
      buf.set(m.points.subarray(k * TRAIL_STRIDE, (k + 1) * TRAIL_STRIDE), n * TRAIL_STRIDE);
      this.counts[i] = n + 1;
    }
  }

  path(i: number): ExecutedPath {
    const buf = this.bufs[i];
    if (!buf) return { points: new Float32Array(0), count: 0, version: 0 };
    const count = this.counts[i] ?? 0;
    return { points: buf.subarray(0, count * TRAIL_STRIDE), count, version: this.versions[i] ?? 0 };
  }
}
