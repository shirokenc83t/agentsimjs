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

export interface DecisionEnvelope {
  readonly decision: Decision;
  readonly timers?: readonly TimerOp[];
  readonly confidence?: number;
  readonly rationale?: string;
  /** A mission's mind (`sequence`) says which step this decision is, or how the mission ended; the world writes it into the decision record (`step`, `of`, `done`, `stop`). */
  readonly mission?: MissionNote;
}

export type BrainTier = "S1" | "S2" | "baseline" | "script" | "external";

export interface Brain {
  readonly id: string;
  readonly tier: BrainTier;
  decide(req: DecisionRequest): Promise<DecisionEnvelope>;
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
