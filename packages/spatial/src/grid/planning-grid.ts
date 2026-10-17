import type { ZoneSet } from "../zones.ts";

/**
 * What a planning view reads of a map (ADR-0014, ADR-0024): the ground-truth grid (F1, and `ideal` agents) or an
 * agent's belief grid (F2). Planning code depends on this interface only, so it cannot reach ground truth through
 * a belief map.
 */
export interface PlanningGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly zones: ZoneSet;
  readonly altitudeLimitsM: { readonly min: number; readonly max: number };
  /** Whether any cell can be unknown (belief grids): views then keep a per-cell unknown flag. */
  readonly hasUnknown: boolean;
  /** Moves whenever something a planning view reads may have changed. */
  readonly version: number;
  /** Chunk indices (sorted) whose planning content changed after `version`. */
  chunksChangedSince(version: number): number[];
  inBounds(i: number, j: number): boolean;
  cellI(x: number): number;
  cellJ(y: number): number;
  cellCenterX(i: number): number;
  cellCenterY(j: number): number;
  /** Stops ground vehicles (an obstacle, known or believed; outside the map). */
  isBlocked(i: number, j: number): boolean;
  /** Never observed (belief grids only): the cost profile's `unknown` weight applies. */
  isUnknown(i: number, j: number): boolean;
  /** Terrain cost code (×0.1); 0 = impassable for ground vehicles. */
  terrainAt(i: number, j: number): number;
  groundHeightM(i: number, j: number): number;
  /** Top of whatever occupies the cell, for aircraft (m); +∞ = unlimited. */
  obstacleTopM(i: number, j: number): number;
  /**
   * Bulk read for the topological layer: the class of every cell of chunk (ci, cj), row-major over chunkSize²
   * (`CELL_UNKNOWN`, `CELL_FREE`, `CELL_BLOCKED`; cells beyond the map are unspecified). Returns false, leaving
   * `out` untouched, when every cell of the chunk is unknown.
   */
  classifyChunk(ci: number, cj: number, out: Uint8Array): boolean;
  /**
   * Optional: the cells (j · sizeX + i) whose planning content changed after `version`, possibly repeated, or
   * undefined when the map cannot tell (callers then use `chunksChangedSince`). Lets views refresh only those cells.
   */
  cellsChangedSince?(version: number): Int32Array | undefined;
}

export const CELL_UNKNOWN = 0;
export const CELL_FREE = 1;
export const CELL_BLOCKED = 2;
