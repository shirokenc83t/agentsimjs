import { runLockstep, ScriptBrain, type SimAgent } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { ScenarioDocument } from "../schema.ts";
import { watchTruth } from "../testing/truth-watch.ts";
import { assembleRun } from "./assemble.ts";
import { createRun } from "./run.ts";

/**
 * F2 audit of action start checks (2026-10-10): every start-time check, precondition and failure code a mind can
 * receive uses the agent's own map. Physical outcomes (collision, touchdown) may read ground truth when they happen.
 */

/** 64 × 64 m at 0.5 m; ground truth: a wall at x ∈ [30, 31) for y < 50, and a 20 m tower at (20, 20). */
function scenario(): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "starts",
    name: "Starts",
    defaultSeed: 4,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [{ id: "base", kind: "base", rect: { x0: 2, y0: 2, x1: 8, y1: 8 } }],
    agents: [
      { kind: "ugv", key: "rover", start: { xM: 10, yM: 10 } },
      { kind: "uav", key: "scout", start: { xM: 20.2, yM: 20.2, zM: 30 }, base: { xM: 5, yM: 5 } },
      { kind: "uav", key: "grounded", start: { xM: 40, yM: 40 } },
    ],
  };
}

function load(): { l: LoadedScenario } {
  const l = loadScenario(scenario());
  if (!l.ok) throw new Error(l.error.message);
  const g = l.value.grid;
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1);
  g.setCell("occupancy", 40, 40, 1);
  g.setCell("heightDm", 40, 40, 200);
  return { l: l.value };
}

function resolved(l: LoadedScenario, ideal: boolean) {
  const r = resolveRunConfig({ schemaVersion: 0, scenario: { id: "starts", version: 1 }, beliefs: { default: { init: ideal ? "ideal" : "unknown" } } }, { loaded: l, version: 1 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const agent = (agents: readonly SimAgent[], key: string) => {
  const a = agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
};
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

describe("action start checks use the agent's own map (F2 audit)", () => {
  it("for belief agents, starting goTo, takeoff, land and returnToBase reads no ground truth", () => {
    const { l } = load();
    const run = assembleRun(l, resolved(l, false), new TraceBuffer("run-000001", () => 0, 10_000), { dtS: 0.1 });
    const truth = watchTruth(l);
    const rover = agent(run.agents, "rover");
    const scout = agent(run.agents, "scout");
    const grounded = agent(run.agents, "grounded");
    const results = truth.during(() => [
      run.runtime.start(rover, "goTo", { xM: 30.5, yM: 10 }, self(rover), 0, 0), // onto the unseen wall
      run.runtime.start(scout, "goTo", { xM: 20.2, yM: 20.2, altitudeM: 10 }, self(scout), 0, 0),
      run.runtime.start(grounded, "takeoff", { altitudeM: 10 }, self(grounded), 0, 0), // into the unseen tower
      run.runtime.start(scout, "land", {}, self(scout), 0, 0),
      run.runtime.start(scout, "returnToBase", {}, self(scout), 0, 0),
    ]);
    expect(truth.hits).toEqual([]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
  });

  it("ideal agents decide on the ground truth, as before: the same starts are refused with their codes", () => {
    const { l } = load();
    const run = assembleRun(l, resolved(l, true), new TraceBuffer("run-000001", () => 0, 10_000), { dtS: 0.1 });
    const rover = agent(run.agents, "rover");
    const scout = agent(run.agents, "scout"); // hovering at 30 m above the 20 m tower
    expect(run.runtime.start(rover, "goTo", { xM: 30.5, yM: 10 }, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "target_blocked" } });
    expect(run.runtime.start(scout, "goTo", { xM: 20.2, yM: 20.2, altitudeM: 10 }, self(scout), 0, 0)).toMatchObject({ ok: false, error: { code: "target_blocked" } });
    expect(run.runtime.start(scout, "land", {}, self(scout), 0, 0)).toMatchObject({ ok: false, error: { code: "landing_blocked" } });
  });

  it("a belief UAV landing onto a tower it has not seen starts, then collides when it touches it (physics, ground truth)", () => {
    const { l } = load();
    const trace = new TraceBuffer("run-000001", () => 0, 10_000);
    const run = assembleRun(l, resolved(l, false), trace, { dtS: 0.1 });
    const scout = agent(run.agents, "scout");
    expect(run.runtime.start(scout, "land", {}, self(scout), 0, 0).ok).toBe(true);
    let t = 0;
    for (; t < 400 && run.runtime.isRunning(scout.id); t++) run.runtime.tick(scout, t, t * 0.1);
    expect(run.runtime.info(scout.id)?.failure?.code).toBe("collision");
    expect(scout.kind === "uav" && scout.state.z).toBeGreaterThanOrEqual(20); // stopped on top of the tower, not inside it
    expect(trace.all().some((r) => r.kind === "event" && (r.payload as { op?: string }).op === "collision")).toBe(true);
  });

  it("a belief UGV sent onto an unseen wall plans optimistically, discovers the wall and fails later with a belief-based reason", async () => {
    const { l } = load();
    const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
    const run = createRun(l, resolved(l, false), trace, { dtS: 0.1, brains: { rover: new ScriptBrain("script-rover", [{ name: "goTo", params: { xM: 30.5, yM: 10 } }]) } });
    const rover = agent(run.agents, "rover");
    await runLockstep(run.world, run.scheduler, 600);
    const end = trace
      .all()
      .filter((r) => r.agentId === rover.id && r.kind === "action")
      .map((r) => r.payload as { op?: string; status?: string; failure?: { code?: string } })
      .find((p) => p.op === "end");
    expect(end?.status).toBe("failed");
    // Not a collision and not refused at start: the wall was discovered by its lidar, then the goal judged on beliefs.
    expect(["unreachable", "target_blocked", "kinematically_infeasible"]).toContain(end?.failure?.code);
  });
});
