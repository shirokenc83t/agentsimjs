import { describe, expect, it } from "vitest";
import { LABEL_PX, LANE_PX, laneAt, RULER_PX, rulerTicks, selectionFromDrag } from "./timeline-geometry.ts";

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

describe("the range a drag on the ruler selects", () => {
  const W = LABEL_PX + 600; // a 600 px track standing for 60 s: 10 px a second
  it("measures both ends in seconds, orders them, and rounds to a tenth", () => {
    expect(selectionFromDrag(LABEL_PX + 100, LABEL_PX + 250, W, 60)).toEqual({ t0S: 10, t1S: 25 });
    expect(selectionFromDrag(LABEL_PX + 250, LABEL_PX + 100, W, 60)).toEqual({ t0S: 10, t1S: 25 }); // dragged backwards
    expect(selectionFromDrag(LABEL_PX + 101, LABEL_PX + 252, W, 60)).toEqual({ t0S: 10.1, t1S: 25.2 });
  });

  it("clamps to the track: dragging past either end selects up to it", () => {
    expect(selectionFromDrag(0, LABEL_PX + 60, W, 60)).toEqual({ t0S: 0, t1S: 6 });
    expect(selectionFromDrag(LABEL_PX + 540, W + 400, W, 60)).toEqual({ t0S: 54, t1S: 60 });
  });

  it("is none when both ends are the same moment, or there is no track or no time", () => {
    expect(selectionFromDrag(LABEL_PX + 100, LABEL_PX + 100, W, 60)).toBeUndefined();
    expect(selectionFromDrag(LABEL_PX + 100, LABEL_PX + 100.4, W, 60)).toBeUndefined(); // within a tenth of a second
    expect(selectionFromDrag(10, 50, LABEL_PX, 60)).toBeUndefined();
    expect(selectionFromDrag(LABEL_PX, LABEL_PX + 50, W, 0)).toBeUndefined();
  });
});
