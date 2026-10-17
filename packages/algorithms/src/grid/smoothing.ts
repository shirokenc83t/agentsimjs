import { detmath } from "@agentsim/core";
import type { SearchSpace } from "./search-space.ts";

function cellOk(space: SearchSpace, i: number, j: number): boolean {
  return space.passable(i, j);
}

function perMetre(space: SearchSpace, i: number, j: number): number {
  const n = j * space.sizeX + i;
  const pm = space.basePerMetre + space.codePerMetre * (space.mask[n] ?? 0);
  return space.unknown !== null && space.unknown[n] === 1 ? pm * space.unknownFactor : pm;
}

/**
 * Cost of the straight segment between two points (metres) under the space's profile: the length inside each
 * cell it crosses times that cell's cost per metre; +Infinity if the segment is not clear. "Clear" is the
 * conservative line of sight on the traversal mask: every touched cell passable and, where the segment passes
 * exactly through a cell corner, *both* side cells passable (no squeezing diagonally between two obstacles).
 * Turn costs are not included (see `polylineCost`). Deterministic IEEE arithmetic.
 */
export function segmentCost(space: SearchSpace, x0: number, y0: number, x1: number, y1: number): number {
  const res = space.resolutionM;
  let i = Math.floor(x0 / res);
  let j = Math.floor(y0 / res);
  const ti = Math.floor(x1 / res);
  const tj = Math.floor(y1 / res);
  if (!cellOk(space, i, j)) return Number.POSITIVE_INFINITY;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDx = stepI === 0 ? Infinity : res / Math.abs(dx);
  const tDy = stepJ === 0 ? Infinity : res / Math.abs(dy);
  let tx = stepI === 0 ? Infinity : ((stepI > 0 ? (i + 1) * res : i * res) - x0) / dx;
  let ty = stepJ === 0 ? Infinity : ((stepJ > 0 ? (j + 1) * res : j * res) - y0) / dy;
  let tPrev = 0;
  let cost = 0;
  let guard = Math.abs(ti - i) + Math.abs(tj - j) + 2;
  while ((i !== ti || j !== tj) && guard-- > 0) {
    const tNext = Math.min(tx, ty, 1);
    cost += (tNext - tPrev) * len * perMetre(space, i, j);
    tPrev = tNext;
    if (tx === ty) {
      // exact corner: both neighbours must be free, then move diagonally (zero length in the side cells)
      if (!cellOk(space, i + stepI, j) || !cellOk(space, i, j + stepJ)) return Number.POSITIVE_INFINITY;
      i += stepI;
      j += stepJ;
      tx += tDx;
      ty += tDy;
    } else if (tx < ty) {
      i += stepI;
      tx += tDx;
    } else {
      j += stepJ;
      ty += tDy;
    }
    if (!cellOk(space, i, j)) return Number.POSITIVE_INFINITY;
  }
  return cost + (1 - tPrev) * len * perMetre(space, i, j);
}

/** Line of sight on the traversal mask between two points (metres); see `segmentCost`. */
export function clearSegment(space: SearchSpace, x0: number, y0: number, x1: number, y1: number): boolean {
  return segmentCost(space, x0, y0, x1, y1) < Number.POSITIVE_INFINITY;
}

/** Heading change (rad, 0..π) between two direction vectors; 0 if either is degenerate. Deterministic. */
function turnBetween(ax: number, ay: number, bx: number, by: number): number {
  if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return 0;
  return detmath.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
}

/**
 * Cost of a polyline under the space's profile: `segmentCost` of every segment plus the turn weight times the
 * heading change at every interior vertex. The measure both the smoother and its property test use.
 */
export function polylineCost(space: SearchSpace, wp: readonly (readonly [number, number])[]): number {
  let c = 0;
  for (let k = 1; k < wp.length; k++) {
    const [ax, ay] = wp[k - 1] ?? [0, 0];
    const [bx, by] = wp[k] ?? [0, 0];
    c += segmentCost(space, ax, ay, bx, by);
    if (k >= 2 && space.turnWeight > 0) {
      const [px, py] = wp[k - 2] ?? [0, 0];
      c += space.turnWeight * turnBetween(ax - px, ay - py, bx - ax, by - ay);
    }
  }
  return c;
}

/** Relative tolerance on cost comparisons: a straight shortcut over collinear cells must not lose to rounding. */
const COST_EPS = 1e-9;

