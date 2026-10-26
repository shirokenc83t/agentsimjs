import type { CapabilityPort } from "./ports.ts";

/**
 * The start-time availability of an action for an agent, written once (ADR-0005 addition of 2026-10-11): the runtime starts actions by it, the menu offered to minds is made
 * by it, and the researcher's controls ask it before the click, so what a control says and what the start check accepts cannot disagree. It is a function of the capability
 * definitions and of a few facts about the agent, so a view can evaluate it without the simulation.
 */

/** Why an action cannot be started now, before its parameters matter. */
export interface Unavailable {
  readonly code: string;
  readonly message: string;
  /** For `precondition_failed`: the precondition that does not hold. */
  readonly requires?: string;
}

/** What the predicate needs to know of an agent. */
export interface AgentFacts {
  readonly kind: string;
  readonly airborne: boolean;
  readonly soc: number;
  readonly hasBase: boolean;
  readonly hasRangeSensor: boolean;
}

/** The first check: the action exists for this kind of vehicle. */
export function vehicleAvailability(caps: Pick<CapabilityPort, "vehicles">, name: string, kind: string): Unavailable | undefined {
  return caps.vehicles(name).includes(kind) ? undefined : { code: "vehicle_unsupported", message: `${name} is not available to ${kind}` };
}

/** Whether a named precondition holds for an agent. */
export function preconditionHolds(precondition: string, f: AgentFacts): boolean {
  switch (precondition) {
    case "airborne":
      return f.kind === "uav" && f.airborne;
    case "grounded":
      return f.kind === "uav" && !f.airborne;
    case "hasBase":
      return f.hasBase;
    case "hasRangeSensor":
      return f.hasRangeSensor;
    default:
      return false;
  }
}

/** The checks after the vehicle and the scope: the battery, then the preconditions in the order the capability lists them. */
export function stateAvailability(caps: Pick<CapabilityPort, "preconditions">, name: string, f: AgentFacts): Unavailable | undefined {
  if (f.soc <= 0) return { code: "battery_depleted", message: "battery is empty" };
  for (const p of caps.preconditions(name)) {
    if (p.vehicles && !p.vehicles.includes(f.kind)) continue;
    if (!preconditionHolds(p.name, f)) return { code: "precondition_failed", message: `${name} requires ${p.name}`, requires: p.name };
  }
  return undefined;
}

/** The whole predicate for a researcher's control, which is the world's and not the agent's own (scope does not apply): vehicle, battery, preconditions. */
export function commandAvailability(caps: Pick<CapabilityPort, "vehicles" | "preconditions">, name: string, f: AgentFacts): Unavailable | undefined {
  return vehicleAvailability(caps, name, f.kind) ?? stateAvailability(caps, name, f);
}

/** The missing condition and the next step, for the precondition that does not hold. */
const NEEDS: Readonly<Record<string, { readonly needs: string; readonly first: string }>> = {
  airborne: { needs: "airborne", first: "take off first" },
  grounded: { needs: "to be on the ground", first: "land first" },
  hasBase: { needs: "a base", first: "give the agent a base in the scenario" },
  hasRangeSensor: { needs: "a range sensor", first: "give the agent a lidar or proximity sensor in its body" },
};

/**
 * The words for a refusal or a disabled control, from the same codes the runtime uses: the missing condition and the next step (`needs airborne · take off first`), never the
 * internal code alone. The caller puts the action's name in front.
 */
export function describeUnavailable(u: Unavailable, kind: string): string {
  if (u.code === "precondition_failed" && u.requires !== undefined) {
    const w = NEEDS[u.requires];
    return w ? `needs ${w.needs} · ${w.first}` : u.message;
  }
  if (u.code === "vehicle_unsupported") return `is not for a ${kind === "uav" ? "UAV" : kind === "ugv" ? "ground vehicle" : kind}`;
  if (u.code === "battery_depleted") return "cannot start: the battery is empty";
  return u.message;
}
