import { TRAIL_MAX_POINTS, TRAIL_STRIDE } from "@agentsim/core";

/** Initial minimum distance between kept executed-path points (m); it doubles each time an agent's trail is thinned. */
export const TRAIL_STEP_M = 0.25;

/** What one drain sends to the main thread (the `trail` message's payload). */
export interface TrailBatch {
  /** Agent index of each appended point, and the points (x, y, z per point). */
  readonly agents: Uint16Array;
  readonly points: Float32Array;
  /** Whole trails of agents thinned since the previous drain: they supersede everything sent before for them. */
  readonly replace?: { readonly agents: Uint16Array; readonly offsets: Uint32Array; readonly points: Float32Array };
}

/**
 * Executed paths from simulation state (ROADMAP F1 UI: planned vs executed path), bounded (F2 M1b). Fed once per
 * tick with the authoritative poses, it keeps a point per agent whenever the agent moved the current step from
 * its last kept point (plus the start). At `TRAIL_MAX_POINTS` it doubles the agent's step and thins the kept
 * points to it, and the next drain replaces that agent's trail. Everything depends only on the sequence of
 * ticks, never on when drains happen, so every viewer sees the same line, headless included. A display aid:
 * full-fidelity trajectories come from trace poses (F3, ADR-0029).
 */
export class TrailRecorder {
  /** Kept points per agent: x, y, z each (preallocated, `TRAIL_MAX_POINTS` per agent). */
  private readonly pts: Float64Array[] = [];
  private readonly counts: Uint32Array;
  private readonly steps: Float64Array;
  /** First point not yet sent, per agent. */
  private readonly sentUpTo: Uint32Array;
  /** Thinned since the previous drain: send the whole trail. */
  private readonly replaced: Uint8Array;

  constructor(private readonly agentCount: number) {
    for (let i = 0; i < agentCount; i++) this.pts.push(new Float64Array(TRAIL_MAX_POINTS * TRAIL_STRIDE));
    this.counts = new Uint32Array(agentCount);
    this.steps = new Float64Array(agentCount).fill(TRAIL_STEP_M);
    this.sentUpTo = new Uint32Array(agentCount);
    this.replaced = new Uint8Array(agentCount);
  }

  /** Records agent `i` at the end of a tick. */
  observe(i: number, x: number, y: number, z: number): void {
    const p = this.pts[i];
    if (!p) return;
    let n = this.counts[i] ?? 0;
    if (n > 0) {
      const o = (n - 1) * TRAIL_STRIDE;
      const dx = x - (p[o] ?? 0);
      const dy = y - (p[o + 1] ?? 0);
      const step = this.steps[i] ?? TRAIL_STEP_M;
      if (dx * dx + dy * dy < step * step) return;
    }
    const o = n * TRAIL_STRIDE;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    n++;
    this.counts[i] = n;
    while (n >= TRAIL_MAX_POINTS) n = this.thin(i);
  }

  /**
   * Doubles agent `i`'s step and keeps the first point, then each point at least the new step from the last kept
   * one, then the last point (so the line still ends where the agent is). Returns the new count.
   */
  private thin(i: number): number {
    const p = this.pts[i] as Float64Array;
    const n = this.counts[i] ?? 0;
    const step = (this.steps[i] ?? TRAIL_STEP_M) * 2;
    this.steps[i] = step;
    let kept = 1;
    for (let k = 1; k < n; k++) {
      const s = k * TRAIL_STRIDE;
      const l = (kept - 1) * TRAIL_STRIDE;
      const dx = (p[s] ?? 0) - (p[l] ?? 0);
      const dy = (p[s + 1] ?? 0) - (p[l + 1] ?? 0);
      if (dx * dx + dy * dy < step * step && k !== n - 1) continue;
      if (k !== kept) p.copyWithin(kept * TRAIL_STRIDE, s, s + TRAIL_STRIDE);
      kept++;
    }
    this.counts[i] = kept;
    this.replaced[i] = 1;
    return kept;
  }

  /** Points kept for agent `i` (tests). */
  count(i: number): number {
    return this.counts[i] ?? 0;
  }

  /** Current step of agent `i` (m; tests). */
  step(i: number): number {
    return this.steps[i] ?? TRAIL_STEP_M;
  }

  /** Agent `i`'s kept points as the main thread receives them (Float32, x, y, z; tests). */
  points(i: number): Float32Array {
    return Float32Array.from((this.pts[i] ?? new Float64Array(0)).subarray(0, this.count(i) * TRAIL_STRIDE));
  }

  /** Appends (and replaces, for thinned agents) since the previous call, or undefined if nothing changed. */
  drain(): TrailBatch | undefined {
    let appends = 0;
    let replacedAgents = 0;
    let replacedPoints = 0;
    for (let i = 0; i < this.agentCount; i++) {
      const n = this.counts[i] ?? 0;
      if (this.replaced[i]) {
        replacedAgents++;
        replacedPoints += n;
      } else appends += n - (this.sentUpTo[i] ?? 0);
    }
    if (appends === 0 && replacedAgents === 0) return undefined;
    const agents = new Uint16Array(appends);
    const points = new Float32Array(appends * TRAIL_STRIDE);
    const rAgents = new Uint16Array(replacedAgents);
    const rOffsets = new Uint32Array(replacedAgents + 1);
    const rPoints = new Float32Array(replacedPoints * TRAIL_STRIDE);
    let a = 0;
    let r = 0;
    let rp = 0;
    for (let i = 0; i < this.agentCount; i++) {
      const p = this.pts[i] as Float64Array;
      const n = this.counts[i] ?? 0;
      if (this.replaced[i]) {
        rAgents[r] = i;
        rPoints.set(p.subarray(0, n * TRAIL_STRIDE), rp * TRAIL_STRIDE);
        rp += n;
        rOffsets[++r] = rp;
        this.replaced[i] = 0;
      } else {
        for (let k = this.sentUpTo[i] ?? 0; k < n; k++) {
          agents[a] = i;
          points.set(p.subarray(k * TRAIL_STRIDE, (k + 1) * TRAIL_STRIDE), a * TRAIL_STRIDE);
          a++;
        }
      }
      this.sentUpTo[i] = n;
    }
    return replacedAgents > 0 ? { agents, points, replace: { agents: rAgents, offsets: rOffsets, points: rPoints } } : { agents, points };
  }
}
