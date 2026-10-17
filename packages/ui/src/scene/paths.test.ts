import { TRAIL_MAX_POINTS } from "@agentsim/core";
import type { BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { PathLayer } from "./paths.ts";

/** A path as the store hands it over: a view of `count` points (x, y, z) and its replace version. */
function path(points: number[], version = 0) {
  return { points: Float32Array.from(points), count: points.length / 3, version };
}

function drawn(layer: PathLayer, id: string): { positions: number[]; count: number; attr: BufferAttribute } {
  const g = layer.executedGeometry(id);
  if (!g) throw new Error("no geometry");
  const attr = g.getAttribute("position") as BufferAttribute;
  return { positions: Array.from((attr.array as Float32Array).subarray(0, g.drawRange.count * 3)), count: g.drawRange.count, attr };
}

describe("PathLayer executed trails (bounded, F2 M1b)", () => {
  it("preallocates TRAIL_MAX_POINTS per agent", () => {
    const l = new PathLayer();
    l.ensure("a", "x");
    expect(drawn(l, "a").attr.count).toBe(TRAIL_MAX_POINTS);
  });

  it("appends only new points, and marks only the appended range for upload", () => {
    const l = new PathLayer();
    l.ensure("a", "x");
    l.setExecuted("a", path([1, 2, 0, 3, 4, 0]));
    let d = drawn(l, "a");
    expect(d.count).toBe(2);
    expect(d.positions).toEqual([1, 0.05000000074505806, -2, 3, 0.05000000074505806, -4]);
    d.attr.clearUpdateRanges(); // the renderer consumed the first upload
    l.setExecuted("a", path([1, 2, 0, 3, 4, 0, 5, 6, 0, 7, 8, 0]));
    d = drawn(l, "a");
    expect(d.count).toBe(4);
    expect(d.attr.updateRanges).toEqual([{ start: 6, count: 6 }]);
    l.setExecuted("a", path([1, 2, 0, 3, 4, 0, 5, 6, 0, 7, 8, 0])); // nothing new
    expect(drawn(l, "a").attr.updateRanges).toEqual([{ start: 6, count: 6 }]);
  });

  it("a replace (new version) rebuilds the trail: same buffer as a fresh build from the final list, uploaded whole", () => {
    const appended = new PathLayer();
    appended.ensure("a", "x");
    appended.setExecuted("a", path([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]));
    appended.setExecuted("a", path([0, 0, 0, 2, 0, 0, 3, 0, 0], 1)); // thinned: fewer points
    const fresh = new PathLayer();
    fresh.ensure("a", "x");
    fresh.setExecuted("a", path([0, 0, 0, 2, 0, 0, 3, 0, 0], 1));
    const a = drawn(appended, "a");
    const f = drawn(fresh, "a");
    expect(a.count).toBe(3);
    expect(a.positions).toEqual(f.positions);
    expect(a.attr.updateRanges).toEqual([]); // whole-buffer upload
    // Appends continue after the replace.
    appended.setExecuted("a", path([0, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0], 1));
    expect(drawn(appended, "a").count).toBe(4);
  });

  it("never draws more than TRAIL_MAX_POINTS", () => {
    const l = new PathLayer();
    l.ensure("a", "x");
    const n = TRAIL_MAX_POINTS + 5;
    l.setExecuted("a", { points: new Float32Array(n * 3), count: n, version: 0 });
    expect(drawn(l, "a").count).toBe(TRAIL_MAX_POINTS);
    expect(l.counts("a").executed).toBe(TRAIL_MAX_POINTS);
  });
});