/**
 * Greedy string pulling (ADR-0014 path smoothing): from each anchor, extend forward while the straight segment
 * to the next path cell is clear **and costs no more** than the part of the path it replaces; the last such cell
 * becomes the next waypoint. Returns waypoints in metres (cell centres), start and goal included.
 *
 * Cost-aware (F1 e6 fix): the comparison uses `polylineCost`'s measure, including the turn at the anchor (from
 * the actual incoming heading) and at the end (into the next path step). The total cost is therefore never
 * increased by any accepted shortcut, so the smoothed path never costs more than the cell path; a detour the
 * search took around costly terrain is not pulled back through it.
 *
 * Profiles with edge constraints (per-move distance or turn limits) get no shortcuts: a long segment or a sharp
 * junction could break them. Their paths are only merged where consecutive moves are collinear.
 */
export function smoothPath(space: SearchSpace, cells: readonly number[]): [number, number][] {
  const sx = space.sizeX;
  const res = space.resolutionM;
  const cx = (c: number) => ((c % sx) + 0.5) * res;
  const cy = (c: number) => (((c / sx) | 0) + 0.5) * res;
  const centre = (c: number): [number, number] => [cx(c), cy(c)];
  const n = cells.length;
  if (n <= 2) return cells.map(centre);
  if (space.hasEdgeConstraints) return mergeCollinear(cells, sx).map(centre);
  const tw = space.turnWeight;
  const at = (k: number) => cells[k] ?? 0;
  /** Direction of the path move k → k+1. */
  const dirX = (k: number) => cx(at(k + 1)) - cx(at(k));
  const dirY = (k: number) => cy(at(k + 1)) - cy(at(k));
  const moveCost = (k: number) => segmentCost(space, cx(at(k)), cy(at(k)), cx(at(k + 1)), cy(at(k + 1)));

  const out: [number, number][] = [centre(at(0))];
  let inX = 0; // actual incoming heading at the anchor (0, 0 = none yet)
  let inY = 0;
  let anchor = 0;
  while (anchor < n - 1) {
    const ax = cx(at(anchor));
    const ay = cy(at(anchor));
    // Cost of the original path from the anchor to cell k, with the turn from the actual incoming heading.
    let replaced = moveCost(anchor) + (tw > 0 ? tw * turnBetween(inX, inY, dirX(anchor), dirY(anchor)) : 0);
    let next = anchor + 1;
    while (next + 1 < n) {
      const k = next + 1;
      replaced += moveCost(next) + (tw > 0 ? tw * turnBetween(dirX(next - 1), dirY(next - 1), dirX(next), dirY(next)) : 0);
      const bx = cx(at(k));
      const by = cy(at(k));
      let shortcut = segmentCost(space, ax, ay, bx, by);
      if (shortcut === Number.POSITIVE_INFINITY) break;
      let before = replaced;
      if (tw > 0) {
        shortcut += tw * turnBetween(inX, inY, bx - ax, by - ay);
        if (k + 1 < n) {
          // The junction into the next path step changes too.
          shortcut += tw * turnBetween(bx - ax, by - ay, dirX(k), dirY(k));
          before += tw * turnBetween(dirX(k - 1), dirY(k - 1), dirX(k), dirY(k));
        }
      }
      if (shortcut > before + COST_EPS * Math.abs(before)) break;
      next = k;
    }
    const [nx, ny] = centre(at(next));
    out.push([nx, ny]);
    inX = nx - ax;
    inY = ny - ay;
    anchor = next;
  }
  return out;
}

/** Cell path reduced to its turning points (start and goal kept). */
function mergeCollinear(cells: readonly number[], sx: number): number[] {
  const out: number[] = [cells[0] ?? 0];
  for (let k = 1; k < cells.length - 1; k++) {
    const a = cells[k - 1] ?? 0;
    const b = cells[k] ?? 0;
    const c = cells[k + 1] ?? 0;
    const d1x = (b % sx) - (a % sx);
    const d1y = ((b / sx) | 0) - ((a / sx) | 0);
    const d2x = (c % sx) - (b % sx);
    const d2y = ((c / sx) | 0) - ((b / sx) | 0);
    if (d1x !== d2x || d1y !== d2y) out.push(b);
  }
  out.push(cells[cells.length - 1] ?? 0);
  return out;
}
