/** Fixed-size ring buffer of samples with mean and p95 (no allocation per sample). */
export class RollingStats {
  private readonly buf: Float64Array;
  private readonly scratch: Float64Array;
  private n = 0;
  private i = 0;

  constructor(capacity = 240) {
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  add(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  get count(): number {
    return this.n;
  }

  mean(): number {
    if (this.n === 0) return 0;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k] ?? 0;
    return s / this.n;
  }

  /** Nearest-rank percentile, `q` in (0, 1]. Called at ≤ 10 Hz, never per frame. */
  percentile(q: number): number {
    if (this.n === 0) return 0;
    const view = this.scratch.subarray(0, this.n);
    view.set(this.buf.subarray(0, this.n));
    view.sort();
    return view[Math.min(this.n - 1, Math.max(0, Math.ceil(q * this.n) - 1))] ?? 0;
  }

  reset(): void {
    this.n = 0;
    this.i = 0;
  }
}
