import type { TSchema } from "typebox";

/** Bodies a capability applies to; `none` = virtual agents (ADR-0015). */
export type VehicleKind = "uav" | "ugv" | "none";
export const VEHICLE_KINDS: readonly VehicleKind[] = ["uav", "ugv", "none"];

/** Authority level of a capability (ADR-0015). Minds never get `world`. */
export type Scope = "world" | "leader" | "self";

/** What a capability is, for exposures and the UI (more kinds arrive with F6, F8, F9). */
/**
 * `action`: starts a behavior with a lifecycle. `bookkeeping`: changes agent state only (timers, the notebook) and accompanies a decision. `compute` (ADR-0014 addition of 2026-10-29): answers a question
 * from the agent's own map and planner while it decides, and changes nothing.
 */
export type CapabilityKind = "action" | "bookkeeping" | "compute";

/**
 * A named precondition, evaluated by the runtime (core) and described here so every exposure explains it
 * the same way. `vehicles` restricts it to some bodies (e.g. `airborne` only constrains UAVs).
 */
export interface PreconditionRef {
  readonly name: PreconditionName;
  readonly vehicles?: readonly VehicleKind[];
}

export type PreconditionName = "airborne" | "grounded" | "hasBase" | "hasRangeSensor";

/**
 * One capability, defined once (ADR-0007): every exposure (provider tools, structured outputs, MQTT, MCP,
 * workflow palettes) is generated from this definition, never written by hand.
 */
export interface CapabilityDef<P extends TSchema = TSchema, R extends TSchema = TSchema> {
  /** camelCase, unique across capabilities. */
  readonly name: string;
  readonly kind: CapabilityKind;
  /** Written for LLMs: what it does, when to use it, units and frames. Identical for every mind. */
  readonly description: string;
  /** Parameters (closed object: unknown fields are rejected). */
  readonly params: P;
  /** Result reported when the action succeeds. */
  readonly result: R;
  readonly vehicles: readonly VehicleKind[];
  readonly scope: Scope;
  readonly preconditions: readonly PreconditionRef[];
  /** Stable, machine-readable failure codes specific to this capability (common codes are added by the runtime). */
  readonly failureCodes: readonly string[];
}
