import type { SimAgent } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { ScenarioDocument } from "../schema.ts";
import { assembleRun } from "./assemble.ts";

const DT = 0.1;

/** 64 × 64 m at 0.5 m; a wall at x ∈ [30, 31) for y < 50; a dead-end corridor (2 m wide) in the south-east. */
function scenario(): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "assemble",
    name: "Assemble",
    defaultSeed: 1,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [{ id: "base", kind: "base", rect: { x0: 2, y0: 2, x1: 8, y1: 8 } }],
    agents: [
      { kind: "ugv", key: "rover", start: { xM: 10, yM: 10 }, base: { xM: 5, yM: 5 } },
      { kind: "uav", key: "scout", start: { xM: 12, yM: 12 }, base: { xM: 5, yM: 5 } },
      { kind: "ugv", key: "trapped", start: { xM: 52, yM: 5, headingRad: 0 } },
    ],
  };
}

function build(runConfig: Partial<RunConfigDocument> = {}) {
  const doc = scenario();
  const grid = loadScenario(doc);
  if (!grid.ok) throw new Error(grid.error.message);
  const g = grid.value.grid;
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1); // wall x ∈ [30, 31), y < 50
  // Dead-end corridor around y = 5 from x = 40 to 63: walls at y < 4 and y ∈ [6, 10).
  for (let i = 80; i < 128; i++) {
    for (let j = 0; j < 8; j++) g.setCell("occupancy", i, j, 1);
    for (let j = 12; j < 20; j++) g.setCell("occupancy", i, j, 1);
  }
  // These check the F1 runtime on the true map: `ideal` agents (ADR-0028 addition of 2026-10-09).
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "assemble", version: 1 }, beliefs: { default: { init: "ideal" } }, ...runConfig }, { loaded: grid.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 100_000);
  return { ...assembleRun(grid.value, resolved.value, trace, { dtS: DT }), trace };
}

function agent(run: ReturnType<typeof build>, key: string): SimAgent {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
}

function runUntilIdle(run: ReturnType<typeof build>, a: SimAgent, from = 0, max = 20_000) {
  let t = from;
  for (; t < from + max; t++) {
    run.planner.advance(t);
    run.runtime.tick(a, t, t * DT);
    if (!run.runtime.isRunning(a.id)) break;
  }
  return { info: run.runtime.info(a.id), tick: t };
}

const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

describe("assembled runtime (core actions ↔ spatial, planning, tools-schema, trace)", () => {
  it("a UGV drives around a wall to its goal with the real planner, its own budget and traced records", () => {
    const run = build({ planning: { byAgent: { rover: { onboardComputeExpansionsPerTick: 500 } } } });
    const rover = agent(run, "rover");
    // A target closer to a wall than the footprint is rejected up front.
    expect(run.runtime.start(rover, "goTo", { xM: 50, yM: 10.2 }, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "target_blocked" } });
    expect(run.runtime.start(rover, "goTo", { xM: 50, yM: 20 }, self(rover), 0, 0).ok).toBe(true);
    const { info } = runUntilIdle(run, rover);
    expect(info?.failure).toBeUndefined();
    expect(info?.status).toBe("succeeded");
    const recs = run.trace.all().filter((r) => r.agentId === rover.id && r.kind === "action");
    expect(recs.every((r) => r.source === "ugv-001/actions")).toBe(true);
    const phases = recs.filter((r) => (r.payload as { op: string }).op === "phase");
    // Planning took several ticks at 500 expansions per tick (ADR-0024).
    expect(phases[0]?.simTime).toBeGreaterThan(DT);
  });

  it("validates with tools-schema: unknown capabilities, bad params and vehicle applicability", () => {
    const run = build();
    const rover = agent(run, "rover");
    expect(run.runtime.start(rover, "fly", {}, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "unknown_capability" } });
    expect(run.runtime.start(rover, "goTo", { xM: "50", yM: 10 }, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(run.runtime.start(rover, "goTo", { xM: 50, yM: 10, speed: 3 }, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(run.runtime.start(rover, "takeoff", { altitudeM: 10 }, self(rover), 0, 0)).toMatchObject({ ok: false, error: { code: "vehicle_unsupported" } });
  });

  it("a UAV takes off, flies over the wall at cruise altitude, and returns to base", () => {
    const run = build();
    const scout = agent(run, "scout");
    run.runtime.start(scout, "takeoff", { altitudeM: 20 }, self(scout), 0, 0);
    let t = runUntilIdle(run, scout).tick + 1;
    expect(run.runtime.start(scout, "goTo", { xM: 50, yM: 20 }, self(scout), t, t * DT).ok).toBe(true);
    const flight = runUntilIdle(run, scout, t);
    expect(flight.info?.status).toBe("succeeded");
    t = flight.tick + 1;
    run.runtime.start(scout, "returnToBase", {}, self(scout), t, t * DT);
    expect(runUntilIdle(run, scout, t).info).toMatchObject({ status: "succeeded", result: { landed: true } });
  });

  it("a goal behind a UGV in a 2 m dead end: forward-only fails kinematically_infeasible; differential turns in place and arrives", () => {
    // Drive model chosen by the run configuration's drive section (ADR-0033).
    const forwardOnly = build({ drive: { byAgent: { trapped: { drive: "forward-only" } } } });
    const t1 = agent(forwardOnly, "trapped");
    forwardOnly.runtime.start(t1, "goTo", { xM: 42, yM: 5 }, self(t1), 0, 0);
    expect(runUntilIdle(forwardOnly, t1).info?.failure?.code).toBe("kinematically_infeasible");
    expect(t1.state.x).toBe(52);

    const differential = build();
    const t2 = agent(differential, "trapped");
    expect(t2.kind === "ugv" && t2.body.drive).toBe("differential");
    differential.runtime.start(t2, "goTo", { xM: 42, yM: 5 }, self(t2), 0, 0);
    expect(runUntilIdle(differential, t2).info?.status).toBe("succeeded");
  });
});
