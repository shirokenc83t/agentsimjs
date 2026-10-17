import type { GridSpace } from "../grid/grid-space.ts";
import type { PlanningGrid } from "../grid/planning-grid.ts";
import { ZoneSet } from "../zones.ts";
import { BELIEF_FREE, BELIEF_OCCUPIED, type BeliefMap } from "./belief-map.ts";
import { PRIOR_FREE, PRIOR_UNKNOWN, type PriorMap } from "./prior-map.ts";

/** Nominal terrain cost code (×1.0), used where the agent knows no terrain (F2: terrain is not sensed). */
const TERRAIN_NOMINAL = 10;

/**
 * What every agent knows of the world from tick 0, in every belief mode (ADR-0028 addition of 2026-10-09): the
 * map's size and resolution, its zones and altitude limits, and the scenario's rule for obstacles of unknown
 * height. Mission and regulatory data, copied out of the scenario so that no belief structure holds the
 * ground-truth grid.
 */
export interface MissionData {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: number;
  readonly zones: ZoneSet;
  readonly altitudeLimitsM: { readonly min: number; readonly max: number };
  /** Top assumed for a believed obstacle whose height was never measured; undefined = unlimited (ADR-0025 addition). */
  readonly defaultObstacleHeightM: number | undefined;
}

export function missionOf(g: GridSpace): MissionData {
  return {
    sizeX: g.sizeX,
    sizeY: g.sizeY,
    resolutionM: g.resolutionM,
    chunkSize: g.chunkSize,
    zones: new ZoneSet(g.zones.zones),
    altitudeLimitsM: { min: g.altitudeLimitsM.min, max: g.altitudeLimitsM.max },
    defaultObstacleHeightM: g.defaultObstacleHeightM,
  };
}

/**
 * The planner's map of one agent built from its beliefs (ADR-0012 belief map; ADR-0028 and ADR-0012 additions of
 * 2026-10-09). It never reads the ground truth:
 * - a cell believed occupied stops ground vehicles; for aircraft its top is the known upper bound, or the
 *   scenario's `defaultObstacleHeightM` when none is known (+∞ when that is unset too: blocks at every altitude);
 * - a cell believed free, or unknown, does not; unknown cells are flagged so the cost profile's `unknown` weight
 *   applies to them, for every vehicle;
 * - terrain cost and ground height come from the agent's prior where it knows the cell, and are nominal
 *   otherwise (terrain is not sensed in F2).
 * Its version moves only with planning-relevant changes (the belief map's plan version).
 */
export class BeliefGrid implements PlanningGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly zones: ZoneSet;
  readonly altitudeLimitsM: { readonly min: number; readonly max: number };
  readonly hasUnknown = true;
  private readonly unknownTopM: number;

  constructor(
    private readonly mission: MissionData,
    readonly belief: BeliefMap,
    private readonly prior?: PriorMap,
  ) {
    this.sizeX = mission.sizeX;
    this.sizeY = mission.sizeY;
    this.resolutionM = mission.resolutionM;
    this.chunkSize = mission.chunkSize;
    this.chunksX = Math.ceil(mission.sizeX / mission.chunkSize);
    this.chunksY = Math.ceil(mission.sizeY / mission.chunkSize);
    this.zones = mission.zones;
    this.altitudeLimitsM = mission.altitudeLimitsM;
    this.unknownTopM = mission.defaultObstacleHeightM ?? Number.POSITIVE_INFINITY;
    if (prior && (prior.sizeX !== mission.sizeX || prior.sizeY !== mission.sizeY)) {
      throw new RangeError(`prior ${prior.id} is ${prior.sizeX} × ${prior.sizeY}, the map ${mission.sizeX} × ${mission.sizeY}`);
    }
  }

  get version(): number {
    return this.belief.planVersion;
  }

  /**
   * The same planner's map frozen now (F2b M4, ADR-0037 item 16): a deep copy of the belief map, the prior and the mission
   * data, which are immutable, shared. Planning on it equals planning on this map at the moment of copying.
   */
  snapshotCopy(): BeliefGrid {
    return new BeliefGrid(this.mission, this.belief.clone(), this.prior);
  }

  chunksChangedSince(version: number): number[] {
    return this.belief.chunksPlanChangedSince(version);
  }

  cellsChangedSince(version: number): Int32Array | undefined {
    return this.belief.cellsPlanChangedSince(version);
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.sizeX && j < this.sizeY;
  }

  cellI(x: number): number {
    return Math.floor(x / this.resolutionM);
  }

  cellJ(y: number): number {
    return Math.floor(y / this.resolutionM);
  }

  cellCenterX(i: number): number {
    return (i + 0.5) * this.resolutionM;
  }

  cellCenterY(j: number): number {
    return (j + 0.5) * this.resolutionM;
  }

  isBlocked(i: number, j: number): boolean {
    return !this.inBounds(i, j) || this.belief.state(i, j) === BELIEF_OCCUPIED;
  }

  isUnknown(i: number, j: number): boolean {
    const s = this.belief.state(i, j);
    return s !== BELIEF_FREE && s !== BELIEF_OCCUPIED;
  }

  terrainAt(i: number, j: number): number {
    const p = this.prior;
    if (!p?.terrainCost || !this.inBounds(i, j)) return TERRAIN_NOMINAL;
    const k = j * this.sizeX + i;
    return (p.knowledge[k] ?? PRIOR_UNKNOWN) === PRIOR_UNKNOWN ? TERRAIN_NOMINAL : (p.terrainCost[k] ?? TERRAIN_NOMINAL);
  }

  /** The prior's ground height on cells it knows as free; 0 elsewhere. */
  groundHeightM(i: number, j: number): number {
    const p = this.prior;
    if (!p?.heightDm || !this.inBounds(i, j)) return 0;
    const k = j * this.sizeX + i;
    return p.knowledge[k] === PRIOR_FREE ? (p.heightDm[k] ?? 0) / 10 : 0;
  }

  classifyChunk(ci: number, cj: number, out: Uint8Array): boolean {
    // Belief states and the cell classes share codes: unknown 0, free 1, occupied (blocked) 2.
    return this.belief.classifyChunk(ci, cj, out);
  }

  obstacleTopM(i: number, j: number): number {
    if (this.belief.state(i, j) !== BELIEF_OCCUPIED) return this.groundHeightM(i, j);
    const top = this.belief.knownMaxM(i, j);
    return top === Number.POSITIVE_INFINITY ? this.unknownTopM : top;
  }
}
