/** Result of a grid raycast (reused object: no allocation per ray). */
export interface RayHit {
  hit: boolean;
  /** Distance travelled in metres (to the hit cell boundary, or maxRange). */
  distanceM: number;
  /** Hit cell, or the last cell visited. */
  i: number;
  j: number;
}

export function newRayHit(): RayHit {
  return { hit: false, distanceM: 0, i: 0, j: 0 };
}

/**
 * 2D DDA raycast (Amanatides–Woo, ADR-0012) over a blocked-cell predicate. Visits cells in order along
 * the ray; stops at the first blocked cell or at `maxRangeM`. Allocation-free (writes into `out`).
 * Deterministic: IEEE arithmetic only; ties at exact corners step in x first.
 */
export function raycast2d(
  blocked: (i: number, j: number) => boolean,
  resolutionM: number,
  x0: number,
  y0: number,
  dirX: number,
  dirY: number,
  maxRangeM: number,
  out: RayHit,
): RayHit {
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  out.hit = false;
  out.distanceM = maxRangeM;
  let i = Math.floor(x0 / resolutionM);
  let j = Math.floor(y0 / resolutionM);
  out.i = i;
  out.j = j;
  if (len === 0) return out;
  const dx = dirX / len;
  const dy = dirY / len;
  if (blocked(i, j)) {
    out.hit = true;
    out.distanceM = 0;
    return out;
  }
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepI === 0 ? Infinity : resolutionM / Math.abs(dx);
  const tDeltaY = stepJ === 0 ? Infinity : resolutionM / Math.abs(dy);
  let tMaxX = stepI === 0 ? Infinity : ((stepI > 0 ? (i + 1) * resolutionM : i * resolutionM) - x0) / dx;
  let tMaxY = stepJ === 0 ? Infinity : ((stepJ > 0 ? (j + 1) * resolutionM : j * resolutionM) - y0) / dy;
  for (;;) {
    let t: number;
    if (tMaxX <= tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      i += stepI;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      j += stepJ;
    }
    if (t > maxRangeM) return out;
    out.i = i;
    out.j = j;
    if (blocked(i, j)) {
      out.hit = true;
      out.distanceM = t;
      return out;
    }
  }
}

/**
 * Line of sight between two points: true if no blocked cell lies on the segment (DDA traversal). Used by
 * path smoothing (F1) and later by sensors and radio line-of-sight (F2/F7).
 */
export function lineOfSight(blocked: (i: number, j: number) => boolean, resolutionM: number, x0: number, y0: number, x1: number, y1: number, scratch: RayHit): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return !blocked(Math.floor(x0 / resolutionM), Math.floor(y0 / resolutionM));
  return !raycast2d(blocked, resolutionM, x0, y0, dx, dy, dist, scratch).hit;
}
