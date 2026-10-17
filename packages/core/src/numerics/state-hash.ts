import { utf8, xxHash32 } from "./xxhash32.ts";

/** Fixed bit pattern every NaN is hashed as (ADR-0023). */
const CANONICAL_NAN_HI = 0x7ff80000;

/** Called when hashed state contains NaN: a bug signal (dev assertion + traced degradation). */
export type NaNReporter = (fieldPath: string) => void;

/**
 * Builds the canonical byte layout of simulation state and hashes it with xxHash32 (ADR-0023).
 * Values are written in a fixed order chosen by the caller (sorted IDs, fixed field order).
 * Floats are written as little-endian Float64, NaN canonicalized.
 */
export class StateHasher {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  constructor(private readonly onNaN?: NaNReporter) {}

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }

  /** Float64; `path` names the field for NaN reports. */
  f64(v: number, path = "?"): this {
    this.ensure(8);
    if (Number.isNaN(v)) {
      this.onNaN?.(path);
      this.view.setUint32(this.len, 0, true);
      this.view.setUint32(this.len + 4, CANONICAL_NAN_HI, true);
    } else {
      this.view.setFloat64(this.len, v, true);
    }
    this.len += 8;
    return this;
  }

  str(s: string): this {
    const b = utf8(s);
    this.u32(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Raw bytes (e.g. a grid chunk) are folded in as their own xxHash32 for caching per chunk. */
  bytesHash(h: number): this {
    return this.u32(h);
  }

  digest(): number {
    return xxHash32(this.buf, 0, this.len);
  }

  hex(): string {
    return this.digest().toString(16).padStart(8, "0");
  }

  reset(): this {
    this.len = 0;
    return this;
  }
}
