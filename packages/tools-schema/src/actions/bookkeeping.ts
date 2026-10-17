import Type from "typebox";
import type { CapabilityDef } from "../capability.ts";

/** Timer limits (ADR-0005 addition of 2026-10-09): at most 8 active per agent, delays in [0.1, 3600] s of sim time. */
export const TIMER_LIMITS = { maxActive: 8, minDelayS: 0.1, maxDelayS: 3600 } as const;

const TAG = "^[a-z][a-z0-9-]{0,31}$";

/**
 * Bookkeeping capabilities do not start actions: they may accompany any decision, including `idle`, and are applied
 * before the decision's action. The range and limit checks are the runtime's (stable codes below), so the schema only
 * bounds the shape.
 */
export const setTimer = {
  name: "setTimer",
  kind: "bookkeeping",
  description:
    "Ask to be woken up later: after delayS seconds of simulated time you receive a timer event carrying this tag. " +
    "It starts no action and may accompany any decision, including idle. Setting a tag that already exists replaces it. " +
    "At most 8 timers can be active; delayS must be between 0.1 and 3600. " +
    "Failures: delay_out_of_range, timer_limit.",
  params: Type.Object(
    {
      delayS: Type.Number({ description: "Simulated seconds from now until the timer fires, between 0.1 and 3600." }),
      tag: Type.String({ pattern: TAG, description: "Name of the timer: lowercase letters, digits and hyphens, starting with a letter, at most 32 characters." }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ tag: Type.String({ description: "The timer's tag." }) }, { additionalProperties: false }),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["delay_out_of_range", "timer_limit"],
} as const satisfies CapabilityDef;

export const cancelTimer = {
  name: "cancelTimer",
  kind: "bookkeeping",
  description:
    "Cancel an active timer by its tag, so it will not fire. It starts no action and may accompany any decision, including idle. " +
    "Failure: timer_not_found (no active timer has this tag).",
  params: Type.Object(
    { tag: Type.String({ pattern: TAG, description: "Tag of the timer to cancel." }) },
    { additionalProperties: false },
  ),
  result: Type.Object({ tag: Type.String({ description: "The cancelled timer's tag." }) }, { additionalProperties: false }),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["timer_not_found"],
} as const satisfies CapabilityDef;
