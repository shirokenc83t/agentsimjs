export { ChunkedLayer, type LayerArray } from "./grid/chunked-layer.ts";
export { OccupancyPyramid, ANY_BLOCKED, ALL_BLOCKED } from "./grid/pyramid.ts";
export {
  GridSpace,
  OCCUPANCY_FREE,
  OCCUPANCY_BLOCKED,
  TERRAIN_NOMINAL,
  TERRAIN_IMPASSABLE,
  MAX_GRID_CELLS_PER_SIDE,
  type GridSpaceSpec,
  type LayerName,
} from "./grid/grid-space.ts";
export { ZoneSet, pointInPolygon, rectPolygon, type Zone, type ZoneKind } from "./zones.ts";
export { SpatialHash } from "./spatial-hash.ts";
export { raycast2d, lineOfSight, newRayHit, type RayHit } from "./raycast.ts";
export { senseRay, newRangeScratch, type RangeRay, type RangeSink, type RangeScratch } from "./sensing/range-sensor.ts";
export { cameraSees, newCameraScratch, type CameraView, type CameraScratch } from "./sensing/camera.ts";
export { periodUs, sensorPhaseUs, readsAtTick } from "./sensing/schedule.ts";
export type { PlanningGrid } from "./grid/planning-grid.ts";
export { BeliefGrid, missionOf, type MissionData } from "./belief/belief-grid.ts";
export { BeliefMap, LOGODDS_CLAMP, BELIEF_THRESHOLD, BELIEF_UNKNOWN, BELIEF_FREE, BELIEF_OCCUPIED, type BeliefState, type BeliefMapSnapshot } from "./belief/belief-map.ts";
export {
  AgentTopology,
  DEFAULT_TOPOLOGY,
  TOPOLOGY_LIMITS,
  type TopologyConfig,
  type PassabilityView,
  type RegionInfo,
  type FrontierGroup,
  type RegionEdge,
  type EdgeClass,
} from "./topology/topology.ts";
export { buildSpaceSummary, octantOf } from "./topology/summary.ts";
export type { SpaceSummary, Octant } from "@agentsim/core";
export { applyPrior, priorLogOdds, PRIOR_UNKNOWN, PRIOR_FREE, PRIOR_OCCUPIED, PRIOR_MAX_LOGODDS, type PriorMap } from "./belief/prior-map.ts";
export { GridSpatialModel, type SpatialModel, type Vec3, type VehicleClass } from "./spatial-model.ts";
export { encodeChunkRle, decodeChunkRle, toBase64, fromBase64, type ChunkCodecError } from "./codec/chunk-rle.ts";
export { encodeAtlasChunk, atlasScratch, ATLAS_BYTES_PER_CELL } from "./render/atlas-chunk.ts";
/** The 1 km² / 0.5 m reference world (F1 benchmarks and the lab preset): one builder for both. */
export { buildReferenceWorld, REFERENCE_WORLD_SEED } from "./presets/reference-world.ts";
