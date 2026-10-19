/**
 * The storage quota guard of a recorded run (ADR-0035 §6 and addition of 2026-10-17, item 7; ADR-0020 addition of the same date): usage
 * and quota are measured after commits (`navigator.storage.estimate()` for OPFS, the database's own size in the in-memory fallback). Near
 * the quota the worker stops accepting the run's batches and the run pauses as `storage_quota`; it goes on once usage has fallen
 * clearly below it again. The two fractions leave room, so a run does not flip between paused and running on every flush.
 */
export const QUOTA_PAUSE_FRACTION = 0.9;
export const QUOTA_RESUME_FRACTION = 0.8;
/** The limit of the in-memory fallback's database (there is no browser quota to read). */
export const MEMORY_FALLBACK_LIMIT_BYTES = 256 * 1024 * 1024;

export interface QuotaMeasure {
  readonly usageBytes: number;
  readonly quotaBytes: number;
}

export class QuotaGuard {
  private isPaused = false;
  private last: QuotaMeasure | undefined;

  constructor(
    private readonly pauseFraction = QUOTA_PAUSE_FRACTION,
    private readonly resumeFraction = QUOTA_RESUME_FRACTION,
  ) {}

  get paused(): boolean {
    return this.isPaused;
  }

  get measure(): QuotaMeasure | undefined {
    return this.last;
  }

  /** Takes a measurement; returns the new state when it changed (`paused` or `ok`), else undefined. A quota that is not a positive number never pauses. */
  update(m: QuotaMeasure): "paused" | "ok" | undefined {
    this.last = m;
    if (!(m.quotaBytes > 0)) return undefined;
    const used = m.usageBytes / m.quotaBytes;
    if (!this.isPaused && used >= this.pauseFraction) {
      this.isPaused = true;
      return "paused";
    }
    if (this.isPaused && used < this.resumeFraction) {
      this.isPaused = false;
      return "ok";
    }
    return undefined;
  }
}
