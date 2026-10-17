import { atan2, cos, exp, log, pow, sin } from "../numerics/detmath/index.ts";
import { Rng } from "../numerics/rng.ts";
import { StateHasher, type NaNReporter } from "../numerics/state-hash.ts";
import type { Steppable, TickContext } from "../time/scheduler.ts";

/**
 * Deterministic probe world for determinism tests (milestone (a); the real world arrives in (d)).
 * Exercises Rng sub-streams and every detmath function so that any engine difference would change
 * the state hash.
 */
export class ProbeWorld implements Steppable {
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly heading: Float64Array;
  private readonly energy: Float64Array;
  private readonly streams: Rng[];
  private lastTick = 0;

  constructor(seed: number, readonly particles = 16) {
    const root = Rng.fromSeed(seed);
    this.x = new Float64Array(particles);
    this.y = new Float64Array(particles);
    this.heading = new Float64Array(particles);
    this.energy = new Float64Array(particles).fill(100);
    this.streams = Array.from({ length: particles }, (_, i) => root.derive(`particle/${String(i).padStart(3, "0")}`));
  }

  step(ctx: TickContext): void {
    if (ctx.tick !== this.lastTick + 1) throw new Error(`tick gap: ${this.lastTick} -> ${ctx.tick}`);
    this.lastTick = ctx.tick;
    for (let i = 0; i < this.particles; i++) {
      const rng = this.streams[i];
      if (!rng) continue;
      const h = (this.heading[i] ?? 0) + rng.normal(0, 0.15);
      const speed = 1 + exp(-0.01 * (this.energy[i] ?? 0)) + 0.5 * log(1 + rng.nextFloat01());
      const xi = (this.x[i] ?? 0) + cos(h) * speed * ctx.dtS;
      const yi = (this.y[i] ?? 0) + sin(h) * speed * ctx.dtS;
      // Steer back towards the origin with atan2; pow for a nonlinear energy drain.
      const back = atan2(-yi, -xi);
      this.heading[i] = h + 0.01 * sin(back - h);
      this.x[i] = xi;
      this.y[i] = yi;
      this.energy[i] = Math.max(0, (this.energy[i] ?? 0) - 0.001 * pow(speed, 1.7) - 0.0001 * rng.intRange(0, 3));
    }
  }

  hash(onNaN?: NaNReporter): string {
    const h = new StateHasher(onNaN).u32(this.lastTick);
    for (let i = 0; i < this.particles; i++) {
      h.f64(this.x[i] ?? 0, `p${i}.x`).f64(this.y[i] ?? 0, `p${i}.y`).f64(this.heading[i] ?? 0, `p${i}.heading`).f64(this.energy[i] ?? 0, `p${i}.energy`);
      const st = this.streams[i]?.getState();
      if (st) for (const w of st.s) h.u32(w);
    }
    return h.hex();
  }
}
