import { describe, expect, it } from "vitest";
import { Rng } from "./rng.ts";

const draw = (r: Rng, n: number) => Array.from({ length: n }, () => r.nextU32());

describe("Rng (ADR-0023)", () => {
  it("is reproducible from the seed", () => {
    expect(draw(Rng.fromSeed(7), 8)).toEqual(draw(Rng.fromSeed(7), 8));
    expect(draw(Rng.fromSeed(7), 8)).not.toEqual(draw(Rng.fromSeed(8), 8));
  });

  it("derives sub-streams that are independent of other streams' draws and of creation order", () => {
    const rootA = Rng.fromSeed(42);
    const a1 = rootA.derive("agent/uav-001");
    const before = draw(a1, 5);

    const rootB = Rng.fromSeed(42);
    const extra = rootB.derive("agent/uav-000"); // a new agent appears first
    draw(extra, 100);
    draw(rootB, 50); // the parent stream is consumed too
    const b1 = rootB.derive("agent/uav-001");
    expect(draw(b1, 5)).toEqual(before);
    expect(b1.path).toBe("agent/uav-001");
    expect(rootA.derive("x").derive("y").path).toBe("x/y");
  });

  it("produces floats in [0, 1) and unbiased integer ranges", () => {
    const r = Rng.fromSeed(1);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i++) {
      const f = r.nextFloat01();
      expect(f >= 0 && f < 1).toBe(true);
      const k = r.intRange(0, 5);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
    expect(() => r.intRange(3, 2)).toThrow(RangeError);
  });

  it("produces standard normals with the expected moments", () => {
    const r = Rng.fromSeed(3);
    let s = 0;
    let s2 = 0;
    const n = 40_000;
    for (let i = 0; i < n; i++) {
      const z = r.normal();
      s += z;
      s2 += z * z;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.02);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.03);
  });

  it("round-trips its state for snapshots", () => {
    const r = Rng.fromSeed(9).derive("s");
    draw(r, 3);
    r.normal();
    const st = r.getState();
    const next = [r.nextU32(), r.normal(), r.nextU32()];
    const r2 = Rng.fromSeed(9).derive("s");
    r2.setState(st);
    expect([r2.nextU32(), r2.normal(), r2.nextU32()]).toEqual(next);
  });
});
