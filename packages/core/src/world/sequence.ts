import type { CapabilityPort } from "../actions/ports.ts";
import { err, ok, type Result } from "../result.ts";
import type { Brain, DecisionEnvelope, DecisionRequest } from "./brain.ts";

// The `sequence` script mind (ADR-0036 addition of 2026-10-26): an ordered list of actions an agent runs one after the other. A step is decided once the step before it ended `done`;
// a refused or failed step stops the mission (no retry) and says which step and why; a reflex that takes the agent over ends the running step as preempted, and the mission stops
// unless the action's rule lets it resume (none does). No conditions, loops or parallel steps: those are the plan language of a later phase.

/** One step: an action of the capability manifest and its arguments (validated against the manifest's schema before the run). */
export interface SequenceStep {
  readonly action: string;
  readonly args?: unknown;
}

/** A list is at most this long (the run configuration is a document with a size limit; a mission is a handful of steps). */
export const MISSION_MAX_STEPS = 64;

export type MissionErrorCode = "mission_empty" | "mission_too_long" | "unknown_action" | "vehicle_unsupported" | "invalid_args";

/** A structured error naming the step (1-based) and its action. */
export interface MissionError {
  readonly code: MissionErrorCode;
  readonly message: string;
  readonly step?: number;
  readonly action?: string;
}

/**
 * Checks a list against the capability manifest for an agent of `kind`: every step an action (not bookkeeping) that exists, that this kind of vehicle supports, with
 * arguments its schema accepts. The order is not checked: whether a step can start when its turn comes is the start check's (a mission that takes off after exploring stops there).
 */
export function validateSequence(steps: readonly SequenceStep[], caps: CapabilityPort, kind: "ugv" | "uav"): Result<readonly SequenceStep[], MissionError> {
  if (steps.length === 0) return err({ code: "mission_empty", message: "a mission needs at least one step" });
  if (steps.length > MISSION_MAX_STEPS) return err({ code: "mission_too_long", message: `a mission has at most ${MISSION_MAX_STEPS} steps, got ${steps.length}` });
  for (const [i, s] of steps.entries()) {
    const step = i + 1;
    const known = caps.list().some((c) => c.name === s.action && c.kind === "action");
    if (!known) return err({ code: "unknown_action", step, action: s.action, message: `step ${step}: "${s.action}" is not an action of the capability manifest` });
    if (!caps.vehicles(s.action).includes(kind)) return err({ code: "vehicle_unsupported", step, action: s.action, message: `step ${step}: "${s.action}" is not available to a ${kind}` });
    const v = caps.validate(s.action, s.args ?? {});
    if (!v.ok) return err({ code: "invalid_args", step, action: s.action, message: `step ${step}: ${s.action}: ${v.error.message}` });
  }
  return ok(steps);
}

/**
 * Whether the mission goes on with the same step when it ended preempted. The rule is per action and none resumes: a preemption means a reflex judged the agent in danger
 * (the battery reflex sends it home), and driving on with the step afterwards would undo that, so the mission stops and says so.
 */
export function resumesAfterPreemption(_action: string): boolean {
  return false;
}

/** A mind whose state is one number a snapshot keeps (a script's cursor, a mission's step and phase). */
export interface PositionedBrain extends Brain {
  readonly position: number;
  restorePosition(position: number): void;
}

/** What the world writes into the decision record of a mission's mind, next to the decision (`step` and `of`, and how the mission ended). */
export interface MissionNote {
  /** The step (1-based) this decision starts, or the step the mission ended at. */
  readonly step: number;
  readonly of: number;
  /** The mission ran to its end (every step done). */
  readonly done?: true;
  /** The mission stopped at `step`: why. */
  readonly stop?: { readonly status: "refused" | "failed" | "preempted"; readonly action: string; readonly code: string };
}

type Phase = "ready" | "running" | "stopped" | "done";
const PHASES: readonly Phase[] = ["ready", "running", "stopped", "done"];

/** The mind of an agent that runs a mission. Holds no randomness and no clock; its state is the step it is at and whether it waits, stopped or finished. */
export class SequenceBrain implements Brain {
  readonly tier = "script" as const;
  /** Steps decided so far: the one running is `steps[cursor - 1]`. */
  private cursor = 0;
  private phase: Phase = "ready";

  constructor(
    readonly id: string,
    private readonly steps: readonly SequenceStep[],
  ) {}

  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    return Promise.resolve(this.next(req));
  }

  private next(req: DecisionRequest): DecisionEnvelope {
    const of = this.steps.length;
    if (this.phase === "ready") {
      // The genesis request is the first thing a mind is asked; any other event before it would leave the mission waiting for it.
      return req.events.some((e) => e.kind === "start") ? this.begin(0) : { decision: { kind: "idle" } };
    }
    if (this.phase !== "running") return { decision: { kind: "idle" } };
    const step = this.steps[this.cursor - 1] as SequenceStep;
    for (const e of req.events) {
      if (e.kind === "actionRejected" && e.name === step.action) return this.stop("refused", step.action, e.code);
      if (e.kind === "actionFailed" && e.name === step.action) {
        if (e.status === "preempted" && resumesAfterPreemption(step.action)) return this.begin(this.cursor - 1);
        return this.stop(e.status, step.action, e.code);
      }
      if (e.kind === "actionCompleted" && e.name === step.action) {
        if (this.cursor >= of) {
          this.phase = "done";
          return { decision: { kind: "idle" }, mission: { step: this.cursor, of, done: true } };
        }
        return this.begin(this.cursor);
      }
    }
    return { decision: { kind: "idle" } };
  }

  /** Decides the step at `index`. */
  private begin(index: number): DecisionEnvelope {
    const step = this.steps[index] as SequenceStep;
    this.cursor = index + 1;
    this.phase = "running";
    return { decision: { kind: "action", name: step.action, params: step.args ?? {} }, mission: { step: this.cursor, of: this.steps.length } };
  }

  private stop(status: "refused" | "failed" | "preempted", action: string, code: string): DecisionEnvelope {
    this.phase = "stopped";
    return { decision: { kind: "idle" }, rationale: `step ${this.cursor} of ${this.steps.length} (${action}) ${status}: ${code}`, mission: { step: this.cursor, of: this.steps.length, stop: { status, action, code } } };
  }

  /** The state as one number (a snapshot keeps it; a fork must restore it): the steps decided and the phase. */
  get position(): number {
    return this.cursor * 4 + PHASES.indexOf(this.phase);
  }

  /** Puts the state back (a restore of a snapshot). */
  restorePosition(position: number): void {
    const cursor = Math.floor(position / 4);
    const phase = PHASES[position % 4];
    const valid = Number.isInteger(position) && position >= 0 && phase !== undefined && cursor <= this.steps.length && (phase === "ready" ? cursor === 0 : cursor >= 1);
    if (!valid) throw new RangeError(`mission state ${position} is not a state of a list of ${this.steps.length} steps`);
    this.cursor = cursor;
    this.phase = phase;
  }
}
