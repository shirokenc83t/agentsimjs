import { runLockstep, ScriptBrain, type Brain } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { createRun } from "../assemble/run.ts";
import { canonicalJson, hash32Hex } from "../canonical.ts";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import golden from "./f2-presets.golden.json";
import { f2DiscoveryScenario, f2PriorReferenceScenario, f2PriorRunConfig, f2RunConfig, f2TwentyAgentsScenario, F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID } from "./f2-presets.ts";

function start(doc: ReturnType<typeof f2DiscoveryScenario>, id: string, brains: Record<string, Brain> = {}) {
  const loaded = loadScenario(doc);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const resolved = resolveRunConfig(f2RunConfig(id, 1), { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
  return { ...createRun(loaded.value, resolved.value, trace, { dtS: 0.1, beliefVsTruth: {}, brains }), trace, resolved: resolved.value };
}

describe("F2 discovery preset", () => {
  it("has the F1 agents, the F1 world and a marker that no agent can see from where it starts", () => {
    const doc = f2DiscoveryScenario();
    expect(doc.agents.map((a) => a.key)).toEqual(["rover", "low", "scout"]);
    expect(doc.objects).toEqual([expect.objectContaining({ id: "marker-1", kind: "marker" })]);
    const run = start(doc, F2_DISCOVERY_ID);
    for (const a of run.agents) {
      const d = Math.hypot(56 - a.state.x, 8 - a.state.y);
      expect(d, a.id).toBeGreaterThan(40); // beyond a ground camera's 40 m; the UAV's 60 m camera also stays out of reach below
    }
  });

  it("starts every agent with an unknown map: the marker is not believed and most of the map is unknown", async () => {
    const run = start(f2DiscoveryScenario(), F2_DISCOVERY_ID);
    await runLockstep(run.world, run.scheduler, 5);
    const rover = run.agents.find((a) => a.key === "rover")?.id ?? "";
    expect(run.sensing.entities(rover).has("marker-1")).toBe(false);
    expect(run.observer?.report(rover, 5, 0.5).map?.unknownPct).toBeGreaterThan(50); // what the lidar has seen of a 64 m map in half a second is a fraction of it
  });

  it("a plan across the unknown wall is replanned when the lidar finds it, and the marker is detected on arrival", async () => {
    const script = new ScriptBrain("script-rover", [{ name: "goTo", params: { xM: 50, yM: 10 } }]);
    const run = start(f2DiscoveryScenario(), F2_DISCOVERY_ID, { rover: script });
    await runLockstep(run.world, run.scheduler, 1500);
    const rover = run.agents.find((a) => a.key === "rover")?.id ?? "";
    const plans = run.trace.all().filter((r) => r.agentId === rover && r.kind === "compute" && (r.payload as { op?: string }).op === "plan");
    expect(plans.length).toBeGreaterThanOrEqual(2); // the first plan crossed unknown space
    const ended = run.trace.all().filter((r) => r.agentId === rover && r.kind === "action" && (r.payload as { op?: string }).op === "end");
    expect(ended.at(-1)?.payload).toMatchObject({ status: "succeeded" });
    expect(run.sensing.entities(rover).get("marker-1")).toMatchObject({ kind: "marker", lost: false });
  }, 60000);
});

describe("F2 preset documents", () => {
  it("are stable: their content hashes match the golden (regenerate with tools/golden, and explain the change)", () => {
    expect(hash32Hex(canonicalJson(f2DiscoveryScenario()))).toBe(golden.discovery);
    expect(hash32Hex(canonicalJson(f2TwentyAgentsScenario()))).toBe(golden.agents20);
    expect(hash32Hex(canonicalJson(f2PriorReferenceScenario()))).toBe(golden.prior1km);
  });
});

describe("F2 prior map preset (1 km², stale survey)", () => {
  it("starts the rover from a survey that is right except in one square, and the scout from an unknown map", () => {
    const doc = f2PriorReferenceScenario();
    expect(doc.priors?.map((p) => p.id)).toEqual(["survey"]);
    const loaded = loadScenario(doc);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const resolved = resolveRunConfig(f2PriorRunConfig(1), { loaded: loaded.value, version: 1 });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const run = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1, beliefVsTruth: {} });
    const rover = run.agents.find((a) => a.key === "rover")?.id ?? "";
    const scout = run.agents.find((a) => a.key === "scout")?.id ?? "";
    const r = run.observer?.report(rover, 0, 0).map;
    expect(r?.unknownPct).toBeLessThan(1); // the whole map is known from tick 0
    expect((r?.phantomPct ?? 0) + (r?.falseFreePct ?? 0)).toBeGreaterThan(0); // and wrong in the swapped square
    expect(r?.falseFreeCells).toBeGreaterThan(0);
    expect(run.observer?.report(scout, 0, 0).map?.unknownPct).toBe(100);
  }, 60000);
});

describe("F2 20 agents preset", () => {
  it("has 20 ground vehicles with the default 180-ray, 10 Hz lidar and unknown maps", () => {
    const doc = f2TwentyAgentsScenario();
    expect(doc.agents).toHaveLength(20);
    const run = start(doc, F2_TWENTY_AGENTS_ID);
    const rays = run.resolved.agents.reduce((n, a) => n + (a.body as { sensors: readonly { type: string; rays?: number }[] }).sensors.filter((x) => x.type === "lidar").reduce((m, x) => m + (x.rays ?? 0), 0), 0);
    expect(rays).toBe(20 * 180);
  });
});
