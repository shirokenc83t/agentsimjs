import { describe, expect, it } from "vitest";
import { LANE_PX, laneAt, RULER_PX, rulerTicks } from "./timeline-geometry.ts";

describe("timeline geometry", () => {
  it("the seconds ruler takes the smallest round step that keeps its labels apart", () => {
    // 100 s over 640 px: 64 px is 10 s.
    expect(rulerTicks(100, 640).map((t) => t.t)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    // 20 s over 1000 px: 64 px is 1.28 s, so 2 s.
    expect(rulerTicks(20, 1000).map((t) => t.label).slice(0, 4)).toEqual(["0 s", "2 s", "4 s", "6 s"]);
    expect(rulerTicks(1, 1000).map((t) => t.label).slice(0, 3)).toEqual(["0.0 s", "0.1 s", "0.2 s"]);
    expect(rulerTicks(0, 100)).toEqual([]);
  });

  it("a y on the canvas is the ruler or a lane", () => {
    expect(laneAt(2, 4)).toBe(-1);
    expect(laneAt(RULER_PX, 4)).toBe(0);
    expect(laneAt(RULER_PX + 2 * LANE_PX + 3, 4)).toBe(2);
    expect(laneAt(10_000, 4)).toBe(3);
  });
});
