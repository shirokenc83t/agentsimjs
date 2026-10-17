import { detmath } from "@agentsim/core";
import { OCCUPANCY_FREE, type GridSpace } from "../grid/grid-space.ts";

/** A camera's pose and optics (horizontal field of view only; ADR-0012 addition of 2026-10-09). */
export interface CameraView {
  readonly x: number;
  readonly y: number;
  /** Camera altitude above ground (m). */
  readonly z: number;
  readonly headingRad: number;
  /** Horizontal field of view, centred on the heading (rad); ≥ 2π means all around. */
  readonly fovRad: number;
  readonly rangeM: number;
}

/** Reserved for per-camera reuse (the walk itself keeps its state in locals). */
export interface CameraScratch {
  readonly _brand?: never;
}

export function newCameraScratch(): CameraScratch {
  return {};
}

/**
 * Whether the camera sees a point (an entity's centre): within the horizontal range, inside the horizontal
 * field of view, and with 2.5D line of sight. The sight line is blocked by any cell crossed strictly between
 * the camera's cell and the target's cell whose ground-truth obstacle top reaches the line's height at the
 * middle of its crossing. Vertical field of view is not modelled (F2). Allocation-free; trigonometry through
 * detmath (ADR-0023).
 */
export function cameraSees(g: GridSpace, cam: CameraView, target: { readonly x: number; readonly y: number; readonly z: number }, _s: CameraScratch): boolean {
  const ex = target.x - cam.x;
  const ey = target.y - cam.y;
  const dist = Math.sqrt(ex * ex + ey * ey);
  if (dist > cam.rangeM) return false;
  if (dist === 0) return true;
  if (cam.fovRad < 2 * Math.PI) {
    // Inside the field of view: the angle to the heading is at most half the field of view.
    const cosToHeading = (ex * detmath.cos(cam.headingRad) + ey * detmath.sin(cam.headingRad)) / dist;
    if (cosToHeading < detmath.cos(cam.fovRad / 2)) return false;
  }
  const res = g.resolutionM;
  let i = Math.floor(cam.x / res);
  let j = Math.floor(cam.y / res);
  const ti = Math.floor(target.x / res);
  const tj = Math.floor(target.y / res);
  const dx = ex / dist;
  const dy = ey / dist;
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepI === 0 ? Infinity : res / Math.abs(dx);
  const tDeltaY = stepJ === 0 ? Infinity : res / Math.abs(dy);
  let tMaxX = stepI === 0 ? Infinity : ((stepI > 0 ? (i + 1) * res : i * res) - cam.x) / dx;
  let tMaxY = stepJ === 0 ? Infinity : ((stepJ > 0 ? (j + 1) * res : j * res) - cam.y) / dy;
  for (;;) {
    // Step into the next cell; tEntry is where the sight line enters it.
    let tEntry: number;
    if (tMaxX <= tMaxY) {
      tEntry = tMaxX;
      tMaxX += tDeltaX;
      i += stepI;
    } else {
      tEntry = tMaxY;
      tMaxY += tDeltaY;
      j += stepJ;
    }
    if ((i === ti && j === tj) || tEntry >= dist) return true;
    if (!g.inBounds(i, j)) return true;
    const tNext = Math.min(tMaxX, tMaxY, dist);
    const mid = (tEntry + tNext) / 2;
    const lineZ = cam.z + ((target.z - cam.z) * mid) / dist;
    if (g.occupancy.get(i, j) !== OCCUPANCY_FREE && g.obstacleTopM(i, j) >= lineZ) return false;
  }
}
