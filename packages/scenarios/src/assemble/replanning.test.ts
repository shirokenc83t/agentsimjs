import { runLockstep, ScriptBrain } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { ScenarioDocument } from "../schema.ts";
import { assembleRun } from "./assemble.ts";
import { createRun } from "./run.ts";

/** 64 × 64 m at 0.5 m; ground truth has a wall at x ∈ [30, 31) for y < 50. */
function scenario(lidarRangeM?: number): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "replanning",
    name: "Replanning",
    defaultSeed: 2,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [],
    agents: [{ kind: "ugv", key: "rover", start: { xM: 10, yM: 10 }, ...(lidarRangeM === undefined ? {} : { body: { sensors: [{ id: "lidar", type: "lidar", rangeM: lidarRangeM }] } }) }],
  };
}

function loaded(lidarRangeM?: number) {
  const l = loadScenario(scenario(lidarRangeM));
  if (!l.ok) throw new Error(l.error.message);
  const g = l.value.grid;
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1);
  const r = resolveRunConfig({ schemaVersion: 0, scenario: { id: "replanning", version: 1 } }, { loaded: l.value, version: 1 });
  if (!r.ok) throw new Error(r.error.message);
  return { l: l.value, r: r.value };
}

describe("replanning on live belief views (ADR-0024 additions of 2026-10-09 and 2026-10-10)", () => {
  it("a plan's map is the agent's current planning view: an obstacle believed after planning shows in it", () => {
    const { l, r } = loaded();
    const run = assembleRun(l, r, new TraceBuffer("run-000001", () => 0, 10_000), { dtS: 0.1 });
    const rover = run.agents[0];
    if (!rover) throw new Error("rover");
    const q = run.planner.submit(rover.id, { from: { x: 10, y: 10 }, to: { x: 25, y: 10 } }, 0);
    if (!q.ok) throw new Error(q.error.message);
    let plan;
    for (let t = 0; t < 100 && !plan; t++) {
      run.planner.advance(t);
      plan = run.planner.take(rover.id, q.value);
    }
    if (!plan) throw new Error("no plan");
    expect(plan.map.clearanceM(18, 10, 2)).toBe(2); // nothing believed there yet
    // The rover now believes in an obstacle on its path (e.g. sensed after planning); the next sync point applies it.
    const b = run.sensing.belief(rover.id);
    for (let k = 0; k < 2; k++) b.observeHit(36, 20, 0, 40); // cell (36, 20) = (18 m, 10 m)
    run.planner.syncViews();
    expect(plan.map.clearanceM(18.25, 10.25, 2)).toBe(0);
    expect(plan.map.version).toBe(run.planner.currentMap(rover.id).version);
  });

  it("F2 acceptance: a goal behind an initially unknown wall — the plan crosses unknown cells, lidar reveals the wall, goTo replans and succeeds", async () => {
    const { l, r } = loaded(8); // an 8 m lidar: the wall is seen only on approach
    const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
    const run = createRun(l, r, trace, { dtS: 0.1, brains: { rover: new ScriptBrain("script-rover", [{ name: "goTo", params: { xM: 50, yM: 10 } }]) } });
    const rover = run.agents[0];
    if (!rover) throw new Error("rover");
    for (let t = 0; t < 3000; t++) await runLockstep(run.world, run.scheduler, 1);
    const recs = trace.all().filter((x) => x.agentId === rover.id);
    const notes = recs.filter((x) => x.kind === "action").map((x) => x.payload as { op?: string; reason?: string; status?: string });
    const plans = recs.filter((x) => x.kind === "compute" && (x.payload as { op?: string }).op === "plan").map((x) => x.payload as { waypoints: [number, number][] });
    // The first plan went straight through the wall the rover had not seen.
    expect(Math.max(...(plans[0]?.waypoints ?? []).map(([, y]) => y))).toBeLessThan(15);
    expect(notes.some((n) => n.op === "replan" && n.reason === "map_changed")).toBe(true);
    // A later plan goes around the wall's end (y ≥ 50).
    expect(plans.some((p) => p.waypoints.some(([, y]) => y >= 50))).toBe(true);
    expect(notes.filter((n) => n.op === "end").map((n) => n.status)).toEqual(["succeeded"]);
    expect(Math.abs(rover.state.x - 50) + Math.abs(rover.state.y - 10)).toBeLessThan(1);
  });
});
