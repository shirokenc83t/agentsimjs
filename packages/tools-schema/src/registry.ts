import { err, ok, validate, type CodedError, type Result, type ValidationIssue } from "@agentsim/core";
import type { Static } from "typebox";
import * as baseActions from "./actions/base-actions.ts";
import * as bookkeeping from "./actions/bookkeeping.ts";
import type { CapabilityDef, PreconditionName } from "./capability.ts";

/** Every capability, sorted by name (stable order for exposures and tests). */
export const CAPABILITIES: readonly CapabilityDef[] = [...Object.values(baseActions), bookkeeping.setTimer, bookkeeping.cancelTimer].sort((a, b) => (a.name < b.name ? -1 : 1));

export type BaseActionName = (typeof baseActions)[keyof typeof baseActions]["name"];
/** Parameters of a base action, as validated. */
export type ActionParams<N extends BaseActionName> = Static<Extract<(typeof baseActions)[keyof typeof baseActions], { name: N }>["params"]>;
export type ActionResult<N extends BaseActionName> = Static<Extract<(typeof baseActions)[keyof typeof baseActions], { name: N }>["result"]>;

/**
 * Failure codes any action can end with, added by the runtime to each capability's own codes. Stable:
 * minds and detectors match on them.
 */
export const COMMON_FAILURE_CODES = [
  "unknown_capability",
  "invalid_params",
  "vehicle_unsupported",
  "precondition_failed",
  "scope_denied",
  "battery_depleted",
  "collision",
  "not_an_action",
] as const;
export type CommonFailureCode = (typeof COMMON_FAILURE_CODES)[number];

/** Descriptions of the named preconditions (evaluated by the core runtime). */
export const PRECONDITIONS: Readonly<Record<PreconditionName, string>> = {
  airborne: "The UAV is flying (after takeoff, before landing).",
  grounded: "The UAV is on the ground.",
  hasBase: "The agent has a base assigned in the scenario.",
  hasRangeSensor: "The agent has a range sensor (lidar or proximity): without one it can never discover anything.",
};

const byName = new Map(CAPABILITIES.map((c) => [c.name, c]));

/**
 * The closed set of actions a researcher can inject as world-scope commands (ADR-0015 addition of 2026-10-12). Not part
 * of the manifest: minds never see it. Every entry is a `self`-scope action capability; `returnToBase` is deliberately
 * outside the set (a researcher sends an agent somewhere with `goTo`).
 */
export const INJECTABLE_COMMANDS = ["explore", "goTo", "hold", "land", "takeoff"] as const;
export type InjectableCommand = (typeof INJECTABLE_COMMANDS)[number];

export function isInjectable(name: string): name is InjectableCommand {
  return (INJECTABLE_COMMANDS as readonly string[]).includes(name);
}

export function getCapability(name: string): CapabilityDef | undefined {
  return byName.get(name);
}

export type ParamsError = CodedError<"unknown_capability" | "invalid_params"> & { readonly issues: readonly ValidationIssue[] };

/** Validates untrusted parameters for a capability (minds, MQTT, plans, scripts). */
export function validateParams(name: string, params: unknown): Result<unknown, ParamsError> {
  const cap = byName.get(name);
  if (!cap) return err({ code: "unknown_capability", message: `unknown capability "${name.slice(0, 64)}"`, issues: [] });
  const r = validate(cap.params, params);
  if (!r.ok) return err({ code: "invalid_params", message: r.error.message, issues: r.error.issues });
  return ok(r.value);
}
