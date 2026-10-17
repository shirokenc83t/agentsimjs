/**
 * Fixed-step simulation clock (ADR-0002, ADR-0003). Sim time is derived from the tick count
 * (`tick * dtS`), never accumulated, so it does not drift with floating-point error.
 */
export class Clock {
  private t = 0;

  constructor(readonly dtS: number) {
    if (!(dtS > 0) || !Number.isFinite(dtS)) throw new RangeError(`dtS must be a positive finite number: ${dtS}`);
  }

  get tick(): number {
    return this.t;
  }

  get simTimeS(): number {
    return this.t * this.dtS;
  }

  /** Advances exactly one tick. */
  advance(): number {
    return ++this.t;
  }

  /** For snapshot restore. */
  setTick(tick: number): void {
    if (!Number.isInteger(tick) || tick < 0) throw new RangeError(`bad tick ${tick}`);
    this.t = tick;
  }
}
