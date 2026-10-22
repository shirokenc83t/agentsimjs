import { Scheduler } from "@agentsim/core";
import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { isRegisteredSample, METRIC_REGISTRY, type MetricSample } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { profileOf, setup } from "./run-recording-harness.ts";

// F3b M2 (ADR-0035 section 4 and its addition of 2026-10-17, item 4): the metrics channel of a recorded run. Metrics are observer data: they are read between ticks, after the
// tick's state hash, change nothing, and are not reachable from a decision request.

const samplesOf = (items: ReturnType<typeof setup>["items"]): MetricSample[] => items.flatMap((i) => (i.type === "metrics" ? [...i.samples] : []));
const names = (s: readonly MetricSample[]) => [...new Set(s.map((x) => x.name))].sort();

describe("the metrics channel of a recorded run", () => {
  it("samples registered series at the profile's rate (1 Hz: the first tick, then every 10), one sample per series per interval, with the aggregation of its definition", () => {
    const t = setup();
    t.explore();
    t.step(35);
    const s = samplesOf(t.items);
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(isRegisteredSample(x), `${x.name} from ${x.source}`).toBe(true);
    const world = s.filter((x) => x.source === "world/sim");
    expect([...new Set(world.filter((x) => x.name === "sim.tickMs").map((x) => x.tick))]).toEqual([1, 10, 20, 30]);
    // One sample per series and tick.
    const keys = s.map((x) => `${x.source}|${x.name}|${x.tick}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Every agent has its body series, the world its sim and storage series.
    for (const id of t.world.entityIds) {
      expect(s.filter((x) => x.source === `${id}/body` && x.name === "agent.soc").length, id).toBe(4);
      expect(s.filter((x) => x.source === `${id}/body` && x.name === "agent.speedMps").length, id).toBe(4);
    }
    expect(names(world)).toEqual(["sim.otherPhasesMs", "sim.planBudgetUse", "sim.planExpansions", "sim.senseMs", "sim.tickBudgetUse", "sim.tickMs"]);
    expect(names(s.filter((x) => x.source === "world/storage"))).toEqual(["storage.backlogBytes", "storage.backlogRecords"]);
    // The battery is a state: the sample is its value at the tick, not an average.
    const soc = s.filter((x) => x.source === `${t.driver}/body` && x.name === "agent.soc");
    expect(soc.every((x) => x.value >= 0 && x.value <= 1)).toBe(true);
    // The wall times are real and the ratio is time over the tick's budget (the step is 100 ms).
    const tickMs = world.filter((x) => x.name === "sim.tickMs");
    const use = world.filter((x) => x.name === "sim.tickBudgetUse");
    expect(tickMs.every((x) => x.value >= 0)).toBe(true);
    expect(use.every((x, i) => x.value >= (tickMs[i]?.value ?? 0) / 100 - 1e-9)).toBe(true); // max over the interval ≥ mean / budget
  });

  it("follows the profile's rate: debug-full samples at 10 Hz, one per tick", () => {
    const t = setup(profileOf("debug-full"));
    t.step(5);
    const ticks = [...new Set(samplesOf(t.items).filter((x) => x.name === "sim.tickMs").map((x) => x.tick))];
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
  });

  it("carries the observer's belief error as its own series, one sample per report, labelled as observer data in the registry", () => {
    const t = setup();
    t.explore();
    t.step(130); // the observer reports each agent once every 10 s, its phases spread over the interval
    const s = samplesOf(t.items);
    const belief = s.filter((x) => x.name.startsWith("belief."));
    expect(belief.length).toBeGreaterThan(0);
    for (const x of belief) expect(x.source).toMatch(/\/beliefs$/);
    for (const d of METRIC_REGISTRY.filter((x) => x.name.startsWith("belief."))) expect(d.observer).toBe(true);
    // Each sample is the report's value, at the tick the report was traced.
    const reports = t.records().filter((r) => (r.payload as { op?: string } | undefined)?.op === "belief-vs-truth");
    expect(reports.length).toBeGreaterThan(0);
    const unknown = belief.filter((x) => x.name === "belief.unknownPct");
    for (const r of reports) {
      const p = r.payload as { map?: { unknownPct: number } };
      if (p.map === undefined) continue;
      const hit = unknown.find((x) => x.source === `${r.agentId}/beliefs` && Math.abs(x.simTime - r.simTime) < 1e-9);
      expect(hit?.value, `${r.agentId} at ${r.simTime}`).toBe(p.map.unknownPct);
    }
  });

  it("changes nothing in the run: the state hash of every tick is the one of a run that is not recorded", () => {
    const plain = ScenarioHostedWorld.load({ runId: "run-000001", scenario: f2DiscoveryScenario(), scenarioVersion: 1, runConfig: f2RunConfig(F2_DISCOVERY_ID, 1) }, () => 0);
    if (!plain.ok) throw new Error("load");
    const t = setup(profileOf("debug-full"));
    const ps = new Scheduler(plain.value, plain.value.dtS);
    t.explore();
    plain.value.inject({ agentId: t.driver, name: "explore", params: {} });
    for (let i = 0; i < 60; i++) {
      ps.step();
      t.step(1);
      expect(t.world.stateHash, `tick ${i + 1}`).toBe(plain.value.stateHash);
    }
    expect(samplesOf(t.items).length).toBeGreaterThan(60);
  });

  it("no metric value is reachable from a decision request: the requests the minds get, with metrics being recorded, hold no metric name or value", () => {
    const t = setup(profileOf("debug-full"));
    t.explore();
    const seen: string[] = [];
    for (let i = 0; i < 120; i++) {
      t.step(1);
      for (const id of t.world.entityIds) {
        const v = t.world.mindView(id);
        if (v) seen.push(v.request);
      }
    }
    expect(seen.length).toBeGreaterThan(100);
    const metricNames = METRIC_REGISTRY.map((d) => d.name.replace(/\./g, "\\."));
    const re = new RegExp(`${metricNames.join("|")}|tickBudgetUse|planBudgetUse|backlogRecords|backlogBytes|unknownPct|falseFreePct|entityMeanErrM|observer`);
    for (const r of seen) expect(r).not.toMatch(re);
    // Positive control: the samples exist, and the scan would catch one of their names.
    expect(samplesOf(t.items).length).toBeGreaterThan(100);
    expect(JSON.stringify({ sim: { tickMs: 1 }, n: "sim.tickMs" })).toMatch(re);
  });
});
