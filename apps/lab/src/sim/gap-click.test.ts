import { describe, expect, it } from "vitest";
import { gapLabel, resolveGapClick } from "./gap-click.ts";

// F3a M3: a click in the gap lands on the persisted head, with the notice, and asks for nothing that is not stored.

describe("resolveGapClick", () => {
  it("a target at or before the persisted head resolves to itself, without a notice", () => {
    expect(resolveGapClick(0, 80, 100)).toEqual({ tick: 0 });
    expect(resolveGapClick(40, 80, 100)).toEqual({ tick: 40 });
    expect(resolveGapClick(80, 80, 100)).toEqual({ tick: 80 });
  });

  it("a target in the gap resolves to the persisted head, with the notice", () => {
    const r = resolveGapClick(95, 80, 100);
    expect(r.tick).toBe(80);
    expect(r.notice).toMatch(/Not saved yet/);
    expect(r.notice).toContain("tick 80");
    expect(resolveGapClick(81, 80, 100).tick).toBe(80);
    expect(resolveGapClick(100, 80, 100).tick).toBe(80);
  });

  it("a target past the sim head resolves to the persisted head too", () => {
    const r = resolveGapClick(150, 80, 100);
    expect(r.tick).toBe(80);
    expect(r.notice).toMatch(/Past the live run/);
  });

  it("with nothing in the gap every target up to the head is itself; negative and fractional targets are clamped and rounded", () => {
    expect(resolveGapClick(100, 100, 100)).toEqual({ tick: 100 });
    expect(resolveGapClick(-5, 100, 100)).toEqual({ tick: 0 });
    expect(resolveGapClick(12.4, 100, 100)).toEqual({ tick: 12 });
  });
});

describe("gapLabel", () => {
  it("says how many ticks and seconds are not saved yet, and nothing when all is saved", () => {
    expect(gapLabel(80, 100, 0.1)).toBe("not saved yet: 20 ticks (2.0 s)");
    expect(gapLabel(100, 100, 0.1)).toBeUndefined();
    expect(gapLabel(120, 100, 0.1)).toBeUndefined();
  });
});
