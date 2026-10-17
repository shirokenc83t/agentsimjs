import { runLockstep, ScriptBrain } from "@agentsim/core";
import { BELIEF_OCCUPIED } from "@agentsim/spatial";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { ScenarioDocument } from "../schema.ts";
import { createRun } from "./run.ts";

/** 64 × 64 m at 0.5 m; a 12 m building at x, y ∈ [27, 37). */
function scenario(): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "two-and-a-half",
    name: "2.5D",
    defaultSeed: 5,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [],
    agents: [{ kind: "uav", key: "scout", start: { xM: 5, yM: 32 } }],
  };
}

const inBuilding = (x: number, y: number) => x >= 27 && x < 37 && y >= 27 && y < 37;

describe("2.5D on belief maps in a full run (ADR-0012 addition of 2026-10-09, F2 M2b)", () => {
  it("a UAV that flew over a 12 m building at 30 m believes it; flying back at 5 m it goes around it", async () => {
    const loaded = loadScenario(scenario());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const g = loaded.value.grid;
    for (let j = 54; j < 74; j++) {
      for (let i = 54; i < 74; i++) {
        g.setCell("occupancy", i, j, 1);
        g.setCell("heightDm", i, j, 120);
      }
    }
    // Unknown beliefs: the scout starts knowing nothing of the building.
    const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "two-and-a-half", version: 1 } }, { loaded: loaded.value, version: 1 });
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.agents[0]?.beliefs.init).toBe("unknown");
    const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
    const run = createRun(loaded.value, resolved.value, trace, {
      dtS: 0.1,
      brains: {
        scout: new ScriptBrain("script-scout", [
          { name: "takeoff", params: { altitudeM: 30 } },
          { name: "goTo", params: { xM: 55, yM: 32 } },
          { name: "goTo", params: { xM: 5, yM: 32, altitudeM: 5 } },
        ]),
      },
    });
    const scout = run.agents[0];
    if (!scout || scout.kind !== "uav") throw new Error("scout");
    let overAt30 = false;
    let insideLow = false;
    for (let t = 0; t < 3000; t++) {
      await runLockstep(run.world, run.scheduler, 1);
      const s = scout.state;
      if (inBuilding(s.x, s.y) && s.z >= 29) overAt30 = true;
      if (inBuilding(s.x, s.y) && s.z < 13) insideLow = true;
    }
    const actions = trace.all().filter((r) => r.agentId === scout.id && r.kind === "action" && (r.payload as { op?: string }).op === "end");
    expect(actions.map((r) => (r.payload as { status?: string }).status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(overAt30).toBe(true); // the outbound leg crossed the building at 30 m
    expect(insideLow).toBe(false); // the return leg at 5 m went around it
    expect(trace.all().some((r) => r.agentId === scout.id && r.kind === "event" && (r.payload as { op?: string }).op === "collision")).toBe(false);
    // What it believes: the building is occupied, its top bounded below the beam's lower edge at 30 m.
    const b = run.sensing.belief(scout.id);
    expect(b.state(64, 64)).toBe(BELIEF_OCCUPIED);
    expect(b.knownMaxM(64, 64)).toBeLessThanOrEqual(30);
    expect(Math.abs(scout.state.x - 5) + Math.abs(scout.state.y - 32)).toBeLessThan(1);
  });
});
