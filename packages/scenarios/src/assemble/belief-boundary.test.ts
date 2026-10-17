import type { PlanResult } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { ScenarioDocument } from "../schema.ts";
import { assembleRun } from "./assemble.ts";

/**
 * Architecture test (F2 M2b, ADR-0005 and the ADR-0028 addition of 2026-10-09): only `ideal` agents' planning
 * reaches the ground-truth grid. Every method and getter of the ground-truth grid and its layers is
 * instrumented; planning a belief agent's query, and checking its map, must not call any of them.
 */

/** 64 × 64 m at 0.5 m; ground truth has a wall at x ∈ [30, 31) for y < 50, which no agent has observed. */
function scenario(): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "boundary",
    name: "Boundary",
    defaultSeed: 1,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [],
    agents: [
      { kind: "ugv", key: "believer", start: { xM: 10, yM: 10 } },
      { kind: "ugv", key: "oracle", start: { xM: 10, yM: 12 } },
    ],
  };
}

/** Counts calls to every prototype method and getter of `obj`, on the instance, while `on()` is true. */
function instrument(obj: object, on: () => boolean, hits: string[], label: string): void {
  const proto = Object.getPrototypeOf(obj) as object;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d) continue;
    if (typeof d.value === "function") {
      const f = d.value as (...args: unknown[]) => unknown;
      Object.defineProperty(obj, name, {
        configurable: true,
        value: function (this: unknown, ...args: unknown[]) {
          if (on()) hits.push(`${label}.${name}`);
          return f.apply(this, args);
        },
      });
    } else if (d.get) {
      const g = d.get;
      Object.defineProperty(obj, name, {
        configurable: true,
        get: function (this: unknown) {
          if (on()) hits.push(`${label}.${name}`);
          return g.call(this);
        },
      });
    }
  }
}

function build() {
  const loaded = loadScenario(scenario());
  if (!loaded.ok) throw new Error(loaded.error.message);
  const g = loaded.value.grid;
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1);
  const resolved = resolveRunConfig(
    { schemaVersion: 0, scenario: { id: "boundary", version: 1 }, beliefs: { byAgent: { oracle: { init: "ideal" } } } },
    { loaded: loaded.value, version: 1 },
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  const run = assembleRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 10_000), { dtS: 0.1 });
  return { run, loaded: loaded.value };
}

function idOf(run: ReturnType<typeof build>["run"], key: string): string {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a.id;
}

/** Plans (10, y) → (50, y) to completion and returns the result. */
function planAcross(run: ReturnType<typeof build>["run"], agentId: string, y: number): PlanResult {
  const q = run.planner.submit(agentId, { from: { x: 10, y }, to: { x: 50, y } }, 0);
  if (!q.ok) throw new Error(q.error.message);
  for (let t = 0; t < 1000; t++) {
    run.planner.advance(t);
    const r = run.planner.take(agentId, q.value);
    if (r) return r;
  }
  throw new Error("plan did not complete");
}

function watchTruth(loaded: LoadedScenario) {
  let on = false;
  const hits: string[] = [];
  const g = loaded.grid;
  instrument(g, () => on, hits, "grid");
  for (const name of ["occupancy", "terrainCost", "heightDm"] as const) instrument(g[name], () => on, hits, name);
  return {
    hits,
    during<T>(f: () => T): T {
      on = true;
      try {
        return f();
      } finally {
        on = false;
      }
    },
  };
}

describe("belief boundary: only ideal agents' planning reads the ground truth (F2 M2b)", () => {
  it("a belief agent's query and map checks never touch the ground-truth grid; its plan ignores the wall it has not seen", () => {
    const { run, loaded } = build();
    const truth = watchTruth(loaded);
    const believer = idOf(run, "believer");
    const result = truth.during(() => {
      const r = planAcross(run, believer, 10);
      const map = run.planner.currentMap(believer);
      // Next to the true wall: the belief map knows nothing there, so the clearance is the cap.
      expect(map.clearanceM(29.8, 10, 2)).toBe(2);
      r.map.clearanceM(29.8, 10, 2);
      return r;
    });
    expect(truth.hits).toEqual([]);
    expect(result.status).toBe("found");
    expect(Math.max(...result.waypoints.map(([, y]) => y))).toBeLessThan(15); // straight through the unseen wall
  });

  it("an ideal agent's query does read the ground truth, and goes around the wall (the instrumentation works)", () => {
    const { run, loaded } = build();
    const truth = watchTruth(loaded);
    const oracle = idOf(run, "oracle");
    const result = truth.during(() => planAcross(run, oracle, 12));
    expect(truth.hits.length).toBeGreaterThan(0);
    expect(result.status).toBe("found");
    expect(Math.max(...result.waypoints.map(([, y]) => y))).toBeGreaterThan(50);
    expect(run.planner.currentMap(oracle).clearanceM(29.8, 12, 2)).toBeLessThan(0.5);
  });

  it("the assembled planner holds belief agents' maps, each built without a reference to the ground-truth grid", () => {
    const { run, loaded } = build();
    const believer = idOf(run, "believer");
    const seen = new Set<unknown>();
    const reaches = (v: unknown, depth: number): boolean => {
      if (v === loaded.grid) return true;
      if (typeof v !== "object" || v === null || depth === 0 || seen.has(v) || ArrayBuffer.isView(v)) return false;
      seen.add(v);
      return Object.values(v).some((x) => reaches(x, depth - 1));
    };
    const grids = (run.planner as unknown as { beliefGrids: ReadonlyMap<string, unknown> }).beliefGrids;
    expect(grids.has(believer)).toBe(true);
    expect(grids.has(idOf(run, "oracle"))).toBe(false);
    expect(reaches(grids.get(believer), 6)).toBe(false);
  });
});
