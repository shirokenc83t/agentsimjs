import type { GridSpace } from "@agentsim/spatial";
import { scenarioFromGrid } from "../encode.ts";
import { loadScenario } from "../load.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { AgentSpec, ScenarioDocument, ZoneSpec } from "../schema.ts";

export const F1_DEMO_ID = "f1-demo";

/**
 * Obstacles of the F1 demo and reference worlds (64 × 64 m at 0.5 m):
 * - a wall at x ∈ [30, 31) for y < 50, so x = 50 is "behind obstacles" for an agent starting at x = 10;
 * - a closed box x ∈ [45, 55), y ∈ [35, 55), walls 1 m thick, whose inside is unreachable;
 * - a marsh x ∈ [14, 22), y ∈ [0, 16) of high terrain cost (200; nominal 10): a distance-only profile crosses
 *   it, a profile that weighs terrain goes around its north end (F1 acceptance: changing the cost profile
 *   changes the path).
 */
export function paintF1Obstacles(g: GridSpace): void {
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1);
  for (let i = 90; i < 110; i++) for (const j of [70, 71, 108, 109]) g.setCell("occupancy", i, j, 1);
  for (let j = 70; j < 110; j++) for (const i of [90, 91, 108, 109]) g.setCell("occupancy", i, j, 1);
  for (let j = 0; j < 32; j++) for (let i = 28; i < 44; i++) g.setCell("terrainCost", i, j, MARSH_TERRAIN_COST);
}

/** Terrain cost of the demo's marsh (the nominal code is 10). */
export const MARSH_TERRAIN_COST = 200;

const ZONES: readonly ZoneSpec[] = [{ id: "base", kind: "base", rect: { x0: 2, y0: 2, x1: 8, y1: 8 } }];

/**
 * Agents of the demo: `rover` (UGV), `low` (UGV starting just above its critical battery level, to show the
 * battery reflex) and `scout` (UAV).
 */
const AGENTS: readonly AgentSpec[] = [
  { kind: "ugv", key: "rover", start: { xM: 10, yM: 10 }, base: { xM: 5, yM: 5 } },
  { kind: "ugv", key: "low", start: { xM: 10, yM: 20 }, base: { xM: 5, yM: 5 }, body: { battery: { capacityWh: 10, initialSoc: 0.17, criticalSoc: 0.15 } } },
  { kind: "uav", key: "scout", start: { xM: 12, yM: 12 }, base: { xM: 5, yM: 5 } },
];

function emptyDocument(id: string, name: string): ScenarioDocument {
  return {
    schemaVersion: 0,
    id,
    name,
    defaultSeed: 1,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [...ZONES],
    agents: [...AGENTS],
  };
}

/** The F1 demo layout without painted layers (the reference run paints the grid after loading). */
export function f1EmptyDocument(id: string, name: string): ScenarioDocument {
  return emptyDocument(id, name);
}

/** The F1 demo scenario as a complete document (layers encoded), as the lab loads and stores it. */
export function f1DemoScenario(): ScenarioDocument {
  const base = emptyDocument(F1_DEMO_ID, "F1 demo");
  const loaded = loadScenario(base);
  if (!loaded.ok) throw new Error(`F1 demo scenario: ${loaded.error.message}`);
  paintF1Obstacles(loaded.value.grid);
  return scenarioFromGrid({ id: base.id, name: base.name, defaultSeed: base.defaultSeed }, loaded.value.grid, base.zones, base.agents);
}

/**
 * Default run configuration of a stored demo version: built-in planning, the scenario's seed, lockstep. Agents
 * are `ideal` (ADR-0028 addition of 2026-10-09): the F1 demo keeps showing planning, cost profiles and battery on
 * the map it was designed for.
 */
export function f1DemoRunConfig(scenarioVersion: number): RunConfigDocument {
  return { schemaVersion: 0, scenario: { id: F1_DEMO_ID, version: scenarioVersion }, beliefs: { default: { init: "ideal" } } };
}
