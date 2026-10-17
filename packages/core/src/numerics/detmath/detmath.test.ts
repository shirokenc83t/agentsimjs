import { describe, expect, it } from "vitest";
import { Rng } from "../rng.ts";
import * as dm from "./index.ts";

/** Distance in units in the last place between two finite doubles. */
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  const v = new DataView(new ArrayBuffer(8));
  // Map doubles to a monotonic integer line (negative values mirrored), then subtract.
  const ordered = (x: number): bigint => {
    v.setFloat64(0, x);
    const i = v.getBigInt64(0);
    return i < 0n ? -(i & 0x7fffffffffffffffn) : i;
  };
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

const rng = Rng.fromSeed(123).derive("detmath-test");
const sample = (n: number, lo: number, hi: number) => Array.from({ length: n }, () => lo + (hi - lo) * rng.nextFloat01());

// Accuracy against the host's Math (V8 in Node). fdlibm ports: ≤ 1 ulp; derived functions: ≤ 3 ulp.
describe("detmath accuracy vs Math (V8)", () => {
  it.each([
    ["sin", dm.sin, Math.sin, sample(2000, -100, 100), 1],
    ["cos", dm.cos, Math.cos, sample(2000, -100, 100), 1],
    ["sin (medium range)", dm.sin, Math.sin, sample(500, -8e5, 8e5), 1],
    ["tan", dm.tan, Math.tan, sample(2000, -1.5, 1.5), 3],
    ["atan", dm.atan, Math.atan, sample(2000, -1e3, 1e3), 1],
    ["asin", dm.asin, Math.asin, sample(2000, -1, 1), 3],
    ["acos", dm.acos, Math.acos, sample(2000, -1, 1), 3],
    ["exp", dm.exp, Math.exp, sample(2000, -700, 700), 1],
    ["log", dm.log, Math.log, sample(2000, 1e-10, 1e10), 1],
  ] as const)("%s", (_name, f, ref, xs, maxUlps) => {
    let worst = 0;
    for (const x of xs) worst = Math.max(worst, ulps(f(x), ref(x)));
    expect(worst).toBeLessThanOrEqual(maxUlps);
  });

  it("atan2 and hypot", () => {
    let worstA = 0;
    let worstH = 0;
    for (let i = 0; i < 2000; i++) {
      const [y, x] = sample(2, -1e3, 1e3) as [number, number];
      worstA = Math.max(worstA, ulps(dm.atan2(y, x), Math.atan2(y, x)));
      worstH = Math.max(worstH, ulps(dm.hypot(y, x), Math.hypot(y, x)));
    }
    expect(worstA).toBeLessThanOrEqual(2);
    expect(worstH).toBeLessThanOrEqual(2);
  });

  it("pow: exact small integer exponents, close elsewhere", () => {
    for (let n = -10; n <= 10; n++) expect(dm.pow(2, n)).toBe(2 ** n);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const [x, y] = [0.01 + 10 * rng.nextFloat01(), -5 + 10 * rng.nextFloat01()];
      worst = Math.max(worst, ulps(dm.pow(x, y), Math.pow(x, y)));
    }
    expect(worst).toBeLessThanOrEqual(16); // exp(y·log x) core: documented accuracy limit
  });

  it("follows IEEE/ES special cases", () => {
    expect(dm.sin(Number.NaN)).toBeNaN();
    expect(dm.sin(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(Object.is(dm.sin(-0), -0)).toBe(true);
    expect(dm.cos(0)).toBe(1);
    expect(dm.exp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(dm.exp(1000)).toBe(Number.POSITIVE_INFINITY);
    expect(dm.log(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(dm.log(-1)).toBeNaN();
    expect(dm.log(1)).toBe(0);
    expect(dm.atan2(0, -1)).toBe(Math.PI);
    expect(Object.is(dm.atan2(-0, 1), -0)).toBe(true);
    expect(dm.atan2(1, 0)).toBe(Math.PI / 2);
    expect(dm.pow(-8, 1 / 3)).toBeNaN();
    expect(dm.pow(Number.NEGATIVE_INFINITY, 3)).toBe(Number.NEGATIVE_INFINITY);
    expect(dm.pow(Number.NEGATIVE_INFINITY, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(dm.hypot(3, 4)).toBe(5);
    expect(dm.asin(2)).toBeNaN();
  });
});
