import type { TraceSink } from "../actions/ports.ts";
import type { DecisionEvent } from "./events.ts";
import type { AllowedAction, BeliefSummary, SpaceSummary, UnavailableAction } from "./mind-view.ts";
import type { MissionNote } from "./sequence.ts";

export type { DecisionEvent } from "./events.ts";

/**
 * The simulator's view of a mind (ADR-0005). Core is the lowest layer, so the interface lives here as a
 * port; `@agentsim/minds` implements it (LLMBrain, RemoteBrain) from F3. A request carries every undelivered
 * event, the agent's own state and, from F2, what it believes and may do. Never ground truth, and never anything
 * that depends on which mind is asking (fairness): requests are byte-identical for every mind.
 */
export interface DecisionRequest {
  readonly agentId: string;
  readonly tick: number;
  readonly simTimeS: number;
  /** Every undelivered event, in the fixed delivery order of ADR-0005 (1..32 entries). */
  readonly events: readonly DecisionEvent[];
  /** Perception entries the inbox cap dropped before this request. */
  readonly eventsDropped: number;
  /** The agent's own state (proprioception), never other agents or the map's ground truth. */
  readonly self: SelfView;
  /** What the agent believes: entity beliefs and a map summary (never raw grids). */
  readonly beliefs: BeliefSummary;
  /** The topological summary of its own map (ADR-0039 §2). */
  readonly space: SpaceSummary;
  /** What it may start now, by name, with each parameter schema from the capability manifest. */
  readonly allowedActions: readonly AllowedAction[];
  /** What it may not start now, by name, with the code the start check would answer (same predicate). */
  readonly unavailable: readonly UnavailableAction[];
}

export interface SelfView {
  readonly kind: "ugv" | "uav";
  readonly xM: number;
  readonly yM: number;
  readonly zM?: number;
  readonly headingRad: number;
  readonly soc: number;
  /** The action running now, or none. */
  readonly running: { readonly actionId: string; readonly name: string; readonly phase: string } | null;
  /** Active timers set by this agent's mind, by tag (at most 8), with the sim seconds left (rounded to 0.01). */
  readonly timers: readonly { readonly tag: string; readonly dueInS: number }[];
  /** The agent's notebook (ADR-0036 addition of 2026-10-29): what its mind wrote with `note`, at most 2,000 characters. Absent while it is empty, so a request of a run that never notes is as it was. */
  readonly notebook?: string;
  /** The agent's task list (ADR-0005 addition of 2026-11-08): the steps its mind wrote with `task`, each with the status the world keeps. Absent while there is no list, so a request of a run that never writes one is as it was. */
  readonly task?: TaskView;
}

/** The status of a task step. The world sets it, never the mind: `pending` until an action is bound to the step, `running` while that action runs, then `done` or `failed` from the action's outcome. */
export type TaskStatus = "pending" | "running" | "done" | "failed";

