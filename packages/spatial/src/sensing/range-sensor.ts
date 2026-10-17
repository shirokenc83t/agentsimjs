import { OCCUPANCY_FREE, type GridSpace } from "../grid/grid-space.ts";

/**
 * Where a range ray's observations go (ADR-0012 addition of 2026-10-09). Cells arrive in ray order.
 * - `free`: free ground, observed;
 * - `under`: an obstacle under the beam (occupied, top below `upperM`), never observed free;
 * - `hit`: an obstacle reaching the beam (top at least `lowerM`); the ray stops there.
 */
export interface RangeSink {
  free(i: number, j: number): void;
  under(i: number, j: number, upperM: number): void;
  hit(i: number, j: number, lowerM: number): void;
}

/** One horizontal ray of an abstract 2.5D range sensor. */
export interface RangeRay {
  /** Origin (m) and sensor altitude above ground (m). */
  readonly x: number;
  readonly y: number;
  readonly zM: number;
  /** Lower edge of the beam: max(0, zM − beamHalfHeightM). */
  readonly beamLowerM: number;
  /** Direction (any length > 0). */
  readonly dirX: number;
  readonly dirY: number;
  readonly rangeM: number;
  /**
   * Range noise for this ray (m), used when no `noise` source is passed to `senseRay`. With a source, noise is
   * drawn from it only if the ray hits (it moves only a hit), so rays without a hit draw nothing.
   */
  readonly noiseM: number;
  /**
   * Range-noise margin (m) of the inverse sensor model (ADR-0012 clarification of 2026-10-10): free evidence only
   * for cells that end at least this far before the measured hit; a measured hit within the margin of the cell the
   * ray reached is attributed to that cell. 0 without noise.
   */
  readonly marginM: number;
}

/** Preallocated cell list for one ray (no allocation per ray): cell indices, entry distances, and whether occupied. */
export interface RangeScratch {
  readonly cellI: Int32Array;
  readonly cellJ: Int32Array;
  readonly entryM: Float64Array;
  readonly occupied: Uint8Array;
}

/** Scratch for rays up to `rangeM` on a grid of `resolutionM` (a DDA visits at most 2 cells per cell length, plus the start). */
export function newRangeScratch(rangeM: number, resolutionM: number): RangeScratch {
  const n = Math.ceil((2 * rangeM) / resolutionM) + 4;
  return { cellI: new Int32Array(n), cellJ: new Int32Array(n), entryM: new Float64Array(n), occupied: new Uint8Array(n) };
}

/**
 * Casts one ray of the abstract 2.5D range sensor of ADR-0012 (a horizontal ray with a beam height, plus
 * returns from structures under the beam; flat ground) over the ground truth, and reports what it observes to
 * `sink`. With T a cell's obstacle top (0 on free ground), cells along the ray are, in order:
 * free ground (T = 0), an obstacle under the beam (0 < T < beamLowerM), or a hit (T ≥ beamLowerM), which ends
 * the ray. Noise moves the reported hit along the ray, but never past the true obstacle: a shortened reading
 * reports the hit in the earlier cell it ends in, and leaves later cells unobserved. Nothing is observed past
 * the range or outside the map. Returns the reported hit distance (m), or -1 without a hit.
 *
 * Allocation-free; deterministic (IEEE arithmetic, ties at exact corners step in x first, as `raycast2d`).
 */
export function senseRay(g: GridSpace, r: RangeRay, sink: RangeSink, s: RangeScratch, noise?: { draw(): number }): number {
  const res = g.resolutionM;
  const len = Math.sqrt(r.dirX * r.dirX + r.dirY * r.dirY);
  let i = Math.floor(r.x / res);
  let j = Math.floor(r.y / res);
  if (len === 0 || !g.inBounds(i, j)) return -1;
  const dx = r.dirX / len;
  const dy = r.dirY / len;
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepI === 0 ? Infinity : res / Math.abs(dx);
  const tDeltaY = stepJ === 0 ? Infinity : res / Math.abs(dy);
  let tMaxX = stepI === 0 ? Infinity : ((stepI > 0 ? (i + 1) * res : i * res) - r.x) / dx;
  let tMaxY = stepJ === 0 ? Infinity : ((stepJ > 0 ? (j + 1) * res : j * res) - r.y) / dy;
  // 1. Walk the true geometry: record cells up to (and including) the first one reaching the beam.
  const occ = g.occupancyDense();
  const sizeX = g.sizeX;
  const sizeY = g.sizeY;
  const lower = r.beamLowerM;
  const ci = s.cellI;
  const cj = s.cellJ;
  const entry = s.entryM;
  const occupiedAt = s.occupied;
  const cap = ci.length;
  let n = 0;
  let hitAt = -1;
  let t = 0;
  for (;;) {
    if (n >= cap) break;
    const occupied = occ[j * sizeX + i] !== OCCUPANCY_FREE;
    ci[n] = i;
    cj[n] = j;
    entry[n] = t;
    occupiedAt[n] = occupied ? 1 : 0;
    n++;
    if (occupied && g.obstacleTopM(i, j) >= lower) {
      hitAt = n - 1;
      break;
    }
    if (tMaxX <= tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      i += stepI;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      j += stepJ;
    }
    if (t > r.rangeM || i < 0 || j < 0 || i >= sizeX || j >= sizeY) break;
  }
  // 2. Noise moves only a hit, so it is drawn only for rays that hit; a lengthened reading stays at the obstacle.
  //    Inverse sensor model with a margin m: a reading within m of the obstacle is attributed to the obstacle's
  //    cell; one shortened by more is a false early return, attributed to the cell it ends in.
  let end = hitAt;
  let reported = -1;
  let freeUntil = Infinity;
  if (hitAt >= 0) {
    const tHit = entry[hitAt] ?? 0;
    const d = Math.max(0, tHit + (noise ? noise.draw() : r.noiseM));
    reported = Math.min(d, tHit);
    const m = r.marginM;
    if (d < tHit - m) {
      end = 0;
      while (end + 1 < hitAt && (entry[end + 1] ?? 0) <= d) end++;
    }
    // Free evidence only for cells that end at least m before the measured hit.
    freeUntil = reported - m;
  }
  // 3. Report, in ray order.
  const last = end >= 0 ? end : n - 1;
  for (let k = 0; k <= last; k++) {
    if (k === end) {
      sink.hit(ci[k] ?? 0, cj[k] ?? 0, lower);
      break;
    }
    if (occupiedAt[k] !== 0) sink.under(ci[k] ?? 0, cj[k] ?? 0, lower);
    else if (k + 1 >= n || (entry[k + 1] ?? 0) <= freeUntil) sink.free(ci[k] ?? 0, cj[k] ?? 0);
  }
  return reported;
}
