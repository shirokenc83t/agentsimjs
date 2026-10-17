import { encodeChunkRle, type GridSpace, type LayerName } from "@agentsim/spatial";
import { SCENARIO_SCHEMA_VERSION, type AgentSpec, type ObjectSpec, type PriorSpec, type ScenarioDocument, type WorldSpec, type ZoneSpec } from "./schema.ts";

type LayerChunks = NonNullable<WorldSpec["layers"]["occupancy"]>["chunks"];

/**
 * Encodes one grid layer (ADR-0025): chunks equal to the layer default are omitted, uniform chunks become
 * `{ fill }`, others base64 RLE. Chunks are emitted in row-major order, so the output is deterministic.
 */
export function encodeLayer(grid: GridSpace, name: LayerName): LayerChunks {
  const layer = name === "occupancy" ? grid.occupancy : name === "terrainCost" ? grid.terrainCost : grid.heightDm;
  const bytes = name === "heightDm" ? 2 : 1;
  const buf = new Uint16Array(layer.chunkCells);
  const out: LayerChunks = [];
  for (let cj = 0; cj < grid.chunksY; cj++) {
    for (let ci = 0; ci < grid.chunksX; ci++) {
      const u = layer.uniformValue(ci, cj);
      if (u !== null) {
        if (u !== layer.defaultValue) out.push({ ci, cj, fill: u });
        continue;
      }
      layer.readChunk(ci, cj, buf);
      out.push({ ci, cj, rle: encodeChunkRle(buf, bytes) });
    }
  }
  return out;
}

/**
 * Encodes a prior's `knowledge` layer (0 unknown, 1 free, 2 occupied; row-major, `sizeX` wide) as scenario chunks:
 * chunks that are entirely unknown are omitted (absent chunks are unknown), uniform chunks become `{ fill }`, others
 * base64 RLE. Row-major chunk order, so the output is deterministic (ADR-0025 addition of 2026-10-09).
 */
export function encodePriorKnowledge(sizeX: number, sizeY: number, chunkSize: number, knowledge: ArrayLike<number>): LayerChunks {
  const cs = chunkSize;
  const chunksX = Math.ceil(sizeX / cs);
  const chunksY = Math.ceil(sizeY / cs);
  const buf = new Uint8Array(cs * cs);
  const out: LayerChunks = [];
  for (let cj = 0; cj < chunksY; cj++) {
    for (let ci = 0; ci < chunksX; ci++) {
      let first = -1;
      let uniform = true;
      for (let lj = 0; lj < cs; lj++) {
        const j = cj * cs + lj;
        for (let li = 0; li < cs; li++) {
          const i = ci * cs + li;
          const v = i < sizeX && j < sizeY ? (knowledge[j * sizeX + i] ?? 0) : 0;
          buf[lj * cs + li] = v;
          if (first < 0) first = v;
          else if (v !== first) uniform = false;
        }
      }
      if (uniform) {
        if (first !== 0) out.push({ ci, cj, fill: first });
        continue;
      }
      out.push({ ci, cj, rle: encodeChunkRle(buf, 1) });
    }
  }
  return out;
}

export interface ScenarioMeta {
  readonly id: string;
  readonly name: string;
  readonly defaultSeed: number;
}

/** Builds a scenario document from a grid (scenario editor save, presets, export). */
export function scenarioFromGrid(
  meta: ScenarioMeta,
  grid: GridSpace,
  zones: readonly ZoneSpec[],
  agents: readonly AgentSpec[],
  /** Entities and prior maps are not part of the grid: they are carried over unchanged (never dropped by a save). */
  extras: { readonly objects?: readonly ObjectSpec[]; readonly priors?: readonly PriorSpec[] } = {},
): ScenarioDocument {
  const layers: WorldSpec["layers"] = {};
  for (const name of ["occupancy", "terrainCost", "heightDm"] as const) {
    const chunks = encodeLayer(grid, name);
    if (chunks.length > 0) layers[name] = { chunks };
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: meta.id,
    name: meta.name,
    defaultSeed: meta.defaultSeed,
    world: {
      resolutionM: grid.resolutionM,
      sizeCells: { x: grid.sizeX, y: grid.sizeY },
      chunkSize: grid.chunkSize as WorldSpec["chunkSize"],
      altitudeLimitsM: { min: grid.altitudeLimitsM.min, max: grid.altitudeLimitsM.max },
      ...(grid.defaultObstacleHeightM === undefined ? {} : { defaultObstacleHeightM: grid.defaultObstacleHeightM }),
      layers,
    },
    zones: [...zones],
    agents: [...agents],
    ...(extras.objects && extras.objects.length > 0 ? { objects: [...extras.objects] } : {}),
    ...(extras.priors && extras.priors.length > 0 ? { priors: [...extras.priors] } : {}),
  };
}

/** The exchange form of a document (file export): pretty JSON with a trailing newline. */
export function serializeScenario(doc: ScenarioDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
