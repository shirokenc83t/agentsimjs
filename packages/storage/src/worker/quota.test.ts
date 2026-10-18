import { describe, expect, it } from "vitest";
import { MEMORY_FALLBACK_LIMIT_BYTES, QUOTA_PAUSE_FRACTION, QUOTA_RESUME_FRACTION, QuotaGuard } from "./quota.ts";

// F3a M2: the quota guard (ADR-0035 §6, addition item 7): pause near the quota, resume clearly below it.

describe("QuotaGuard", () => {
  it("pauses at 90 % of the quota and resumes below 80 %, with nothing said in between", () => {
    expect([QUOTA_PAUSE_FRACTION, QUOTA_RESUME_FRACTION]).toEqual([0.9, 0.8]);
    const g = new QuotaGuard();
    const at = (usage: number) => g.update({ usageBytes: usage, quotaBytes: 1000 });
    expect(at(100)).toBeUndefined();
    expect(at(899)).toBeUndefined();
    expect(g.paused).toBe(false);
    expect(at(900)).toBe("paused");
    expect(g.paused).toBe(true);
    expect(at(950)).toBeUndefined(); // still paused: no repeated notice
    expect(at(850)).toBeUndefined(); // between the marks: stays paused
    expect(g.paused).toBe(true);
    expect(at(799)).toBe("ok");
    expect(g.paused).toBe(false);
    expect(at(850)).toBeUndefined(); // between the marks again: stays running
    expect(at(901)).toBe("paused");
  });

  it("keeps the last measurement, and a quota that is not a positive number never pauses", () => {
    const g = new QuotaGuard();
    g.update({ usageBytes: 5, quotaBytes: 10 });
    expect(g.measure).toEqual({ usageBytes: 5, quotaBytes: 10 });
    expect(g.update({ usageBytes: 5, quotaBytes: 0 })).toBeUndefined();
    expect(g.update({ usageBytes: 5, quotaBytes: Number.NaN })).toBeUndefined();
    expect(g.paused).toBe(false);
  });

  it("takes other marks, and the in-memory fallback has a limit of its own", () => {
    const g = new QuotaGuard(0.5, 0.25);
    expect(g.update({ usageBytes: 50, quotaBytes: 100 })).toBe("paused");
    expect(g.update({ usageBytes: 24, quotaBytes: 100 })).toBe("ok");
    expect(MEMORY_FALLBACK_LIMIT_BYTES).toBeGreaterThan(0);
  });
});
