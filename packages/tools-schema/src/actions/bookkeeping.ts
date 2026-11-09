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

/** The notebook (ADR-0036 addition of 2026-10-29, F4): at most this many characters. */
export const NOTE_MAX_CHARS = 2000;

/**
 * The notebook: a bookkeeping capability that may accompany any decision, including `idle`. The text replaces the notebook or is appended to it; the notebook is the agent's state (hashed
 * only when it is not empty, in snapshots) and is carried in every prompt of an LLM mind. The length check is the runtime's (`note_too_long`).
 */
export const note = {
  name: "note",
  kind: "bookkeeping",
  description:
    "Keep a note for yourself: your notebook is returned to you in every later prompt, so use it for what you must not forget (the plan, the points still to visit, what you have seen). " +
    "mode replace overwrites the whole notebook, mode append adds the text after what is there. It starts no action and may accompany any decision, including idle. " +
    "The notebook holds at most 2000 characters in all; longer text is refused. Failure: note_too_long.",
  params: Type.Object(
    {
      text: Type.String({ description: "The note, at most 2000 characters (the whole notebook after an append)." }),
      mode: Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "replace overwrites the notebook, append adds to it." }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ chars: Type.Integer({ description: "Characters in the notebook now." }) }, { additionalProperties: false }),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["note_too_long"],
} as const satisfies CapabilityDef;

/** The task list (ADR-0005 addition of 2026-11-08, F4b): at most this many steps, each text at most this many characters. */
export const TASK_MAX_STEPS = 16;
export const TASK_STEP_MAX_CHARS = 200;

/**
 * The task list: a bookkeeping capability that may accompany any decision, including `idle`. The steps replace the agent's whole list (every status starts again); the list is the agent's state
 * (hashed only when not empty, in snapshots) and the simulator, never the mind, marks each step: the action an answer binds to step n (`step`) marks it running, then done or failed from the action's
 * outcome. The limits are the runtime's (`task_too_many_steps`, `task_step_too_long`).
 */
export const task = {
  name: "task",
  kind: "bookkeeping",
  description:
    "Write your task as a list of steps; the list is returned to you in every later prompt with the status of each step, which the simulator keeps (you cannot mark a step done yourself). " +
    "Sending a list replaces the whole list and every step starts pending again. Each step is a short text and, optionally, the action and parameters it stands for. " +
    "To work on a step, answer with its number as step (1 is the first). It starts no action and may accompany any decision, including idle. " +
    "At most 16 steps, each text at most 200 characters. Failures: task_too_many_steps, task_step_too_long.",
  params: Type.Object(
    {
      steps: Type.Array(
        Type.Object(
          {
            text: Type.String({ description: "What this step is, in a few words (at most 200 characters)." }),
            action: Type.Optional(Type.String({ description: "The action this step stands for, if one." })),
            params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Its parameters, if it has them." })),
          },
          { additionalProperties: false },
        ),
        { description: "The steps in order, at most 16." },
      ),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ steps: Type.Integer({ description: "Steps in the list now." }) }, { additionalProperties: false }),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["task_too_many_steps", "task_step_too_long"],
} as const satisfies CapabilityDef;