/** A step as a mind writes it with `task`: what it is and, optionally, the action and parameters it stands for. */
export interface TaskStepSpec {
  readonly text: string;
  readonly action?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The `task` bookkeeping operation that may accompany any decision: the steps replace the agent's list, every status starting again. */
export interface TaskOp {
  readonly steps: readonly TaskStepSpec[];
}

/** One step of the list as a request shows it: the spec and the status. `actionId` is the action bound to it, once there is one. */
export interface TaskStepView extends TaskStepSpec {
  readonly status: TaskStatus;
  readonly actionId?: string;
}

/** How the last step ended: `refused` is an action the start check rejected, `preempted` one another action or a reflex ended. */
export interface TaskOutcome {
  readonly step: number;
  readonly status: "done" | "failed" | "refused" | "preempted";
  readonly action: string;
  readonly code?: string;
}

/** The task list of an agent, as a request shows it. `running` is the step (1-based) whose action runs now. */
export interface TaskView {
  readonly steps: readonly TaskStepView[];
  readonly running?: number;
  readonly last?: TaskOutcome;
}

/** F1 decisions: start a base action, or stay idle until the next event. Plans, policies and protocol moves follow. */
export type Decision =
  | { readonly kind: "action"; readonly name: string; readonly params: unknown }
  | { readonly kind: "idle" };

/**
 * Timer bookkeeping that may accompany any decision, including `idle` (ADR-0005 addition of 2026-10-09): applied in the
 * brain phase before the decision's action. The parameters are those of the `setTimer` / `cancelTimer` capabilities.
 */
export type TimerOp = { readonly op: "set"; readonly tag: string; readonly delayS: number } | { readonly op: "cancel"; readonly tag: string };

/** The notebook operation that may accompany any decision (the `note` capability): applied in the brain phase after the timers, before the decision's action. */
export interface NoteOp {
  readonly text: string;
  readonly mode: "replace" | "append";
}

export interface DecisionEnvelope {
  readonly decision: Decision;
  readonly timers?: readonly TimerOp[];
  readonly note?: NoteOp;
  /** The task list the answer writes (the `task` capability): applied after the notebook, before the decision's action. */
  readonly task?: TaskOp;
  /** The step (1-based) the answer's action works on: the world binds the action it starts to that step. */
  readonly step?: number;
  /** The mind turned its answer into `continue`: the running action goes on. The world writes `continued: true` and this action id into the decision record. */
  readonly continued?: { readonly actionId: string };
  /** What an S2 mind says of how it decided (attempts, usage, whether it fell back): the world writes it into the decision record, under `mind`. */
  readonly mind?: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly rationale?: string;
  /** A mission's mind (`sequence`) says which step this decision is, or how the mission ended; the world writes it into the decision record (`step`, `of`, `done`, `stop`). */
  readonly mission?: MissionNote;
}

export type BrainTier = "S1" | "S2" | "baseline" | "script" | "external";

/**
 * What the world gives a mind besides the request, for a mind that writes records of its own (an LLM mind writes one per model call): the id of the request's record, which its records name as their
 * parent, and the trace sink. A mind that writes nothing (a script) ignores it.
 */
export interface DecideContext {
  readonly requestRecordId?: string;
  readonly trace?: TraceSink;
  /** Answers a compute tool the mind asked for (ADR-0014 addition of 2026-10-29) from the agent's own map, as of the request's tick; absent where the run has no compute tools. */
  readonly compute?: ComputeCaller;
}

/** What one compute call came to: the result as the tool's schema describes it (with the `status` and the `expansions` the record keeps apart), or a refusal with a stable code. */
export type ComputeOutcome =
  | { readonly ok: true; readonly result: Readonly<Record<string, unknown>>; readonly status: string; readonly expansions: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The compute tools of one request: validated parameters in, outcome out; never throws for a bad call. */
export type ComputeCaller = (tool: string, params: unknown) => ComputeOutcome;

/** What the world asks the layer above core for to answer a mind's compute calls for an agent's request (the request carries the space summary of its tick). */
export interface ComputePort {
  call(agentId: string, tool: string, params: unknown, req: DecisionRequest): ComputeOutcome;
}

/** A mind that keeps state a snapshot must carry, as plain data (an LLM mind: what it has used of its limits). */
export interface StatefulBrain extends Brain {
  snapshotState(): unknown;
  restoreState(state: unknown): void;
}

export interface Brain {
  readonly id: string;
  readonly tier: BrainTier;
  /** The mind's wake policy (ADR-0005 addition of 2026-11-08): `all` (absent means this) asks at every event; `task` lets perception events wait while an action runs. */
  readonly wake?: "all" | "task";
  decide(req: DecisionRequest, ctx?: DecideContext): Promise<DecisionEnvelope>;
}

export interface ScriptStep {
  readonly name: string;
  readonly params: unknown;
}

/** Events that end or start an action: the only ones a script moves on at. */
const SCRIPT_ADVANCES = new Set(["start", "actionCompleted", "actionFailed", "actionRejected"]);

/**
 * A fixed sequence of actions, for testing without minds and as a baseline. It moves on to its next step only
 * when a request carries `start`, `actionCompleted`, `actionFailed` or `actionRejected`; any other event
 * (perception, battery, timers) leaves the running action alone (`idle`, the script does not advance). Once its
 * steps are exhausted it stays idle. Holds no randomness and no clock.
 */
export class ScriptBrain implements Brain {
  readonly tier = "script" as const;
  private cursor = 0;

  constructor(
    readonly id: string,
    private readonly steps: readonly ScriptStep[],
  ) {}

  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    if (!req.events.some((e) => SCRIPT_ADVANCES.has(e.kind))) return Promise.resolve({ decision: { kind: "idle" } });
    const step = this.steps[this.cursor];
    if (!step) return Promise.resolve({ decision: { kind: "idle" } });
    this.cursor++;
    return Promise.resolve({ decision: { kind: "action", name: step.name, params: step.params } });
  }

  /** Steps already returned (part of the run state: a fork must restore it). */
  get position(): number {
    return this.cursor;
  }

  /** Puts the position back (a restore of a snapshot). */
  restorePosition(position: number): void {
    if (!Number.isInteger(position) || position < 0 || position > this.steps.length) throw new RangeError(`script position ${position} of ${this.steps.length} steps`);
    this.cursor = position;
  }
}
