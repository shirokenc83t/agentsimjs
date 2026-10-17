import { buildReferenceWorld, REFERENCE_WORLD_SEED } from "@agentsim/spatial";
import { scenarioFromGrid } from "../encode.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { AgentSpec, ScenarioDocument } from "../schema.ts";

export const F1_REFERENCE_WORLD_ID = "f1-reference-1km";

/**
 * A rover and a scout in the south-west corner; a cross-map goTo exercises HPA* (ROADMAP F1). No zones, hence no
 * bases (a base must lie in a base zone): zones are part of the grid hash, and this grid is exactly the
 * benchmarks' world. The return-to-base acceptance is shown on the F1 demo.
 */
const AGENTS: readonly AgentSpec[] = [
  { kind: "ugv", key: "rover", start: { xM: 5, yM: 5 } },
  // Airborne at 20 m, so a goTo (sent from the Scene) can fly at once: a grounded UAV needs a takeoff first.
  { kind: "uav", key: "scout", start: { xM: 6, yM: 4, zM: 20 } },
];

/**
 * The 1 km² / 0.5 m reference world (2000 × 2000 cells) as a scenario document: the grid of
 * `buildReferenceWorld()`, which the planning, spatial and scenario benchmarks use, so the lab shows and runs the
 * benchmarked world. About 290 KiB as pretty JSON. The lab builds it in the sim worker, never on the main thread.
 */
export function f1ReferenceWorldScenario(): ScenarioDocument {
  return scenarioFromGrid(
    { id: F1_REFERENCE_WORLD_ID, name: "F1 reference world (1 km², 0.5 m)", defaultSeed: REFERENCE_WORLD_SEED },
    buildReferenceWorld(),
    [],
    AGENTS,
  );
}

/** Default run configuration of a stored version of the reference world: `ideal` agents, as in F1 (ADR-0028 addition). */
export function f1ReferenceWorldRunConfig(scenarioVersion: number): RunConfigDocument {
  return { schemaVersion: 0, scenario: { id: F1_REFERENCE_WORLD_ID, version: scenarioVersion }, beliefs: { default: { init: "ideal" } } };
}
