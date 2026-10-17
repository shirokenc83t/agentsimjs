import { describe, expect, it } from "vitest";
import { RollingStats } from "./rolling-stats.ts";

describe("RollingStats", () => {
  it("computes mean and p95 over a sliding window", () => {
    const s = new RollingStats(100);
    for (let i = 1; i <= 100; i++) s.add(i);
    expect(s.mean()).toBe(50.5);
    expect(s.percentile(0.95)).toBe(95);
    for (let i = 0; i < 100; i++) s.add(1);
    expect(s.mean()).toBe(1);
    expect(s.count).toBe(100);
  });

  it("is empty-safe", () => {
    expect(new RollingStats().percentile(0.95)).toBe(0);
  });
});
