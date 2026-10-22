import { describe, expect, it } from "vitest";
import { isRegisteredSample, METRIC_NAME_PATTERN, METRIC_REGISTRY, metricDef, MetricSampler, metricSource } from "./metrics.ts";
import { COMPONENTS_BY_OWNER, parseSource } from "./source.ts";

describe("the metric registry", () => {
  it("names are unique and well formed, and every series has a source its owner kind allows", () => {
    const names = METRIC_REGISTRY.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of METRIC_REGISTRY) {
      expect(d.name).toMatch(METRIC_NAME_PATTERN);
      const source = metricSource(d, d.owner === "agent" ? "uav-001" : undefined);
      expect(parseSource(source), source).toBeDefined();
      expect(COMPONENTS_BY_OWNER[d.owner === "agent" ? "agent" : "world"]).toContain(d.component);
    }
  });

  it("registers no mind or protocol metric before the data exists, and marks the belief error as observer data", () => {
    expect(METRIC_REGISTRY.filter((d) => /^(mind|protocol)\./.test(d.name))).toEqual([]);
    for (const d of METRIC_REGISTRY.filter((x) => x.name.startsWith("belief."))) expect(d.observer).toBe(true);
    for (const d of METRIC_REGISTRY.filter((x) => !x.name.startsWith("belief."))) expect(d.observer).toBe(false);
  });

  it("a sample is registered only with the name and the source trusted code gives it", () => {
    expect(isRegisteredSample({ name: "agent.soc", source: "uav-001/body" })).toBe(true);
    expect(isRegisteredSample({ name: "agent.soc", source: "uav-001/planner" })).toBe(false);
    expect(isRegisteredSample({ name: "agent.soc", source: "world/sim" })).toBe(false);
    expect(isRegisteredSample({ name: "sim.nope", source: "world/sim" })).toBe(false);
    expect(isRegisteredSample({ name: "sim.tickMs", source: "bogus" })).toBe(false);
    expect(() => metricSource(metricDef("agent.soc")!)).toThrow();
  });
});

describe("MetricSampler", () => {
  const def = (n: string) => metricDef(n)!;

  it("folds the observations of an interval by the metric's aggregation, and starts the next interval empty", () => {
    const s = new MetricSampler(1);
    expect(s.due(0)).toBe(true);
    for (const v of [1, 2, 6]) {
      s.observe(def("sim.tickMs"), "world/sim", v); // mean
      s.observe(def("sim.tickBudgetUse"), "world/sim", v); // max
      s.observe(def("agent.soc"), "uav-001/body", v); // last
    }
    const a = s.take(2, 0.2);
    expect(a.map((x) => [x.source, x.name, x.value])).toEqual([
      ["uav-001/body", "agent.soc", 6],
      ["world/sim", "sim.tickBudgetUse", 6],
      ["world/sim", "sim.tickMs", 3],
    ]);
    expect(s.due(0.5)).toBe(false);
    expect(s.due(1)).toBe(true);
    s.observe(def("sim.tickMs"), "world/sim", 10);
    expect(s.take(10, 1).map((x) => [x.name, x.value])).toEqual([["sim.tickMs", 10]]);
  });

  it("ignores non-finite values and gives nothing for a series with no observation", () => {
    const s = new MetricSampler(2);
    s.observe(def("sim.tickMs"), "world/sim", Number.NaN);
    s.observe(def("sim.tickMs"), "world/sim", Number.POSITIVE_INFINITY);
    expect(s.take(1, 0.1)).toEqual([]);
  });

  it("does not sample the observer's series on the clock: they are one sample per report", () => {
    const s = new MetricSampler(1);
    s.observe(def("belief.unknownPct"), "uav-001/beliefs", 40);
    expect(s.take(1, 0.1)).toEqual([]);
  });
});
