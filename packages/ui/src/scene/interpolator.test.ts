import { describe, expect, it } from "vitest";
import { StateInterpolator } from "./interpolator.ts";

const pose = (x: number, yaw = 0) => new Float32Array([x, 0, 0, yaw]);

describe("StateInterpolator (ADR-0019)", () => {
  it("blends between the two latest states using the measured interval", () => {
    const it = new StateInterpolator();
    it.push(pose(0), 0);
    it.push(pose(10), 100); // measured interval 100 ms
    expect(it.intervalEstimateMs).toBe(100);
    expect(it.sample(100)[0]).toBeCloseTo(0);
    expect(it.sample(150)[0]).toBeCloseTo(5);
    expect(it.sample(200)[0]).toBeCloseTo(10);
    expect(it.sample(400)[0]).toBeCloseTo(10); // no extrapolation
  });

  it("produces a new position on every frame between ticks (smooth at display rate)", () => {
    const it = new StateInterpolator();
    it.push(pose(0), 0);
    it.push(pose(1), 100);
    const xs: number[] = [];
    for (let t = 100; t < 200; t += 16.7) xs.push(it.sample(t)[0] ?? Number.NaN);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] ?? Infinity);
  });

  it("adapts to jitter and speed changes through the smoothed estimate", () => {
    const it = new StateInterpolator({ smoothing: 0.5 });
    let t = 0;
    it.push(pose(0), t);
    for (let i = 1; i <= 20; i++) it.push(pose(i), (t += 100 + (i % 2 ? 15 : -15)));
    expect(it.intervalEstimateMs).toBeGreaterThan(85);
    expect(it.intervalEstimateMs).toBeLessThan(115);
    for (let i = 21; i <= 40; i++) it.push(pose(i), (t += 50)); // speed doubled
    expect(it.intervalEstimateMs).toBeCloseTo(50, 0);
  });

  it("holds on the latest state during a pause and does not blend across it", () => {
    const it = new StateInterpolator();
    it.push(pose(0), 0);
    it.push(pose(1), 100);
    it.push(pose(2), 200);
    expect(it.sample(5000)[0]).toBeCloseTo(2); // paused: alpha clamps at 1
    it.push(pose(3), 5000); // resume after a long gap
    expect(it.intervalEstimateMs).toBeCloseTo(100); // gap excluded from the estimate
    expect(it.sample(5000)[0]).toBeCloseTo(3); // snapped, no jump back to 2
  });

  it("interpolates yaw along the shortest arc", () => {
    const it = new StateInterpolator();
    it.push(pose(0, 3.1), 0);
    it.push(pose(0, -3.1), 100);
    const yaw = it.sample(150)[3] ?? 0;
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.05);
  });

  it("can be disabled to show raw ticks", () => {
    const it = new StateInterpolator();
    it.push(pose(0), 0);
    it.push(pose(10), 100);
    it.setEnabled(false);
    expect(it.sample(150)[0]).toBe(10);
  });
});
