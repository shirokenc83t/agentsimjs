import { describe, expect, it } from "vitest";
import { segmentsToDrop } from "./status-bar.tsx";

const w = (prio: number, width: number) => ({ prio, width });

describe("status bar fit (segments drop whole, by priority)", () => {
  it("drops nothing when everything fits", () => {
    expect(segmentsToDrop([w(1, 100), w(9, 100)], 200, 34)).toEqual([]);
  });

  it("drops the segments with the highest priority number first, and only as many as it takes, leaving room for the `…`", () => {
    const segs = [w(1, 100), w(8, 100), w(3, 100), w(10, 100), w(5, 100)];
    // 500 wide, 330 available, 34 for the `…`: drop 10, then 8, then 5 (300 + 34 is still over 330).
    expect(segmentsToDrop(segs, 330, 34)).toEqual([3, 1, 4]);
    // Room for four segments and the `…`: only the last priority goes.
    expect(segmentsToDrop(segs, 440, 34)).toEqual([3]);
  });

  it("drops the later of two segments of the same priority first", () => {
    expect(segmentsToDrop([w(5, 100), w(5, 100), w(1, 100)], 250, 34)).toEqual([1]);
  });

  it("never drops a segment it does not need to: a bar that fits without the `…` shows none", () => {
    expect(segmentsToDrop([w(1, 90), w(2, 90)], 180, 34)).toEqual([]);
  });
});
