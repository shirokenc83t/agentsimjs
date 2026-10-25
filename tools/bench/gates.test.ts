import { describe, expect, it } from "vitest";
import { evaluate, limitsOf } from "./gates.mjs";

const m = (median: number, p95: number) => ({ mean: median, median, p95, unit: "ms" });
const single = { stat: "p95", max: 9 };
const two = { stat: "median", max: 8, tailStat: "p95", tailMax: 12, ciStat: "median", ciMax: 18 };

describe("the limits of a bench row", () => {
  it("are one for a row as before: the stat (p95 by default) against its max", () => {
    expect(limitsOf(single, false)).toEqual([{ stat: "p95", max: 9 }]);
    expect(limitsOf({ max: 4 }, false)).toEqual([{ stat: "p95", max: 4 }]);
    expect(evaluate(single, m(5, 8.9), false).ok).toBe(true);
    expect(evaluate(single, m(5, 9.1), false)).toMatchObject({ ok: false, failures: [{ stat: "p95", max: 9 }] });
  });

  it("are two for a row with a tail guard: the gate on the median and the p95 against the loose limit", () => {
    expect(limitsOf(two, false)).toEqual([{ stat: "median", max: 8 }, { stat: "p95", max: 12 }]);
    expect(evaluate(two, m(5.9, 9.1), false).ok).toBe(true); // the noisy p95 that failed a p95 ≤ 9 gate
    expect(evaluate({ stat: "median", max: 8, tailMax: 12 }, m(5, 11), false).ok).toBe(true); // the tail stat defaults to p95
  });

  it("fail on the median alone, and on the tail alone, each by itself", () => {
    expect(evaluate(two, m(8.5, 9), false)).toMatchObject({ ok: false, failures: [{ stat: "median" }] });
    expect(evaluate(two, m(5, 12.5), false)).toMatchObject({ ok: false, failures: [{ stat: "p95" }] });
    expect(evaluate(two, m(9, 13), false).failures.map((l) => l.stat)).toEqual(["median", "p95"]);
  });

  it("fail when the stat of a limit is missing from the measurement", () => {
    expect(evaluate(two, { unit: "ms", median: 5 }, false)).toMatchObject({ ok: false, failures: [{ stat: "p95" }] });
  });

  it("in CI are the one ciStat/ciMax limit, with no tail guard; a row without ciMax keeps its local limits", () => {
    expect(limitsOf(two, true)).toEqual([{ stat: "median", max: 18 }]);
    expect(evaluate(two, m(17, 40), true).ok).toBe(true);
    expect(evaluate(two, m(19, 20), true).ok).toBe(false);
    expect(limitsOf({ stat: "p95", max: 9, ciMax: 20 }, true)).toEqual([{ stat: "p95", max: 20 }]);
    expect(limitsOf(single, true)).toEqual([{ stat: "p95", max: 9 }]);
  });

  it("let a row that is only reported pass whatever it measures", () => {
    expect(evaluate({ report: true }, m(1000, 1000), false).ok).toBe(true);
  });
});
