import { buildReferenceWorld, GridSpace, REFERENCE_WORLD_SEED } from "@agentsim/spatial";
import { encodeLayer, scenarioFromGrid } from "../encode.ts";
import { loadScenario } from "../load.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { AgentSpec, ObjectSpec, ScenarioDocument } from "../schema.ts";
import { f1EmptyDocument, paintF1Obstacles } from "./f1-demo.ts";

export const F2_DISCOVERY_ID = "f2-discovery";
export const F2_TWENTY_AGENTS_ID = "f2-20-agents";
export const F2_PRIOR_REFERENCE_ID = "f2-prior-1km";

/**
 * Objects of the F2 discovery demo: a marker 46 m from the rover's start, beyond its camera range (40 m for a ground
 * vehicle) and behind the wall, so it is not in anyone's beliefs until an agent approaches (F2 acceptance).
 */
const DISCOVERY_OBJECTS: readonly ObjectSpec[] = [{ id: "marker-1", kind: "marker", label: "Marker", position: { xM: 56, yM: 8 }, size: { radiusM: 0.4, heightM: 1.2 } }];

function build(id: string, name: string, agents: readonly AgentSpec[], objects: readonly ObjectSpec[]): ScenarioDocument {
  const base = { ...f1EmptyDocument(id, name), agents: [...agents] };
  const loaded = loadScenario(base);
  if (!loaded.ok) throw new Error(`${name}: ${loaded.error.message}`);
  paintF1Obstacles(loaded.value.grid);
  return scenarioFromGrid({ id, name, defaultSeed: base.defaultSeed }, loaded.value.grid, base.zones, base.agents, { objects });
}

/**
 * F2 discovery demo: the F1 world (wall, closed box, marsh) and the F1 agents with a marker out of range. Run it with
 * `unknown` beliefs (the default run configuration below): the wall is not on any agent's map, so a plan across it
 * is made on unknown space and replanned when the lidar finds the wall; the marker enters the beliefs only when seen.
 */
export function f2DiscoveryScenario(): ScenarioDocument {
  const base = f1EmptyDocument(F2_DISCOVERY_ID, "F2 discovery");
  return build(F2_DISCOVERY_ID, "F2 discovery", base.agents, DISCOVERY_OBJECTS);
}

/**
 * F2 sensing budget demo: twenty ground vehicles with the default 180-ray, 10 Hz lidar (3,600 rays per tick) in the
 * left part of the F1 world, which is free of the wall, the box and the marsh.
 */
export function f2TwentyAgentsScenario(): ScenarioDocument {
  const agents: AgentSpec[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) agents.push({ kind: "ugv", key: `u${String(r * 5 + c + 1).padStart(2, "0")}`, start: { xM: 3 + c * 5, yM: 20 + r * 8 }, base: { xM: 5, yM: 5 } });
  }
  return build(F2_TWENTY_AGENTS_ID, "F2 20 agents", agents, []);
}

/**
 * The 1 km² reference world with a prior map of it, the stale kind: a survey that is right everywhere except one 15 m
 * square, where free and occupied are swapped (so it holds both errors an agent can make: a wall that is not there, and
 * free space that is blocked). The rover starts from it; the scout starts unknown (see `f2PriorRunConfig`). It is also
 * the fixture of the belief-overlay upload benchmark: the whole map is known from tick 0, so every chunk of the
 * 1 km² belief atlas has to reach the screen.
 */
export function f2PriorReferenceScenario(): ScenarioDocument {
  const world = buildReferenceWorld();
  const prior = new GridSpace({ sizeX: world.sizeX, sizeY: world.sizeY, resolutionM: world.resolutionM, chunkSize: world.chunkSize, altitudeLimitsM: world.altitudeLimitsM });
  const buf = new Uint16Array(world.occupancy.chunkCells);
  const out = new Uint8Array(world.occupancy.chunkCells);
  const SQUARE = { i0: 1850, j0: 80, size: 30 }; // 15 m at 0.5 m, where the world has both free cells and obstacles
  for (let cj = 0; cj < world.chunksY; cj++) {
    for (let ci = 0; ci < world.chunksX; ci++) {
      world.occupancy.readChunk(ci, cj, buf);
      for (let k = 0; k < out.length; k++) {
        const i = ci * world.chunkSize + (k % world.chunkSize);
        const j = cj * world.chunkSize + Math.floor(k / world.chunkSize);
        const occupied = (buf[k] ?? 0) !== 0;
        const stale = i >= SQUARE.i0 && i < SQUARE.i0 + SQUARE.size && j >= SQUARE.j0 && j < SQUARE.j0 + SQUARE.size;
        out[k] = occupied !== stale ? 2 : 1; // 1 = free, 2 = occupied
      }
      prior.setChunk("terrainCost", ci, cj, out); // the layer only carries the codes: encoded below as `knowledge`
    }
  }
  return scenarioFromGrid(
    { id: F2_PRIOR_REFERENCE_ID, name: "F2 prior map (1 km², stale survey)", defaultSeed: REFERENCE_WORLD_SEED },
    world,
    [],
    [
      { kind: "ugv", key: "rover", start: { xM: 5, yM: 5 } },
      { kind: "uav", key: "scout", start: { xM: 6, yM: 4, zM: 20 } },
    ],
    { priors: [{ id: "survey", description: "A survey of the reference world, wrong in one 15 m square (free and occupied swapped).", confidence: 0.8, layers: { knowledge: { chunks: encodeLayer(prior, "terrainCost") } } }] },
  );
}

/** The rover starts from the `survey` prior, the scout from an unknown map. */
export function f2PriorRunConfig(scenarioVersion: number): RunConfigDocument {
  return { schemaVersion: 0, scenario: { id: F2_PRIOR_REFERENCE_ID, version: scenarioVersion }, beliefs: { default: { init: "unknown" }, byAgent: { rover: { init: { prior: "survey" } } } } };
}

/** Default run configuration of the F2 demos: every agent starts with an `unknown` map (ADR-0028 addition of 2026-10-09). */
export function f2RunConfig(scenarioId: string, scenarioVersion: number): RunConfigDocument {
  return { schemaVersion: 0, scenario: { id: scenarioId, version: scenarioVersion }, beliefs: { default: { init: "unknown" } } };
}
