import { POSE_STRIDE } from "@agentsim/core";

/**
 * F0 placeholder world: one entity on a fixed circular path, a pure function of the tick.
 * Exists only to exercise the worker/interpolation pipeline; replaced by the core world in F1.
 */
export const DUMMY_ENTITY_IDS = ["dummy-001"] as const;

/** Fixed simulation step (s). Tick rate changes only how fast ticks happen in wall time. */
export const DUMMY_DT_S = 0.1;

const RADIUS_M = 15;
const OMEGA_RAD_S = 0.4;

/** Writes the pose of every entity at `tick` into `out` (length ≥ entities × POSE_STRIDE). */
export function writeDummyPoses(tick: number, out: Float32Array): void {
  const t = tick * DUMMY_DT_S;
  const a = OMEGA_RAD_S * t;
  out[0] = RADIUS_M * Math.cos(a);
  out[1] = RADIUS_M * Math.sin(a);
  out[2] = 0;
  out[3] = a + Math.PI / 2; // heading tangent to the circle
}

export const DUMMY_POSE_FLOATS = DUMMY_ENTITY_IDS.length * POSE_STRIDE;
