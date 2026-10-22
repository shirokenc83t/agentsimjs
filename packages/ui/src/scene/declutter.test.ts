import { describe, expect, it } from "vitest";
import { clusterPoints, stackLabels, type LabelBox, type ScreenPoint } from "./declutter.ts";

const box = (index: number, x: number, y: number, keep = false): LabelBox => ({ index, x, y, w: 60, h: 18, keep });
const p = (index: number, x: number, y: number, keep = false): ScreenPoint => ({ index, x, y, keep });

describe("label declutter", () => {
  it("agents within the radius of each other (a chain counts) become one cluster with a centroid; the ones apart stay alone", () => {
    const clusters = clusterPoints([p(0, 100, 100), p(1, 110, 100), p(2, 120, 100), p(3, 400, 300), p(4, 100, 500)], 12);
    expect(clusters).toEqual([{ members: [0, 1, 2], cx: 110, cy: 100 }]);
  });

  it("agents that keep their label (attention, selected) are never in a cluster", () => {
    const clusters = clusterPoints([p(0, 100, 100), p(1, 105, 100, true), p(2, 108, 100)], 12);
    expect(clusters).toEqual([{ members: [0, 2], cx: 104, cy: 100 }]);
    expect(clusterPoints([p(0, 100, 100, true), p(1, 105, 100, true)], 12)).toEqual([]);
  });

  it("two clusters far apart are two, in the order of their first agent, and the same points always give the same answer", () => {
    const pts = [p(5, 300, 300), p(0, 10, 10), p(6, 305, 300), p(1, 15, 12)];
    const a = clusterPoints(pts, 12);
    expect(a.map((c) => c.members)).toEqual([[0, 1], [5, 6]]);
    expect(clusterPoints([...pts].reverse(), 12)).toEqual(a);
  });

  it("a point exactly at the radius joins, one past it does not; nothing or one point is no cluster", () => {
    expect(clusterPoints([p(0, 0, 0), p(1, 12, 0)], 12)).toHaveLength(1);
    expect(clusterPoints([p(0, 0, 0), p(1, 12.1, 0)], 12)).toHaveLength(0);
    expect(clusterPoints([], 12)).toEqual([]);
    expect(clusterPoints([p(0, 1, 1)], 12)).toEqual([]);
  });
});

describe("label stacking", () => {
  it("labels that do not touch stay where they are", () => {
    expect(stackLabels([box(0, 0, 0), box(1, 100, 0), box(2, 0, 40)])).toEqual([0, 0, 0]);
  });

  it("a label that would cover another is moved down, clear of it, by whole label heights (the one that keeps its label stays)", () => {
    const out = stackLabels([box(0, 10, 10, true), box(1, 14, 12)]);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThanOrEqual(box(0, 0, 0).h);
    // Moved clear: the second box no longer intersects the first.
    expect(10 + 18 <= 12 + (out[1] as number)).toBe(true);
  });

  it("three labels on one spot make a stack, each below the last, and the same boxes always give the same offsets", () => {
    const boxes = [box(0, 50, 50), box(1, 52, 50), box(2, 54, 51)];
    const a = stackLabels(boxes);
    expect(new Set(a).size).toBe(3);
    expect(a[0]).toBe(0);
    expect(stackLabels([...boxes])).toEqual(a);
  });
});
