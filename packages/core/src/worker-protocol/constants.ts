/** Sim worker protocol constants (ADR-0019). Kept apart from the schemas so importing them stays cheap. */
/** v2 (F1 e2): scenario runs (`load`/`loaded`), multi-tick step, agent status, events, state hash. */
export const SIM_PROTOCOL_VERSION = 2;

/** Floats per entity in `poses`: x, y, z, yaw. */
export const POSE_STRIDE = 4;

/** Floats per agent in `agentStatus`: battery state of charge (0–1), speed (m/s), odometer (m), airborne (0/1). */
export const STATUS_STRIDE = 4;

/** Floats per executed-path point in `trail`: x, y, z (sim metres). */
export const TRAIL_STRIDE = 3;

/**
 * Most executed-path points kept per agent (F2 M1b). The live trail is a display aid: when an agent reaches this
 * many, the worker thins its points and sends a `replace`. Full-fidelity trajectories come from trace poses (F3).
 */
export const TRAIL_MAX_POINTS = 2048;
