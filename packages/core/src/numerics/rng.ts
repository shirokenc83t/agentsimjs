import { cos, log } from "./detmath/index.ts";
import { utf8, xxHash32 } from "./xxhash32.ts";

/** SplitMix32 step: returns [nextState, output]. Used only to expand a 32-bit seed into Rng state. */
function splitMix32(state: number): [number, number] {
  const s = (state + 0x9e3779b9) >>> 0;
  let z = s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return [s, (z ^ (z >>> 16)) >>> 0];
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * Seeded PRNG of the run (ADR-0002, ADR-0023): xoshiro128** with 32-bit integer operations only.
 * Sub-streams are derived from a path, independent of how many numbers other streams have drawn,
 * so adding an agent or a sensor never reshuffles existing streams.
 */
export class Rng {
  private readonly s = new Uint32Array(4);
  private spareNormal = Number.NaN;

  private constructor(
    /** 32-bit seed this stream was created from (parent of its sub-streams). */
    readonly seed: number,
    /** Stream path, for diagnostics and snapshots. */
    readonly path: string,
  ) {
    let st = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      const [next, out] = splitMix32(st);
      st = next;
      this.s[i] = out;
    }
    // xoshiro must not start from the all-zero state (unreachable from SplitMix32, but be explicit).
    if (this.s.every((w) => w === 0)) this.s[0] = 1;
  }

  /** Root stream of a run. */
  static fromSeed(seed: number): Rng {
    if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer: ${seed}`);
    return new Rng(seed >>> 0, "");
  }

  /** Derived sub-stream, e.g. `rng.derive("agent/uav-001/battery-noise")`. */
  derive(path: string): Rng {
    if (path.length === 0) throw new RangeError("stream path must not be empty");
    const full = this.path ? `${this.path}/${path}` : path;
    return new Rng(xxHash32(utf8(path), this.seed), full);
  }

  /** Uniform unsigned 32-bit integer. */
  nextU32(): number {
    const s = this.s;
    const s0 = s[0] ?? 0;
    const s1 = s[1] ?? 0;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s[2] = (s[2] ?? 0) ^ s0;
    s[3] = (s[3] ?? 0) ^ s1;
    s[1] = s1 ^ (s[2] ?? 0);
    s[0] = s0 ^ (s[3] ?? 0);
    s[2] = (s[2] ?? 0) ^ t;
    s[3] = rotl(s[3] ?? 0, 11);
    return result;
  }

  /** Uniform in [0, 1) with 53 random bits. */
  nextFloat01(): number {
    const a = this.nextU32() >>> 5; // 27 bits
    const b = this.nextU32() >>> 6; // 26 bits
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Uniform integer in [min, max] (inclusive), unbiased (rejection sampling). */
  intRange(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`bad range [${min}, ${max}]`);
    const span = max - min + 1;
    if (span > 0x100000000) throw new RangeError("range wider than 2^32");
    if (span === 0x100000000) return min + this.nextU32();
    const limit = 0x100000000 - (0x100000000 % span);
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return min + (x % span);
  }

  /** Standard normal deviate (Box–Muller with detmath, ADR-0023). */
  normal(mean = 0, stdDev = 1): number {
    if (!Number.isNaN(this.spareNormal)) {
      const z = this.spareNormal;
      this.spareNormal = Number.NaN;
      return mean + stdDev * z;
    }
    let u = 0;
    while (u === 0) u = this.nextFloat01();
    const v = this.nextFloat01();
    const r = Math.sqrt(-2 * log(u));
    const theta = 2 * Math.PI * v;
    this.spareNormal = r * cos(theta - Math.PI / 2); // = r * sin(theta)
    return mean + stdDev * r * cos(theta);
  }

  /** Internal state for snapshots and the state hash. */
  getState(): { s: [number, number, number, number]; spareNormal: number } {
    return { s: [this.s[0] ?? 0, this.s[1] ?? 0, this.s[2] ?? 0, this.s[3] ?? 0], spareNormal: this.spareNormal };
  }

  setState(state: { s: readonly [number, number, number, number]; spareNormal: number }): void {
    this.s.set(state.s);
    this.spareNormal = state.spareNormal;
  }
}
