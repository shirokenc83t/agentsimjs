import { drainBattery } from "../body/battery.ts";
import { stepDrive } from "../body/drive.ts";
import { PathFollower, type FollowerParams, type FollowerSnapshot, type PathSegment } from "../body/follower.ts";
import { stepUavTowards, type UavState } from "../body/kinematics.ts";
import { cos, sin } from "../numerics/detmath/index.ts";
import { contentHash64 } from "../numerics/content-hash.ts";
import type { AllowedAction, UnavailableAction } from "../world/mind-view.ts";


import { err, ok, type CodedError, type Result } from "../result.ts";
import { agentPosition, type SimAgent, type UavBodyParams } from "./agent.ts";
import type { Pose, Reflex, ReflexTrigger } from "../reflexes/reflex.ts";
import type { CapabilityPort, ContactPort, FrontierCandidate, FrontierPort, PlanLeg, PlanMap, PlannerPort, PlanProgress, PlanResult, ProximityPort, Scope, SpatialPort, TraceSink } from "./ports.ts";
import { predictTracking, type PredriveOutcome } from "./predrive.ts";

/** Action lifecycle (ROADMAP appendix): running → succeeded | failed(reason) | preempted. */
export type ActionStatus = "running" | "succeeded" | "failed" | "preempted";

/** A failure with a stable code from tools-schema (capability-specific or common). */
export type ActionFailure = CodedError<string>;

export interface ActionInfo {
  readonly actionId: string;
  readonly agentId: string;
  readonly name: string;
  readonly status: ActionStatus;
  /** Sub-state while running (e.g. goTo: planning, following). */
  readonly phase: string;
  readonly startedTick: number;
  readonly endedTick?: number;
  readonly failure?: ActionFailure;
  readonly result?: unknown;
}

/** An action that ended, for the world's event delivery (ADR-0005 addition): taken once per tick. */
export interface EndedAction {
  readonly agentId: string;
  readonly actionId: string;
  readonly name: string;
  readonly status: "succeeded" | "failed" | "preempted";
  /** Failure or preemption code. */
  readonly code?: string;
  readonly result?: unknown;
}

/** Why an action cannot be started now, before its parameters matter (the single start-time availability predicate). */
export interface Unavailable {
  readonly code: string;
  readonly message: string;
  /** For `precondition_failed`: the precondition that does not hold. */
  readonly requires?: string;
}

export interface Caller {
  readonly scope: Scope;
  /** Agent ID of a self-scoped caller (the agent's own mind). */
  readonly id: string;
}

export interface RuntimePorts {
  readonly planner: PlannerPort;
  readonly spatial: SpatialPort;
  readonly capabilities: CapabilityPort;
  readonly trace: TraceSink;
  /** Always-on reflexes, in priority order (first trigger wins). None = no reflexes. */
  readonly reflexes?: readonly Reflex[];
  /** Latest proximity readings (F2): what the obstacle reflex acts on. None = the reflex never sees anything. */
  readonly proximity?: ProximityPort;
  /** Where contact observations go (F2): the touched cells become believed occupied. */
  readonly contact?: ContactPort;
  /** Each agent's frontier groups and unreachable marks (F2, ADR-0039): `explore`, and goTo's marking. */
  readonly frontiers?: FrontierPort;
}

type NamedTrigger = ReflexTrigger & { readonly reflex: string };

type Step =
  | { readonly kind: "running" }
  | { readonly kind: "succeeded"; readonly result: unknown }
  | { readonly kind: "failed"; readonly failure: ActionFailure }
  | { readonly kind: "reflex"; readonly trigger: NamedTrigger };

/** Asks the reflexes whether the body may move from `from` to `to`; a trigger vetoes the move. */
type MoveGuard = (ctx: TickCtx, from: Pose, to: Pose, planMap: PlanMap | undefined) => NamedTrigger | undefined;
const RUNNING: Step = { kind: "running" };

/** Recovery limits (ADR-0033): straight reverse in 0.25 m steps up to 3 m, at most 3 back-offs per goTo. */
const BACKOFF_STEP_M = 0.25;
const MAX_BACKOFF_M = 3;
const MAX_RECOVERIES = 3;
/** A back-off reverse stops precisely (it is short), when driven and when checked. */
const BACKOFF_TOLERANCE_M = 0.05;
/** Neighbour order of the escape search (E, NE, N, NW, W, SW, S, SE): fixed, so the search is deterministic. */
const ESCAPE_DIRS: readonly (readonly [number, number])[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const fail = (code: string, message: string): Step => ({ kind: "failed", failure: { code, message } });

interface TickCtx {
  readonly tick: number;
  readonly simTime: number;
  readonly dtS: number;
}

/** One running action instance. `step` advances it by one tick (body motion included). */
interface Behavior {
  phase: string;
  step(ctx: TickCtx): Step;
  /** Called once when the action ends for any reason (cancel planning, stop the body). */
  stop(simTime: number): void;
  /** The behaviour's run state as plain data (ADR-0035 addition of 2026-10-17, item 8). */
  snapshot(): BehaviorSnapshot;
}

interface Active {
  readonly info: { actionId: string; agentId: string; name: string; startedTick: number };
  readonly behavior: Behavior;
}

// ---- Snapshots (F3a M1, T-004; ADR-0035 addition of 2026-10-17, item 8) ---------------------------------------------------
// What a running action keeps between ticks, as plain data for the snapshot codec. Closures over the runtime's context
// (`note`, `guard`, the unreachable marker, the navigation of explore) are not captured: restore builds them again from the
// ports, as starting the action does. Start-time checks are not repeated on restore: they judged the state at the start.

export interface HoldSnapshot {
  readonly kind: "hold";
  readonly phase: string;
  /** Duration in ticks (Infinity for an open hold). */
  readonly ticks: number;
  readonly held: number;
}

export interface TakeoffSnapshot {
  readonly kind: "takeoff";
  readonly phase: string;
  /** Where the climb started: it rises straight up from here. */
  readonly x: number;
  readonly y: number;
  readonly altitudeM: number;
}

export interface LandSnapshot {
  readonly kind: "land";
  readonly phase: string;
}

export interface GoToSnapshot {
  readonly kind: "goTo";
  readonly phase: string;
  readonly tx: number;
  readonly ty: number;
  readonly cruise: number;
  readonly returning: boolean;
  /** The planner query in flight; the planning service's own snapshot holds the query. */
  readonly queryId: string | undefined;
  readonly follower: FollowerSnapshot | undefined;
  readonly backingOff: boolean;
  readonly recoveries: number;
  /** A plan exists: its map is the agent's live planning view, taken again from the planner on restore. */
  readonly hasPlanMap: boolean;
  readonly uavPath: readonly (readonly [number, number])[];
  readonly uavIndex: number;
  readonly planVersion: number;
  readonly replans: number;
  readonly excursionPeakM: number;
  readonly legsPending: boolean;
  readonly holdStartS: number | undefined;
  readonly predictedEnd: PredriveOutcome["end"] | undefined;
}

export interface ExploreSnapshot {
  readonly kind: "explore";
  readonly phase: string;
  readonly region: string | undefined;
  readonly strategy: "nearest" | "largest";
  readonly inner: GoToSnapshot | undefined;
  readonly target: FrontierCandidate | undefined;
  readonly markable: boolean;
  readonly visited: number;
  readonly marked: number;
  readonly distanceM: number;
  readonly waitedS: number;
  /** Strikes per frontier cell, ascending by cell. */
  readonly strikes: readonly (readonly [number, number])[];
  /** Frontier cells skipped for the rest of the action, ascending. */
  readonly skipped: readonly number[];
}

export type BehaviorSnapshot = HoldSnapshot | TakeoffSnapshot | LandSnapshot | GoToSnapshot | ExploreSnapshot;

/** What an `ActionRuntime` keeps between ticks. Taken between ticks only: nothing may be waiting to be delivered as an ended action. */
export interface RuntimeSnapshot {
  readonly nextAction: number;
  /** The running behaviour of each agent, by agent ID. */
  readonly active: readonly { readonly agentId: string; readonly info: Active["info"]; readonly behavior: BehaviorSnapshot }[];
  /** Each agent's current or latest action, by agent ID. */
  readonly last: readonly ActionInfo[];
  readonly recovering: readonly string[];
  /** The state of the reflexes that keep any, by reflex name. */
  readonly reflexes: Readonly<Record<string, unknown>>;
}

/** A hold: stays put for a number of ticks (forever when open). */
class HoldBehavior implements Behavior {
  phase = "holding";

  constructor(
    private readonly agent: SimAgent,
    private readonly dtS: number,
    private readonly ticks: number,
    private held = 0,
  ) {}

  step(): Step {
    if (this.agent.kind === "ugv") this.agent.state.speed = 0;
    this.held++;
    return this.held >= this.ticks ? { kind: "succeeded", result: { heldS: this.held * this.dtS } } : RUNNING;
  }

  stop(): void {}

  snapshot(): HoldSnapshot {
    return { kind: "hold", phase: this.phase, ticks: this.ticks, held: this.held };
  }
}

/** A takeoff: climbs straight up from where it started to `altitudeM`. */
class TakeoffBehavior implements Behavior {
  phase = "climbing";

  constructor(
    private readonly s: UavState,
    private readonly b: UavBodyParams,
    private readonly x: number,
    private readonly y: number,
    private readonly altitudeM: number,
  ) {}

  step(ctx: TickCtx): Step {
    this.s.airborne = true;
    return stepUavTowards(this.s, this.b, this.x, this.y, this.altitudeM, ctx.dtS) ? { kind: "succeeded", result: { altitudeM: this.s.z } } : RUNNING;
  }

  stop(): void {}

  snapshot(): TakeoffSnapshot {
    return { kind: "takeoff", phase: this.phase, x: this.x, y: this.y, altitudeM: this.altitudeM };
  }
}




/**
 * Executes base actions for physical agents (F1 d5). Deterministic: no wall clock, no randomness; one
 * call to `tick` per agent per sim tick, in sorted agent order (the world drives it). A new action
 * preempts the running one. Every start, rejection, phase change, end and diagnostic is traced with
 * source `<agent>/actions` (ADR-0031).
 */
export class ActionRuntime {
  private nextAction = 1;
  private readonly active = new Map<string, Active>();
  private readonly last = new Map<string, ActionInfo>();
  private ended: EndedAction[] = [];
  private manifestHashCache: string | undefined;
  /** Agents whose running action is a reflex recovery: their minds are not asked until it ends. */
  private readonly recovering = new Set<string>();

  constructor(
    private readonly ports: RuntimePorts,
    private readonly dtS: number,
  ) {}

  /** Whether a researcher may inject `name` as a world-scope command (the closed set of ADR-0015's 2026-10-12 addition). */
  isInjectable(name: string): boolean {
    return this.ports.capabilities.injectable(name);
  }

  /**
   * Starts `name` on `agent` for `caller`; returns the action ID, or the stable reason it was rejected.
   * Base actions are `self` scope: any other caller gets `scope_denied` (ADR-0015). The researcher's world-scope
   * commands use `startInjected`, which only the world's input phase calls.
   */
  start(agent: SimAgent, name: string, params: unknown, caller: Caller, tick: number, simTime: number): Result<string, ActionFailure> {
    return this.begin(agent, name, params, caller, tick, simTime, undefined);
  }

  /**
   * World-scope injected command (ADR-0015 clarification of 2026-10-04): starts a base action on the agent's
   * behalf through the normal start checks except the self-scope one, and preempts the running action like
   * any new action. The start record names the caller and the run input. Never reachable by minds: the world
   * calls it only from its input phase, for recorded run inputs.
   */
  startInjected(agent: SimAgent, name: string, params: unknown, inputId: string, tick: number, simTime: number): Result<string, ActionFailure> {
    return this.begin(agent, name, params, { scope: "world", id: "world" }, tick, simTime, inputId);
  }

  private begin(agent: SimAgent, name: string, params: unknown, caller: Caller, tick: number, simTime: number, inputId: string | undefined): Result<string, ActionFailure> {
    const rejected = this.checkStart(agent, name, params, caller, inputId !== undefined);
    if (rejected) {
      this.emit(agent, simTime, "full", { op: "rejected", name, params, failure: rejected, ...(inputId === undefined ? {} : { caller: "world", inputId }) });
      return err(rejected);
    }
    const behavior = this.createBehavior(agent, name, params as Record<string, unknown>);
    if (!behavior.ok) {
      this.emit(agent, simTime, "full", { op: "rejected", name, params, failure: behavior.error });
      return err(behavior.error);
    }
    // Replaced by the agent's own next decision: no event (it asked for it). A world command raises one.
    this.end(agent, tick, simTime, { kind: "preempted", reason: "replaced", ...(inputId === undefined ? { silent: true } : {}) });
    const actionId = `act-${String(this.nextAction++).padStart(6, "0")}`;
    this.active.set(agent.id, { info: { actionId, agentId: agent.id, name, startedTick: tick }, behavior: behavior.value });
    agent.odometerM = 0;
    this.last.set(agent.id, { actionId, agentId: agent.id, name, status: "running", phase: behavior.value.phase, startedTick: tick });
    this.emit(agent, simTime, "full", { op: "start", actionId, name, params, ...(inputId === undefined ? {} : { caller: "world", inputId }) });
    return ok(actionId);
  }

  /**
   * Common start checks, in a fixed order so the reported code is stable: the parameters, then the availability
   * predicate. Parameter-dependent refusals (target_blocked, landing_blocked, unknown_region, ...) come later, when the
   * behavior is created, on the agent's own map.
   */
  private checkStart(agent: SimAgent, name: string, params: unknown, caller: Caller, injected: boolean): ActionFailure | undefined {
    const v = this.ports.capabilities.validate(name, params);
    if (!v.ok) return { code: v.error.code, message: v.error.message };
    // Bookkeeping capabilities (timers) accompany a decision; they are not started as actions.
    if (this.ports.capabilities.kind(name) !== "action") return { code: "not_an_action", message: `${name} is not an action: it accompanies a decision` };
    if (injected && !this.ports.capabilities.injectable(name)) return { code: "not_injectable", message: `${name} cannot be injected as a researcher command` };
    const u = this.availability(agent, name, caller, injected);
    return u ? { code: u.code, message: u.message } : undefined;
  }

  /** Validates the parameters of a bookkeeping capability (timers) from a mind's decision: the tools-schema schema. */
  checkBookkeeping(name: string, params: unknown): Result<Record<string, unknown>, ActionFailure> {
    const v = this.ports.capabilities.validate(name, params);
    if (!v.ok) return err({ code: v.error.code, message: v.error.message });
    if (this.ports.capabilities.kind(name) !== "bookkeeping") return err({ code: "not_bookkeeping", message: `${name} is an action: it goes in the decision, not in timers` });
    return ok(v.value as Record<string, unknown>);
  }

  /**
   * The one start-time availability predicate (ADR-0005 addition of 2026-10-11): vehicle, scope, battery and
   * preconditions, in that order, for `name` on `agent` called by `caller`, independent of the parameters. Both the
   * start check and the menu offered to minds (`actionMenu`) use it, so what a mind is told it may do and what the
   * start check accepts cannot disagree.
   */
  availability(agent: SimAgent, name: string, caller: Caller, injected = false): Unavailable | undefined {
    const caps = this.ports.capabilities;
    if (!caps.vehicles(name).includes(agent.kind)) return { code: "vehicle_unsupported", message: `${name} is not available to ${agent.kind}` };
    const self = caps.scope(name) === "self" && caller.scope === "self" && caller.id === agent.id;
    // Injected: a self-scope base action started by the world on the agent's behalf (ADR-0015 clarification).
    const injectedBaseAction = injected && caller.scope === "world" && caps.scope(name) === "self";
    if (!self && !injectedBaseAction) {
      return { code: "scope_denied", message: `${name} can only be started by the agent itself` };
    }
    if (agent.battery.soc <= 0) return { code: "battery_depleted", message: "battery is empty" };
    for (const p of caps.preconditions(name)) {
      if (p.vehicles && !p.vehicles.includes(agent.kind)) continue;
      const holds = p.name === "airborne" ? agent.kind === "uav" && agent.state.airborne : p.name === "grounded" ? agent.kind === "uav" && !agent.state.airborne : p.name === "hasBase" ? agent.base !== undefined : p.name === "hasRangeSensor" ? (this.ports.frontiers?.hasRangeSensor(agent.id) ?? false) : false;
      if (!holds) return { code: "precondition_failed", message: `${name} requires ${p.name}`, requires: p.name };
    }
    return undefined;
  }

  /**
   * Hash of the capability menu (names and parameter schemas) a mind is offered: recorded with each request instead
   * of the schemas, which are a property of the simulator version (ADR-0005 addition of 2026-10-11).
   */
  manifestHash(): string {
    this.manifestHashCache ??= contentHash64(JSON.stringify([...this.ports.capabilities.list()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))));
    return this.manifestHashCache;
  }

  /**
   * What the agent's own mind may start now and what it may not (and why), from `availability`: both lists by
   * name. A mind is a `self` caller, so only self-scope capabilities are offered.
   */
  actionMenu(agent: SimAgent): { readonly allowed: AllowedAction[]; readonly unavailable: UnavailableAction[] } {
    const allowed: AllowedAction[] = [];
    const unavailable: UnavailableAction[] = [];
    const caller: Caller = { scope: "self", id: agent.id };
    for (const c of [...this.ports.capabilities.list()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (c.kind !== "action" || this.ports.capabilities.scope(c.name) !== "self") continue;
      const u = this.availability(agent, c.name, caller);
      if (!u) allowed.push({ name: c.name, paramsSchema: c.paramsSchema });
      else unavailable.push({ name: c.name, code: u.code, ...(u.requires === undefined ? {} : { requires: u.requires }) });
    }
    return { allowed, unavailable };
  }

  /** Preempts the agent's running action (reflexes, d6). */
  preempt(agent: SimAgent, reason: string, tick: number, simTime: number): void {
    this.end(agent, tick, simTime, { kind: "preempted", reason });
  }

  /** Advances the agent's action and body by one tick, then drains its battery. */
  tick(agent: SimAgent, tick: number, simTime: number): void {
    const a = this.active.get(agent.id);
    agent.state.lastStepM = 0;
    if (a) {
      const phase = a.behavior.phase;
      const s = a.behavior.step({ tick, simTime, dtS: this.dtS });
      if (a.behavior.phase !== phase) this.emit(agent, simTime, "transitions", { op: "phase", actionId: a.info.actionId, from: phase, to: a.behavior.phase });
      const prev = this.last.get(agent.id);
      if (prev && prev.status === "running") this.last.set(agent.id, { ...prev, phase: a.behavior.phase });
      if (s.kind === "succeeded") this.end(agent, tick, simTime, { kind: "succeeded", result: s.result });
      else if (s.kind === "failed") this.end(agent, tick, simTime, { kind: "failed", failure: s.failure });
      else if (s.kind === "reflex") this.applyReflex(agent, s.trigger, tick, simTime);
    } else if (agent.kind === "ugv") {
      agent.state.speed = 0;
    }
    agent.odometerM += agent.state.lastStepM;
    // Power: a UGV is always powered; a UAV draws hover power only when airborne.
    const powered = agent.kind === "ugv" || agent.state.airborne;
    // Reverse distance drains like forward distance; a rotation in place like footprint radius × angle (ADR-0033).
    const rotationM = agent.kind === "ugv" ? agent.body.footprintRadiusM * agent.state.lastRotationRad : 0;
    drainBattery(agent.battery, agent.body.battery, agent.body.energy, agent.state.lastStepM + rotationM, powered ? this.dtS : 0);
    if (agent.battery.soc <= 0 && this.active.has(agent.id)) this.end(agent, tick, simTime, { kind: "failed", failure: { code: "battery_depleted", message: "battery ran out" } });
    // State-based reflexes (battery) after the action step.
    const running = this.active.get(agent.id)?.info.name;
    for (const r of this.ports.reflexes ?? []) {
      const t = r.afterStep?.(this.reflexCtx(tick, simTime), agent, running);
      if (t) {
        this.applyReflex(agent, { ...t, reflex: r.name }, tick, simTime);
        break;
      }
    }
  }

  private reflexCtx(tick: number, simTime: number) {
    return { tick, simTime, dtS: this.dtS, spatial: this.ports.spatial, proximity: this.ports.proximity };
  }

  /** Before-move reflexes, in priority order. */
  private guard(ctx: TickCtx, from: Pose, to: Pose, planMap: PlanMap | undefined, agent: SimAgent): NamedTrigger | undefined {
    for (const r of this.ports.reflexes ?? []) {
      const t = r.beforeMove?.(this.reflexCtx(ctx.tick, ctx.simTime), agent, from, to, planMap);
      if (t) return { ...t, reflex: r.name };
    }
    return undefined;
  }

  /**
   * A reflex acted: traced (kind `reflex`, source `<agent>/reflexes`), the running action is preempted with
   * the reflex's code, and its recovery action, if any, is started on the agent's own behalf (onboard).
   */
  private applyReflex(agent: SimAgent, t: NamedTrigger, tick: number, simTime: number): void {
    const running = this.active.get(agent.id)?.info.actionId;
    this.ports.trace.emit({
      source: `${agent.id}/reflexes`,
      simTime,
      kind: "reflex",
      agentId: agent.id,
      detail: "full",
      payload: { reflex: t.reflex, code: t.code, message: t.message, ...(running ? { preemptedActionId: running } : {}), ...(t.then ? { then: t.then.name } : {}) },
    });
    this.end(agent, tick, simTime, { kind: "preempted", reason: t.message, code: t.code });
    if (t.then && this.start(agent, t.then.name, t.then.params, { scope: "self", id: agent.id }, tick, simTime).ok) this.recovering.add(agent.id);
  }

  /** Actions that ended since the last call, in order of ending (events for minds, ADR-0005 addition). */
  takeEnded(): EndedAction[] {
    const out = this.ended;
    this.ended = [];
    return out;
  }

  /** The running action is a reflex recovery (no decision request is made while it runs). */
  isRecovering(agentId: string): boolean {
    return this.recovering.has(agentId);
  }

  /** The agent's current or most recent action. */
  info(agentId: string): ActionInfo | undefined {
    return this.last.get(agentId);
  }

  isRunning(agentId: string): boolean {
    return this.active.has(agentId);
  }

  private end(
    agent: SimAgent,
    tick: number,
    simTime: number,
    how: { kind: "succeeded"; result: unknown } | { kind: "failed"; failure: ActionFailure } | { kind: "preempted"; reason: string; code?: string; silent?: boolean },
  ): void {
    const a = this.active.get(agent.id);
    if (!a) return;
    this.active.delete(agent.id);
    this.recovering.delete(agent.id);
    a.behavior.stop(simTime);
    if (agent.kind === "ugv") agent.state.speed = 0;
    const base = { ...a.info, phase: a.behavior.phase, endedTick: tick };
    const info: ActionInfo =
      how.kind === "succeeded"
        ? { ...base, status: "succeeded", result: how.result }
        : how.kind === "failed"
          ? { ...base, status: "failed", failure: how.failure }
          : { ...base, status: "preempted", failure: { code: how.code ?? "preempted", message: how.reason } };
    this.last.set(agent.id, info);
    if (!(how.kind === "preempted" && how.silent)) {
      this.ended.push({
        agentId: agent.id,
        actionId: a.info.actionId,
        name: a.info.name,
        status: how.kind,
        ...(how.kind === "failed" ? { code: how.failure.code } : how.kind === "preempted" ? { code: how.code ?? "preempted" } : {}),
        ...(how.kind === "succeeded" ? { result: how.result } : {}),
      });
    }
    this.emit(agent, simTime, "full", {
      op: "end",
      actionId: a.info.actionId,
      name: a.info.name,
      status: info.status,
      ...(info.failure ? { failure: info.failure } : {}),
      ...(how.kind === "succeeded" ? { result: how.result } : {}),
    });
  }

  private emit(agent: SimAgent, simTime: number, detail: "full" | "transitions", payload: unknown): void {
    this.ports.trace.emit({ source: `${agent.id}/actions`, simTime, kind: "action", agentId: agent.id, detail, payload });
  }

  // ---- behaviors -------------------------------------------------------------------------------------

  private createBehavior(agent: SimAgent, name: string, p: Record<string, unknown>): Result<Behavior, ActionFailure> {
    switch (name) {
      case "goTo":
        return this.goTo(agent, p["xM"] as number, p["yM"] as number, p["altitudeM"] as number | undefined, false);
      case "returnToBase": {
        const b = agent.base;
        if (!b) return err({ code: "precondition_failed", message: "returnToBase requires hasBase" });
        return this.goTo(agent, b.xM, b.yM, undefined, true);
      }
      case "hold":
        return ok(this.hold(agent, p["durationS"] as number | undefined));
      case "takeoff":
        return this.takeoff(agent, p["altitudeM"] as number);
      case "land":
        return this.land(agent);
      case "explore":
        return this.explore(agent, p["region"] as string | undefined, (p["strategy"] as "nearest" | "largest" | undefined) ?? "nearest");
      default:
        return err({ code: "unknown_capability", message: `no behavior for ${name}` });
    }
  }

  private hold(agent: SimAgent, durationS: number | undefined): Behavior {
    const ticks = durationS === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.ceil(durationS / this.dtS - 1e-9));
    return new HoldBehavior(agent, this.dtS, ticks);
  }

  private takeoff(agent: SimAgent, altitudeM: number): Result<Behavior, ActionFailure> {
    if (agent.kind !== "uav") return err({ code: "vehicle_unsupported", message: "takeoff is UAV only" });
    const { x, y } = agent.state;
    const lim = this.ports.spatial.altitudeLimitsM; // mission data
    // Start-time check on the agent's own map, never ground truth (ADR-0005; F2 audit of 2026-10-10).
    if (altitudeM < lim.min || altitudeM > lim.max || !this.ports.planner.knownSpace(agent.id).freeForAir(x, y, altitudeM, agent.body.clearanceM)) {
      return err({ code: "altitude_out_of_range", message: `cannot hover at ${altitudeM} m here (airspace ${lim.min}–${lim.max} m)` });
    }
    return ok(new TakeoffBehavior(agent.state, agent.body, x, y, altitudeM));
  }

  /**
   * A descent that touched an obstacle (physics, ground truth, at the moment it happens): the UAV stays at its last
   * free altitude; a traced collision, a contact observation, and the action fails with `collision`.
   */
  private descentContact(agent: SimAgent, ctx: TickCtx, cells: readonly number[], lastFreeZ: number): Step {
    if (agent.kind !== "uav") return RUNNING;
    const s = agent.state;
    const zM = s.z;
    const speedMps = s.lastStepM / ctx.dtS;
    s.z = lastFreeZ;
    s.lastStepM = 0;
    this.ports.trace.emit({
      source: `${agent.id}/body`,
      simTime: ctx.simTime,
      kind: "event",
      agentId: agent.id,
      detail: "full",
      payload: { op: "collision", cells: [...cells], xM: s.x, yM: s.y, zM, speedMps },
    });
    this.ports.contact?.contact(agent.id, cells, zM, ctx.simTime);
    return fail("collision", "the vehicle touched an obstacle while descending");
  }

  private land(agent: SimAgent): Result<Behavior, ActionFailure> {
    if (agent.kind !== "uav") return err({ code: "vehicle_unsupported", message: "land is UAV only" });
    const s = agent.state;
    // Start-time check on the agent's own map (ADR-0005; F2 audit of 2026-10-10): a landing site it believes free.
    if (!this.ports.planner.knownSpace(agent.id).landable(s.x, s.y)) return err({ code: "landing_blocked", message: "the ground below is believed occupied" });
    return ok(this.landBehavior(agent));
  }

  /** The descent itself, without the start-time check (a restore builds it again as it was). It keeps nothing of its own. */
  private landBehavior(agent: SimAgent): Behavior {
    if (agent.kind !== "uav") throw new Error("land is UAV only");
    const s = agent.state;
    const b = agent.body;
    const behavior: Behavior = {
      phase: "descending",
      step: (ctx) => {
        // The descent ends on the real ground (physics, read as it happens); touching an obstacle is a collision.
        const ground = this.ports.spatial.groundHeightM(s.x, s.y);
        const z = s.z;
        const done = stepUavTowards(s, b, s.x, s.y, ground, ctx.dtS);
        const touched = this.ports.spatial.contactCells(s.x, s.y, s.z, b.footprintRadiusM, "uav");
        if (touched.length > 0) return this.descentContact(agent, ctx, touched, z);
        if (!done) return RUNNING;
        s.airborne = false;
        return { kind: "succeeded", result: { position: { xM: s.x, yM: s.y, zM: s.z } } };
      },
      stop: () => {},
      snapshot: () => ({ kind: "land", phase: behavior.phase }),
    };
    return behavior;
  }

  /** goTo and returnToBase (which lands a UAV on arrival). */
  private goTo(agent: SimAgent, tx: number, ty: number, altitudeM: number | undefined, returning: boolean): Result<Behavior, ActionFailure> {
    const sp = this.ports.spatial;
    if (!sp.inBounds(tx, ty)) return err({ code: "target_out_of_bounds", message: "target is outside the map" });
    let cruise = 0;
    if (agent.kind === "ugv") {
      if (altitudeM !== undefined) return err({ code: "invalid_params", message: "ground vehicles take no altitudeM" });
      // Start-time checks on the agent's own map, never ground truth (ADR-0005; F2 audit of 2026-10-10): a target on
      // a wall it has not seen is accepted; the plan crosses unknown cells and the wall is discovered on the way.
      if (!this.ports.planner.knownSpace(agent.id).freeForGround(tx, ty)) return err({ code: "target_blocked", message: "the target is believed not drivable" });
      // Footprint fit is judged on the agent's own map (ADR-0005), like every onboard decision below.
      const fp = agent.body.footprintRadiusM;
      if (this.ports.planner.currentMap(agent.id).clearanceM(tx, ty, fp) < fp) return err({ code: "target_blocked", message: "the vehicle's footprint does not fit at the target" });
    } else {
      cruise = altitudeM ?? (returning ? agent.body.cruiseAltitudeM : agent.state.z);
      const lim = sp.altitudeLimitsM;
      if (cruise < lim.min || cruise > lim.max) return err({ code: "altitude_out_of_range", message: `altitude ${cruise} m outside ${lim.min}–${lim.max} m` });
      if (!this.ports.planner.knownSpace(agent.id).freeForAir(tx, ty, cruise, agent.body.clearanceM)) return err({ code: "target_blocked", message: "the target is believed not free at that altitude" });
    }
    // A goTo towards a frontier group's point that is unreachable (or fails the pre-drive check) marks the group
    // for this agent (ADR-0039 §1 and its addition of 2026-10-10).
    return ok(this.goToFor(agent, tx, ty, cruise, returning, this.markerFor(agent, tx, ty)));
  }

  /** A goTo wired to this runtime's context: its trace notes, the reflex guard, and what to do when the target is unreachable. */
  private goToFor(agent: SimAgent, tx: number, ty: number, cruise: number, returning: boolean, onUnreachable: ((simTime: number) => void) | undefined): GoToBehavior {
    return new GoToBehavior(this.ports, agent, tx, ty, cruise, returning, (t, payload) => this.emit(agent, t, "full", payload), (ctx, from, to, map) => this.guard(ctx, from, to, map, agent), onUnreachable);
  }

  /** A goTo towards a frontier group's point that is unreachable marks the group for this agent (ADR-0039 §1). */
  private markerFor(agent: SimAgent, tx: number, ty: number): ((simTime: number) => void) | undefined {
    const frontiers = this.ports.frontiers;
    return frontiers ? (simTime: number) => void frontiers.markAt(agent.id, tx, ty, simTime) : undefined;
  }

  /** explore (ADR-0039 addition of 2026-10-10): frontier targets on the agent's own map, reached by goTo navigation. */
  private explore(agent: SimAgent, region: string | undefined, strategy: "nearest" | "largest"): Result<Behavior, ActionFailure> {
    const frontiers = this.ports.frontiers;
    if (!frontiers) return err({ code: "unknown_capability", message: "explore needs the agent's frontier layer" });
    if (region !== undefined && !frontiers.hasRegion(agent.id, region)) return err({ code: "unknown_region", message: `no region ${region}` });
    return ok(this.exploreFor(frontiers, agent, region, strategy));
  }

  /** The explore behaviour wired to this runtime's context; its goTo navigation keeps the cruise altitude the action started with. */
  private exploreFor(frontiers: FrontierPort, agent: SimAgent, region: string | undefined, strategy: "nearest" | "largest"): ExploreBehavior {
    const note = (t: number, payload: unknown) => this.emit(agent, t, "full", payload);
    const cruise = agent.kind === "uav" ? agent.state.z : 0;
    return new ExploreBehavior(frontiers, agent, region, strategy, note, (tx, ty, onMarkable, cruiseOverride) => this.goToFor(agent, tx, ty, cruiseOverride ?? cruise, false, onMarkable));
  }

  // ---- snapshot and restore (F3a M1, T-004; ADR-0035 addition of 2026-10-17, item 8) ----------------------------------

  /**
   * The runtime's state between ticks as plain data: the action counter, each agent's running behaviour and latest action,
   * the agents in a reflex recovery, and the state of the reflexes that keep any (the battery latch). It refuses if ended
   * actions are still waiting for the world to take them: a snapshot is taken after the tick's events were collected.
   */
  snapshot(): RuntimeSnapshot {
    if (this.ended.length > 0) throw new Error("cannot snapshot an action runtime with ended actions not yet taken (snapshots are taken between ticks)");
    const reflexes: Record<string, unknown> = {};
    for (const r of this.ports.reflexes ?? []) if (r.snapshot) reflexes[r.name] = r.snapshot();
    const byId = <T extends readonly [string, unknown]>(a: T, b: T): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return {
      nextAction: this.nextAction,
      active: [...this.active].sort(byId).map(([agentId, a]) => ({ agentId, info: { ...a.info }, behavior: a.behavior.snapshot() })),
      last: [...this.last].sort(byId).map(([, i]) => ({ ...i })),
      recovering: [...this.recovering].sort(),
      reflexes,
    };
  }

  /**
   * Puts a snapshot back in place, binding each behaviour to the agent objects of `agents` (shared with sensing, topology and
   * the host, so they are not replaced). Behaviours are built again without their start-time checks, with the context
   * closures this runtime gives a new action. Restore the planner (and the maps) first: a goTo takes the map of its plan from it.
   */
  restore(s: RuntimeSnapshot, agents: readonly SimAgent[]): void {
    const byId = new Map(agents.map((a) => [a.id, a]));
    this.nextAction = s.nextAction;
    this.active.clear();
    for (const a of s.active) {
      const agent = byId.get(a.agentId);
      if (!agent) throw new RangeError(`snapshot has an action of unknown agent ${a.agentId}`);
      this.active.set(a.agentId, { info: { ...a.info }, behavior: this.restoreBehavior(agent, a.behavior) });
    }
    this.last.clear();
    for (const i of s.last) this.last.set(i.agentId, { ...i });
    this.ended = [];
    this.recovering.clear();
    for (const id of s.recovering) this.recovering.add(id);
    for (const r of this.ports.reflexes ?? []) if (r.restore) r.restore(s.reflexes[r.name]);
  }

  private restoreBehavior(agent: SimAgent, snap: BehaviorSnapshot): Behavior {
    switch (snap.kind) {
      case "hold": {
        const b = new HoldBehavior(agent, this.dtS, snap.ticks, snap.held);
        b.phase = snap.phase;
        return b;
      }
      case "takeoff": {
        if (agent.kind !== "uav") throw new RangeError(`snapshot has a takeoff for ${agent.id}, which is not a UAV`);
        const b = new TakeoffBehavior(agent.state, agent.body, snap.x, snap.y, snap.altitudeM);
        b.phase = snap.phase;
        return b;
      }
      case "land": {
        const b = this.landBehavior(agent);
        b.phase = snap.phase;
        return b;
      }
      case "goTo": {
        const b = this.goToFor(agent, snap.tx, snap.ty, snap.cruise, snap.returning, this.markerFor(agent, snap.tx, snap.ty));
        b.restoreFrom(snap);
        return b;
      }
      case "explore": {
        const frontiers = this.ports.frontiers;
        if (!frontiers) throw new RangeError("snapshot has an explore action but the runtime has no frontier layer");
        const b = this.exploreFor(frontiers, agent, snap.region, snap.strategy);
        b.restoreFrom(snap);
        return b;
      }
    }
  }
}

/** Strikes after which a frontier group is skipped for the rest of an explore action (2026-10-10). */
const EXPLORE_STRIKES = 3;
/** Sim seconds explore waits for a first reading of the agent's own position before failing `no_map_data`. */
const EXPLORE_PERCEPTION_WAIT_S = 2;

/**
 * explore (ADR-0039 addition of 2026-10-10). Repeatedly selects a frontier group of the agent's own map and reaches
 * its point with goTo navigation; reselects on arrival, or when the group stops being a frontier (seen on the way).
 * - `unreachable`, or `kinematically_infeasible` from the pre-drive check, marks the group (agent state) and
 *   counts a strike for its cells; a group whose cells all have 3 strikes is skipped until the action ends.
 * - `planning_budget` skips the group for the rest of the action.
 * - Scope limits targets, not paths; an unexplored region is approached through the group nearest to it.
 * - Every selection is traced. Ends `region_explored` or `frontier_exhausted`; other failures end it.
 */
class ExploreBehavior implements Behavior {
  phase = "selecting";
  private inner: GoToBehavior | undefined;
  private target: FrontierCandidate | undefined;
  private markable = false;
  private visited = 0;
  private marked = 0;
  private distanceM = 0;
  /** Sim seconds spent waiting for a first reading of the agent's own position. */
  private waitedS = 0;
  private readonly strikes = new Map<number, number>();
  private readonly skipped = new Set<number>();

  constructor(
    private readonly frontiers: FrontierPort,
    private readonly agent: SimAgent,
    private readonly region: string | undefined,
    private readonly strategy: "nearest" | "largest",
    private readonly note: (simTime: number, payload: unknown) => void,
    /** Builds the goTo towards a target; `cruiseOverride` is for a restore, which gives the inner goTo the cruise altitude it had. */
    private readonly navigate: (tx: number, ty: number, onMarkable: (simTime: number) => void, cruiseOverride?: number) => GoToBehavior,
  ) {}

  stop(simTime: number): void {
    this.inner?.stop(simTime);
  }

  snapshot(): ExploreSnapshot {
    return {
      kind: "explore",
      phase: this.phase,
      region: this.region,
      strategy: this.strategy,
      inner: this.inner?.snapshot(),
      target: this.target ? { ...this.target, cells: [...this.target.cells] } : undefined,
      markable: this.markable,
      visited: this.visited,
      marked: this.marked,
      distanceM: this.distanceM,
      waitedS: this.waitedS,
      strikes: [...this.strikes].sort((a, b) => a[0] - b[0]),
      skipped: [...this.skipped].sort((a, b) => a - b),
    };
  }

  /** Puts a snapshot back in place; the inner goTo is built again by `navigate`, with the marker that sets `markable`. */
  restoreFrom(s: ExploreSnapshot): void {
    this.phase = s.phase;
    this.target = s.target ? { ...s.target, cells: [...s.target.cells] } : undefined;
    this.markable = s.markable;
    this.visited = s.visited;
    this.marked = s.marked;
    this.distanceM = s.distanceM;
    this.waitedS = s.waitedS;
    this.strikes.clear();
    for (const [cell, n] of s.strikes) this.strikes.set(cell, n);
    this.skipped.clear();
    for (const cell of s.skipped) this.skipped.add(cell);
    if (s.inner) {
      const inner = this.navigate(s.inner.tx, s.inner.ty, () => {
        this.markable = true;
      }, s.inner.cruise);
      inner.restoreFrom(s.inner);
      this.inner = inner;
    } else this.inner = undefined;
  }

  step(ctx: TickCtx): Step {
    const a = this.agent;
    if (!this.inner) {
      const end = this.select(ctx);
      if (end) return end;
    }
    const inner = this.inner;
    const target = this.target;
    if (!inner || !target) return RUNNING;
    // The target was resolved by sensing on the way (no longer a frontier): pick the next one.
    if (inner.phase !== "planning" && !this.frontiers.isFrontier(a.id, target.point)) {
      inner.stop(ctx.simTime);
      this.inner = undefined;
      this.visited++;
      this.phase = "selecting";
      return RUNNING;
    }
    const s = inner.step(ctx);
    this.phase = inner.phase;
    this.distanceM += a.state.lastStepM;
    if (s.kind === "running" || s.kind === "reflex") return s;
    inner.stop(ctx.simTime);
    this.inner = undefined;
    this.phase = "selecting";
    if (s.kind === "succeeded") {
      this.visited++;
      return RUNNING;
    }
    const code = s.failure.code;
    if (this.markable) {
      // Unreachable for this vehicle: marked (agent state), and a strike for each of its cells.
      this.markable = false;
      if (this.frontiers.markAt(a.id, target.xM, target.yM, ctx.simTime)) this.marked++;
      for (const c of target.cells) {
        const n = (this.strikes.get(c) ?? 0) + 1;
        this.strikes.set(c, n);
        if (n >= EXPLORE_STRIKES) this.skipped.add(c);
      }
      return RUNNING;
    }
    if (code === "planning_budget") {
      for (const c of target.cells) this.skipped.add(c);
      return RUNNING;
    }
    return s;
  }

  private isSkipped(c: FrontierCandidate): boolean {
    return c.cells.every((cell) => this.skipped.has(cell));
  }

  /** Selects the next target and starts navigating to it, or returns the end of the action. */
  private select(ctx: TickCtx): Step | undefined {
    const a = this.agent;
    const all = this.frontiers.candidates(a.id).filter((c) => !this.isSkipped(c));
    const inScope = this.region === undefined ? all : all.filter((c) => c.region === this.region);
    let pick: FrontierCandidate | undefined;
    let approach = false;
    if (inScope.length > 0) pick = this.choose(inScope);
    else if (this.region !== undefined && all.length > 0 && this.frontiers.regionHasReachableUnknown(a.id, this.region, a.state.x, a.state.y)) {
      // A region not seen yet: approach it through the group nearest to its rectangle.
      const r = this.frontiers.regionRect(a.id, this.region);
      if (r) {
        approach = true;
        pick = nearestBy(all, (c) => distToRect(c.xM, c.yM, r));
      }
    }
    const skippedCount = this.frontiers.candidates(a.id).length - all.length;
    // Before its first reading an agent knows nothing, so it has no frontier yet: that is not exhaustion. It waits
    // until its own position is known on its map; if it still is not after EXPLORE_PERCEPTION_WAIT_S, the action
    // fails `no_map_data` (its sensors read nothing): never a success with frontier_exhausted.
    if (!pick && !this.frontiers.isKnown(a.id, a.state.x, a.state.y)) {
      if (this.waitedS < EXPLORE_PERCEPTION_WAIT_S - 1e-9) {
        this.waitedS += ctx.dtS;
        this.phase = "awaiting-perception";
        return undefined;
      }
      this.note(ctx.simTime, { op: "explore-end", reason: "no_map_data", waitedS: this.waitedS });
      return fail("no_map_data", `no map data at the agent's own position after ${EXPLORE_PERCEPTION_WAIT_S} s`);
    }
    if (!pick) {
      // A region ends explored when other frontiers remain (none in it, nothing reachable left to approach) or it has
      // no reachable unknown cells; with no frontier left anywhere, exploration is exhausted.
      const reason =
        this.region === undefined ? "frontier_exhausted" : all.length > 0 || !this.frontiers.regionHasReachableUnknown(a.id, this.region, a.state.x, a.state.y) ? "region_explored" : "frontier_exhausted";
      this.note(ctx.simTime, { op: "explore-end", reason, candidates: all.length, marked: this.frontiers.markedCount(a.id), skipped: skippedCount });
      return { kind: "succeeded", result: { reason, groupsVisited: this.visited, groupsMarked: this.marked, distanceM: this.distanceM, position: agentPosition(a) } };
    }
    this.note(ctx.simTime, {
      op: "explore-target",
      strategy: this.strategy,
      group: pick.point,
      region: pick.region,
      ...(approach ? { approach: this.region } : {}),
      candidates: inScope.length,
      marked: this.frontiers.markedCount(a.id),
      skipped: skippedCount,
    });
    this.target = pick;
    this.markable = false;
    this.inner = this.navigate(pick.xM, pick.yM, () => {
      this.markable = true;
    });
    this.phase = this.inner.phase;
    return undefined;
  }

  private choose(cands: readonly FrontierCandidate[]): FrontierCandidate | undefined {
    const a = this.agent;
    const d2 = (c: FrontierCandidate) => (c.xM - a.state.x) * (c.xM - a.state.x) + (c.yM - a.state.y) * (c.yM - a.state.y);
    if (this.strategy === "nearest") return nearestBy(cands, d2);
    let best: FrontierCandidate | undefined;
    for (const c of cands) {
      if (!best || c.cells.length > best.cells.length || (c.cells.length === best.cells.length && (d2(c) < d2(best) || (d2(c) === d2(best) && c.id < best.id)))) best = c;
    }
    return best;
  }
}

/** The candidate with the smallest key, ties by ID (deterministic). */
function nearestBy(cands: readonly FrontierCandidate[], key: (c: FrontierCandidate) => number): FrontierCandidate | undefined {
  let best: FrontierCandidate | undefined;
  let bestK = Number.POSITIVE_INFINITY;
  for (const c of cands) {
    const k = key(c);
    if (k < bestK || (k === bestK && best !== undefined && c.id < best.id)) {
      best = c;
      bestK = k;
    }
  }
  return best;
}

/** Squared distance from a point to a rectangle (0 inside). */
function distToRect(x: number, y: number, r: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }): number {
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
  const dy = y < r.y0 ? r.y0 - y : y > r.y1 ? y - r.y1 : 0;
  return dx * dx + dy * dy;
}

/**
 * goTo: plan (simulated planning time per ADR-0024), check a UGV can start along the path (forward-only
 * turn-around needs a free turning circle), then follow it. Replans when the world changed under the
 * remaining path. A UGV that cannot make progress fails `kinematically_infeasible` (distinct from
 * `unreachable`: a path exists, the vehicle cannot follow it).
 */
class GoToBehavior implements Behavior {
  phase = "planning";
  private queryId: string | undefined;
  private follower: PathFollower | undefined;
  private backingOff = false;
  private recoveries = 0;

  private planMap: PlanMap | undefined;
  private uavPath: (readonly [number, number])[] = [];
  private uavIndex = 0;
  private planVersion = -1;
  private replans = 0;
  private excursionPeakM = 0;
  /** A lazy plan (ADR-0037 fourth addition): legs are still being planned while the action moves. */
  private legsPending = false;
  /** Sim time a hold at the end of the last ready leg began (lazy plans only); undefined while not holding. */
  private holdStartS: number | undefined;
  /** Where the pre-drive check of the last accepted leg ended: the next leg is checked from there. */
  private predictedEnd: PredriveOutcome["end"] | undefined;

  constructor(
    private readonly ports: RuntimePorts,
    private readonly agent: SimAgent,
    private readonly tx: number,
    private readonly ty: number,
    private readonly cruise: number,
    private readonly returning: boolean,
    private readonly note: (simTime: number, payload: unknown) => void,
    private readonly guard: MoveGuard,
    /** Called when the target turns out unreachable for this vehicle: no path, or the pre-drive check failed. */
    private readonly onUnreachable?: (simTime: number) => void,
  ) {}

  stop(simTime: number): void {
    // A query exists while planning, and for a lazy plan while it moves too; for an eager one it is gone once its path arrived.
    if (this.queryId !== undefined) this.ports.planner.cancel(this.agent.id);
    this.flushExcursion(simTime);
  }

  snapshot(): GoToSnapshot {
    return {
      kind: "goTo",
      phase: this.phase,
      tx: this.tx,
      ty: this.ty,
      cruise: this.cruise,
      returning: this.returning,
      queryId: this.queryId,
      follower: this.follower?.snapshot(),
      backingOff: this.backingOff,
      recoveries: this.recoveries,
      hasPlanMap: this.planMap !== undefined,
      uavPath: this.uavPath.map(([x, y]) => [x, y] as const),
      uavIndex: this.uavIndex,
      planVersion: this.planVersion,
      replans: this.replans,
      excursionPeakM: this.excursionPeakM,
      legsPending: this.legsPending,
      holdStartS: this.holdStartS,
      predictedEnd: this.predictedEnd ? { ...this.predictedEnd } : undefined,
    };
  }

  /**
   * Puts a snapshot back in place (the action's parameters, tx, ty, cruise and returning, are the constructor's). The
   * plan's map is the agent's live planning view, asked from the planner again (a UAV's at its cruise altitude).
   */
  restoreFrom(s: GoToSnapshot): void {
    const a = this.agent;
    this.phase = s.phase;
    this.queryId = s.queryId;
    if (s.follower) {
      if (a.kind !== "ugv") throw new RangeError(`snapshot has a path follower for ${a.id}, which is not a UGV`);
      this.follower = PathFollower.restore(s.follower, a.body as FollowerParams);
    } else this.follower = undefined;
    this.backingOff = s.backingOff;
    this.recoveries = s.recoveries;
    this.planMap = s.hasPlanMap ? this.ports.planner.currentMap(a.id, a.kind === "uav" ? this.cruise : undefined) : undefined;
    this.uavPath = s.uavPath.map(([x, y]) => [x, y] as const);
    this.uavIndex = s.uavIndex;
    this.planVersion = s.planVersion;
    this.replans = s.replans;
    this.excursionPeakM = s.excursionPeakM;
    this.legsPending = s.legsPending;
    this.holdStartS = s.holdStartS;
    this.predictedEnd = s.predictedEnd ? { ...s.predictedEnd } : undefined;
  }

  /**
   * Reports an excursion still open when the action ends, at the time it ends: records keep sim-time order
   * (the last tracking sample can be older than records written since, e.g. a replan).
   */
  private flushExcursion(simTime: number): void {
    const a = this.agent;
    if (a.kind !== "ugv" || this.excursionPeakM <= 0) return;
    this.note(simTime, { op: "diagnostic", code: "tracking_error_exceeds_margin", peakInwardM: this.excursionPeakM, marginM: a.body.trackingMarginM });
    this.excursionPeakM = 0;
  }

  step(ctx: TickCtx): Step {
    const a = this.agent;
    switch (this.phase) {
      case "planning":
        return this.stepPlanning(ctx);
      case "climbing": {
        if (a.kind !== "uav") return RUNNING;
        const early = this.pollLegs(ctx);
        if (early) return early;
        a.state.airborne = true;
        if (stepUavTowards(a.state, a.body, a.state.x, a.state.y, this.cruise, ctx.dtS)) this.phase = "following";
        return RUNNING;
      }
      case "following":
      case "backing-off":
        return a.kind === "ugv" ? this.followUgv(ctx) : this.followUav(ctx);
      case "landing": {
        if (a.kind !== "uav") return RUNNING;
        // The descent ends on the real ground (physics); touching an obstacle on the way down is a collision.
        const ground = this.ports.spatial.groundHeightM(a.state.x, a.state.y);
        const z = a.state.z;
        const done = stepUavTowards(a.state, a.body, a.state.x, a.state.y, ground, ctx.dtS);
        const touched = this.ports.spatial.contactCells(a.state.x, a.state.y, a.state.z, a.body.footprintRadiusM, "uav");
        if (touched.length > 0) {
          const speedMps = a.state.lastStepM / ctx.dtS;
          const zM = a.state.z;
          a.state.z = z;
          a.state.lastStepM = 0;
          return this.collide(ctx, touched, zM, speedMps);
        }
        if (!done) return RUNNING;
        a.state.airborne = false;
        return this.success(true);
      }
      default:
        return RUNNING;
    }
  }

  private stepPlanning(ctx: TickCtx): Step {
    const a = this.agent;
    const planner = this.ports.planner;
    if (this.queryId === undefined) {
      // Back-off (ADR-0033): a reverse-capable UGV inside its own planning clearance (the planner would see
      // its start as blocked) first reverses straight until it is clear, then plans.
      if (a.kind === "ugv" && a.body.reverseAllowed && this.recoveries < MAX_RECOVERIES) {
        const map = planner.currentMap(a.id);
        const inflation = a.body.footprintRadiusM + a.body.trackingMarginM;
        if (map.clearanceM(a.state.x, a.state.y, inflation) < inflation) {
          const backoff = this.findBackoff(map, ctx, (end) => map.clearanceM(end[0], end[1], inflation + 0.05) >= inflation + 0.05);
          if (backoff) return this.startBackoff(backoff, ctx, "inside_planning_clearance");
          this.note(ctx.simTime, { op: "recovery", kind: "back-off", reason: "inside_planning_clearance", ok: false });
          // Escape (ADR-0033 addition of 2026-10-12): no straight reverse leaves the band (a wall found from close by
          // lines the whole strip), so look for a short path whose clearance never decreases until it is outside.
          const escape = this.findEscape(map, ctx);
          if (escape) return this.startEscape(escape, ctx, "inside_planning_clearance");
          // Neither a clear reverse nor an escape (bare footprint, on the agent's map) gets it out: it cannot plan from
          // here, and it does not move.
          this.note(ctx.simTime, { op: "recovery", kind: "escape", reason: "inside_planning_clearance", ok: false });
          return fail("kinematically_infeasible", "too close to obstacles to plan, and neither a clear straight reverse nor an escape path gets the vehicle out");
        }
      }
      const q = planner.submit(a.id, { from: { x: a.state.x, y: a.state.y }, to: { x: this.tx, y: this.ty }, ...(a.kind === "uav" ? { cruiseAltitudeM: this.cruise } : {}) }, ctx.tick);
      // Configuration errors are rejected when the run starts (ADR-0028); an endpoint outside the
      // planner's map is the only refusal expected here.
      if (!q.ok) return fail(q.error.code === "invalid_endpoint" ? "unreachable" : q.error.code, q.error.message);
      this.queryId = q.value;
      this.planVersion = planner.currentMap(a.id).version;
      return RUNNING;
    }
    // A lazy plan hands out its legs as they complete; every other query has none and is taken whole, as ever.
    const progress = planner.takeLegs?.(a.id, this.queryId);
    if (progress) return this.onProgress(progress, ctx);
    const r = planner.take(a.id, this.queryId);
    if (!r) return RUNNING;
    this.queryId = undefined;
    if (r.status === "not_found") {
      this.onUnreachable?.(ctx.simTime);
      return fail("unreachable", "no path to the target");
    }
    if (r.status === "budget_exceeded") return fail("planning_budget", `planning exceeded its budget (${r.expansionsCharged} expansions)`);
    return this.beginFollowing(r, ctx);
  }

  private beginFollowing(r: PlanResult, ctx: TickCtx): Step {
    const a = this.agent;
    this.planMap = r.map;
    const pts: number[] = [a.state.x, a.state.y];
    for (const [x, y] of r.waypoints.slice(1)) pts.push(x, y);
    if (pts.length === 2) pts.push(this.tx, this.ty);
    if (a.kind === "uav") {
      this.uavPath = [];
      for (let k = 2; k < pts.length; k += 2) this.uavPath.push([pts[k] ?? 0, pts[k + 1] ?? 0]);
      this.uavIndex = 0;
      this.phase = Math.abs(a.state.z - this.cruise) > 1e-9 || !a.state.airborne ? "climbing" : "following";
      return RUNNING;
    }
    const path = Float64Array.from(pts);
    // Pre-drive check on the plan's map (never ground truth): the same follower and drive model, the same
    // time step. It covers turn-arounds, rotations in place and corners too tight for the vehicle.
    // Costs no sim time and no expansions (model choice, ADR-0024 clarification of 2026-10-04).
    const forward: PathSegment = { pts: path, reverse: false };
    const check = predictTracking([forward], a.state, a.body, a.body.footprintRadiusM, ctx.dtS, r.map);
    this.note(ctx.simTime, {
      op: "predrive",
      ok: check.ok,
      predictedMinClearanceM: check.predictedMinClearanceM,
      mapVersion: r.map.version,
      ...(check.reason ? { reason: check.reason } : {}),
    });
    if (!check.ok) {
      // Recovery (ADR-0033): a bounded straight reverse whose end, followed by this path, passes the check;
      // drive it, then replan from there.
      if (a.body.reverseAllowed && this.recoveries < MAX_RECOVERIES) {
        const backoff = this.findBackoff(r.map, ctx, (end) => {
          const resumed: PathSegment = { pts: Float64Array.from([end[0], end[1], ...pts.slice(2)]), reverse: false };
          const reverse: PathSegment = { pts: Float64Array.from([a.state.x, a.state.y, end[0], end[1]]), reverse: true };
          return predictTracking([reverse, resumed], a.state, a.body, a.body.footprintRadiusM, ctx.dtS, r.map).ok;
        });
        if (backoff) return this.startBackoff(backoff, ctx, "predrive_failed");
      }
      this.onUnreachable?.(ctx.simTime);
      const why = check.reason === "contact" ? "the footprint would touch an obstacle" : check.reason === "no_progress" ? "it would make no progress" : "it would not arrive";
      return fail("kinematically_infeasible", `a path exists but this vehicle cannot follow it: ${why}`);
    }
    this.backingOff = false;
    this.follower = new PathFollower([forward], a.body);
    this.planVersion = r.map.version;
    this.phase = "following";
    return RUNNING;
  }

  /** Cancels a lazy query that is still planning legs; a no-op for any other (its query is gone once its path arrived). */
  /** A lazy plan's vehicle has reached the end of the last ready leg and waits for the next: traced once, so hold time is measurable ex post. */
  private beginHold(simTime: number): void {
    if (this.holdStartS !== undefined) return;
    this.holdStartS = simTime;
    this.note(simTime, { op: "hold", state: "start", ...(this.queryId === undefined ? {} : { queryId: this.queryId }) });
  }

  private endHold(simTime: number, reason: "leg" | "query_ended" | "interrupted" | "replan"): void {
    if (this.holdStartS === undefined) return;
    this.note(simTime, { op: "hold", state: "end", reason, heldS: Math.round((simTime - this.holdStartS) * 1e6) / 1e6, ...(this.queryId === undefined ? {} : { queryId: this.queryId }) });
    this.holdStartS = undefined;
  }

  private dropQuery(): void {
    if (this.queryId !== undefined) this.ports.planner.cancel(this.agent.id);
    this.queryId = undefined;
    this.legsPending = false;
  }

  /**
   * While moving on a lazy plan: takes the legs that became ready (and the end of the query). Returns a Step when the action
   * must end or start planning again, undefined to go on following.
   */
  private pollLegs(ctx: TickCtx): Step | undefined {
    if (this.queryId === undefined) return undefined;
    const p = this.ports.planner.takeLegs?.(this.agent.id, this.queryId);
    if (!p) return undefined;
    const s = this.onProgress(p, ctx);
    return s.kind !== "running" || this.phase === "planning" ? s : undefined;
  }

  /** The legs of a lazy plan that became ready, and how the query stands (ADR-0037 fourth addition). */
  private onProgress(p: PlanProgress, ctx: TickCtx): Step {
    if (p.interrupted) {
      // The planner ended the query because the map changed after a leg was handed out: replan from where the vehicle is.
      // The legs already driven are kept (the new query starts here); the ones ahead are stale.
      this.replans++;
      this.note(ctx.simTime, { op: "replan", reason: "map_changed", replans: this.replans, mapVersion: p.map.version, interrupted: true, ...(this.queryId === undefined ? {} : { queryId: this.queryId }) });
      this.endHold(ctx.simTime, "interrupted");
      this.queryId = undefined;
      this.legsPending = false;
      this.follower = undefined;
      this.uavPath = [];
      this.uavIndex = 0;
      this.backingOff = false;
      this.phase = "planning";
      return RUNNING;
    }
    for (const leg of p.legs) {
      const s = this.acceptLeg(leg, p.map, ctx);
      if (s.kind !== "running") return s;
    }
    if (p.done) {
      if (p.status !== undefined && p.status !== "found") this.endHold(ctx.simTime, "query_ended");
      this.queryId = undefined;
      this.legsPending = false;
      if (p.status === "not_found") {
        this.onUnreachable?.(ctx.simTime);
        return fail("unreachable", "no path to the target");
      }
      if (p.status === "budget_exceeded") return fail("planning_budget", `planning exceeded its budget (${p.expansionsCharged} expansions)`);
    }
    return RUNNING;
  }

  /**
   * One leg of a lazy plan: the first starts the movement as `beginFollowing` does for a whole path; later ones are appended
   * to the path being followed. Each leg is checked before it is driven, a UGV's from the predicted end pose of the previous
   * leg's check (so the chain depends on the legs only); a UAV has no pre-drive check.
   */
  private acceptLeg(leg: PlanLeg, map: PlanMap, ctx: TickCtx): Step {
    const a = this.agent;
    this.planMap = map;
    this.note(ctx.simTime, { op: "leg", index: leg.index, count: leg.count, last: leg.last, tick: leg.tick, mapVersion: map.version, ...(this.queryId === undefined ? {} : { queryId: this.queryId }) });
    this.endHold(ctx.simTime, "leg");
    const first = leg.index === 0;
    const ahead = leg.waypoints.slice(1);
    if (a.kind === "uav") {
      if (first) {
        this.uavPath = [];
        this.uavIndex = 0;
        this.phase = Math.abs(a.state.z - this.cruise) > 1e-9 || !a.state.airborne ? "climbing" : "following";
      }
      for (const [x, y] of ahead) this.uavPath.push([x, y]);
      this.legsPending = !leg.last;
      return RUNNING;
    }
    const pts: number[] = first ? [a.state.x, a.state.y] : [];
    for (const [x, y] of ahead) pts.push(x, y);
    if (first && pts.length === 2) pts.push(this.tx, this.ty);
    // The check runs along the leg alone: from the vehicle for the first, from the previous leg's predicted end for the others.
    const checked: PathSegment = { pts: Float64Array.from(first ? pts : leg.waypoints.flatMap(([x, y]) => [x, y])), reverse: false };
    const from = first || !this.predictedEnd ? a.state : { ...this.predictedEnd, lastStepM: 0, lastRotationRad: 0 };
    const check = predictTracking([checked], from, a.body, a.body.footprintRadiusM, ctx.dtS, map);
    this.note(ctx.simTime, {
      op: "predrive",
      leg: leg.index,
      ok: check.ok,
      predictedMinClearanceM: check.predictedMinClearanceM,
      mapVersion: map.version,
      ...(check.reason ? { reason: check.reason } : {}),
    });
    if (!check.ok) {
      this.dropQuery(); // the rest of the plan is not wanted
      if (first && a.body.reverseAllowed && this.recoveries < MAX_RECOVERIES) {
        // The vehicle has not moved: the eager recovery (a bounded reverse, then plan again from there).
        const backoff = this.findBackoff(map, ctx, (end) => {
          const resumed: PathSegment = { pts: Float64Array.from([end[0], end[1], ...pts.slice(2)]), reverse: false };
          const reverse: PathSegment = { pts: Float64Array.from([a.state.x, a.state.y, end[0], end[1]]), reverse: true };
          return predictTracking([reverse, resumed], a.state, a.body, a.body.footprintRadiusM, ctx.dtS, map).ok;
        });
        if (backoff) return this.startBackoff(backoff, ctx, "predrive_failed");
      }
      this.onUnreachable?.(ctx.simTime);
      const why = check.reason === "contact" ? "the footprint would touch an obstacle" : check.reason === "no_progress" ? "it would make no progress" : "it would not arrive";
      return fail("kinematically_infeasible", first ? `a path exists but this vehicle cannot follow it: ${why}` : `leg ${leg.index} of the plan cannot be followed by this vehicle: ${why}`);
    }
    this.predictedEnd = check.end;
    if (first) {
      this.backingOff = false;
      this.follower = new PathFollower([{ pts: Float64Array.from(pts), reverse: false }], a.body);
      this.planVersion = map.version;
      this.phase = "following";
    } else this.follower?.append(Float64Array.from(ahead.flatMap(([x, y]) => [x, y])));
    this.legsPending = !leg.last;
    return RUNNING;
  }

  /**
   * Shortest straight reverse (0.25 m steps up to MAX_BACKOFF_M) that is itself drivable on `map` and whose
   * end satisfies `good`, or undefined.
   */
  private findBackoff(map: PlanMap, ctx: TickCtx, good: (end: readonly [number, number]) => boolean): readonly [number, number] | undefined {
    const a = this.agent;
    if (a.kind !== "ugv") return undefined;
    const s = a.state;
    const ux = cos(s.heading);
    const uy = sin(s.heading);
    for (let r = BACKOFF_STEP_M; r <= MAX_BACKOFF_M + 1e-9; r += BACKOFF_STEP_M) {
      const end: readonly [number, number] = [s.x - ux * r, s.y - uy * r];
      const reverse: PathSegment = { pts: Float64Array.from([s.x, s.y, end[0], end[1]]), reverse: true };
      // Checked before it is executed: the bare footprint along the reverse, on the agent's map (ADR-0033 §4).
      if (!predictTracking([reverse], s, { ...a.body, arrivalToleranceM: BACKOFF_TOLERANCE_M }, a.body.footprintRadiusM, ctx.dtS, map).ok) return undefined; // further back is blocked too
      if (good(end)) return end;
    }
    return undefined;
  }

  /**
   * Escape from the planning band (ADR-0033 addition of 2026-10-12), on the agent's own map: breadth-first over a 0.25 m
   * lattice around the vehicle (8-connected, fixed order), within 3 m, through points whose bare footprint is free and
   * whose clearance never decreases, to the first point outside the band (clearance ≥ planning clearance + 0.05 m); the
   * fewest steps, ties to the larger clearance, then the lower lattice index. The path must also pass the pre-drive check
   * with the bare footprint. Returns the path (start first) or undefined. Runs only when the vehicle is already stuck.
   */
  private findEscape(map: PlanMap, ctx: TickCtx): readonly [number, number][] | undefined {
    const a = this.agent;
    if (a.kind !== "ugv") return undefined;
    const s = a.state;
    const foot = a.body.footprintRadiusM;
    const goal = foot + a.body.trackingMarginM + 0.05;
    const cap = goal + 0.5;
    const R = Math.round(MAX_BACKOFF_M / BACKOFF_STEP_M);
    const N = 2 * R + 1;
    const clearance = new Float64Array(N * N).fill(Number.NaN);
    const at = (dx: number, dy: number): number => {
      const k = (dy + R) * N + (dx + R);
      let c = clearance[k] as number;
      if (Number.isNaN(c)) {
        c = map.clearanceM(s.x + dx * BACKOFF_STEP_M, s.y + dy * BACKOFF_STEP_M, cap);
        clearance[k] = c;
      }
      return c;
    };
    if (at(0, 0) < foot) return undefined; // the bare footprint already touches an obstacle on this map: nothing to escape to
    const parent = new Int32Array(N * N).fill(-2);
    const start = R * N + R;
    parent[start] = -1;
    let level: number[] = [start];
    let found: number | undefined;
    while (level.length > 0 && found === undefined) {
      const next: number[] = [];
      for (const k of level) {
        const dx = (k % N) - R;
        const dy = Math.floor(k / N) - R;
        const here = at(dx, dy);
        for (const [ex, ey] of ESCAPE_DIRS) {
          const nx = dx + ex;
          const ny = dy + ey;
          if (Math.abs(nx) > R || Math.abs(ny) > R || Math.sqrt(nx * nx + ny * ny) * BACKOFF_STEP_M > MAX_BACKOFF_M + 1e-9) continue;
          const nk = (ny + R) * N + (nx + R);
          if (parent[nk] !== -2) continue;
          const c = at(nx, ny);
          if (c < foot || c < here - 1e-9) continue; // bare footprint must be free, clearance never decreases
          if (ex !== 0 && ey !== 0 && (at(dx + ex, dy) < foot || at(dx, dy + ey) < foot)) continue; // no corner cutting
          parent[nk] = k;
          next.push(nk);
          if (c >= goal && (found === undefined || c > at((found % N) - R, Math.floor(found / N) - R) + 1e-9 || (Math.abs(c - at((found % N) - R, Math.floor(found / N) - R)) <= 1e-9 && nk < found))) found = nk;
        }
      }
      level = next;
    }
    if (found === undefined) return undefined;
    const path: [number, number][] = [];
    for (let k = found; k !== -1; k = parent[k] as number) path.push([s.x + ((k % N) - R) * BACKOFF_STEP_M, s.y + (Math.floor(k / N) - R) * BACKOFF_STEP_M]);
    path.reverse();
    path[0] = [s.x, s.y];
    const seg: PathSegment = { pts: Float64Array.from(path.flat()), reverse: false };
    // Checked before it is executed, as the back-off is: the bare footprint along it, on the agent's map.
    return predictTracking([seg], s, { ...a.body, arrivalToleranceM: BACKOFF_TOLERANCE_M }, foot, ctx.dtS, map).ok ? path : undefined;
  }

  private startEscape(path: readonly [number, number][], ctx: TickCtx, reason: string): Step {
    const a = this.agent;
    if (a.kind !== "ugv") return RUNNING;
    this.recoveries++;
    let distanceM = 0;
    for (let k = 1; k < path.length; k++) {
      const ddx = (path[k]?.[0] ?? 0) - (path[k - 1]?.[0] ?? 0);
      const ddy = (path[k]?.[1] ?? 0) - (path[k - 1]?.[1] ?? 0);
      distanceM += Math.sqrt(ddx * ddx + ddy * ddy);
    }
    this.note(ctx.simTime, {
      op: "recovery",
      kind: "escape",
      reason,
      cells: path.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
      distanceM,
      recoveries: this.recoveries,
    });
    this.follower = new PathFollower([{ pts: Float64Array.from(path.flat()), reverse: false }], { ...a.body, arrivalToleranceM: BACKOFF_TOLERANCE_M });
    this.backingOff = true;
    this.planVersion = this.ports.planner.currentMap(a.id).version;
    this.phase = "backing-off";
    return RUNNING;
  }

  private startBackoff(end: readonly [number, number], ctx: TickCtx, reason: string): Step {
    const a = this.agent;
    if (a.kind !== "ugv") return RUNNING;
    this.recoveries++;
    const dx = a.state.x - end[0];
    const dy = a.state.y - end[1];
    const distanceM = Math.sqrt(dx * dx + dy * dy);
    this.note(ctx.simTime, { op: "recovery", kind: "back-off", reason, distanceM, recoveries: this.recoveries });
    this.follower = new PathFollower([{ pts: Float64Array.from([a.state.x, a.state.y, end[0], end[1]]), reverse: true }], { ...a.body, arrivalToleranceM: BACKOFF_TOLERANCE_M });
    this.backingOff = true;
    this.planVersion = this.ports.planner.currentMap(a.id).version;
    this.phase = "backing-off";
    return RUNNING;
  }

  private followUgv(ctx: TickCtx): Step {
    const a = this.agent;
    if (a.kind !== "ugv" || !this.follower) return RUNNING;
    const early = this.pollLegs(ctx); // lazy plans: legs that became ready are appended before this tick's command
    if (early) return early;
    if (!this.follower) return RUNNING;
    const sp = this.ports.spatial;
    // Replan when the agent's own map changed under the remaining path (never on ground truth it hasn't seen).
    const map = this.ports.planner.currentMap(a.id);
    if (map.version !== this.planVersion && !this.remainingPathClear(map)) {
      this.replans++;
      this.note(ctx.simTime, { op: "replan", reason: "map_changed", replans: this.replans, mapVersion: map.version });
      this.endHold(ctx.simTime, "replan");
      this.dropQuery(); // a lazy plan still planning legs is cancelled; for an eager one nothing is pending
      this.follower = undefined;
      this.backingOff = false;
      this.phase = "planning";
      return RUNNING;
    }
    this.planVersion = map.version;
    const c = this.follower.update(a.state, ctx.dtS);
    if (c.arrived) {
      if (!this.backingOff) {
        if (this.legsPending) {
          // The end of the last ready leg: hold there (the follower has slowed to it as to a goal) until the next leg comes.
          this.beginHold(ctx.simTime);
          stepDrive(a.state, a.body, c, ctx.dtS);
          return RUNNING;
        }
        return this.success(false);
      }
      // Back-off done: plan again from here.
      this.backingOff = false;
      this.follower = undefined;
      this.phase = "planning";
      return RUNNING;
    }
    if (c.stuck) return fail("kinematically_infeasible", "no progress towards the goal within the vehicle's limits");
    const s = a.state;
    const x = s.x;
    const y = s.y;
    const h = s.heading;
    const steering = s.steering;
    stepDrive(s, a.body, c, ctx.dtS);
    // Reflexes see the proposed move first and may veto it (the body then stays put).
    const veto = this.guard(ctx, { x, y, z: 0 }, { x: s.x, y: s.y, z: 0 }, this.planMap);
    if (veto) {
      s.x = x;
      s.y = y;
      s.heading = h;
      s.steering = steering;
      s.speed = 0;
      s.lastStepM = 0;
      s.lastRotationRad = 0;
      return { kind: "reflex", trigger: veto };
    }
    const fp = a.body.footprintRadiusM;
    const touched = sp.contactCells(s.x, s.y, 0, fp, "ugv");
    if (touched.length > 0) {
      // Physical contact (ground truth): the body stops at its last collision-free pose; the step is undone.
      const speedMps = Math.abs(s.speed);
      s.x = x;
      s.y = y;
      s.heading = h;
      s.steering = steering;
      s.speed = 0;
      s.lastStepM = 0;
      s.lastRotationRad = 0;
      return this.collide(ctx, touched, 0, speedMps);
    }
    const clearance = sp.groundClearanceM(s.x, s.y, fp + a.body.trackingMarginM + 1);
    this.trackingDiagnostic(ctx.simTime, c.nearestX, c.nearestY, clearance);
    return RUNNING;
  }

  /**
   * A collision (ADR-0012 addition of 2026-10-09): a traced physical event from `<agent>/body` (the touched cells,
   * the position and the speed at contact), a contact observation for the agent's beliefs, and the action fails
   * with `collision`. Never prevented silently, never dropped.
   */
  private collide(ctx: TickCtx, cells: readonly number[], zM: number, speedMps: number): Step {
    const a = this.agent;
    const s = a.state;
    this.ports.trace.emit({
      source: `${a.id}/body`,
      simTime: ctx.simTime,
      kind: "event",
      agentId: a.id,
      detail: "full",
      payload: { op: "collision", cells: [...cells], xM: s.x, yM: s.y, zM, speedMps },
    });
    this.ports.contact?.contact(a.id, cells, zM, ctx.simTime);
    return fail("collision", "the vehicle touched an obstacle");
  }

  /**
   * Diagnostic (not a failure): the vehicle lost more clearance relative to its path than the tracking
   * margin covers. Traced once per excursion with its peak; reflexes are the backstop (d6).
   */
  private trackingDiagnostic(simTime: number, nx: number, ny: number, vehicleClearance: number): void {
    const a = this.agent;
    if (a.kind !== "ugv") return;
    const cap = a.body.footprintRadiusM + a.body.trackingMarginM + 1;
    const inward = this.ports.spatial.groundClearanceM(nx, ny, cap) - vehicleClearance;
    if (inward > a.body.trackingMarginM) {
      this.excursionPeakM = Math.max(this.excursionPeakM, inward);
    } else if (this.excursionPeakM > 0) {
      this.note(simTime, { op: "diagnostic", code: "tracking_error_exceeds_margin", peakInwardM: this.excursionPeakM, marginM: a.body.trackingMarginM });
      this.excursionPeakM = 0;
    }
  }

  /** On `map`, the planned path still ahead keeps the footprint clear of obstacles (sampled every 0.25 m). */
  private remainingPathClear(map: PlanMap): boolean {
    const a = this.agent;
    const p = this.follower?.currentSegment.pts;
    if (a.kind !== "ugv" || !p || !this.follower || this.backingOff) return true;
    const fp = a.body.footprintRadiusM;
    for (let k = 2 * this.follower.progressSegment; k + 3 < p.length; k += 2) {
      const ax = p[k] ?? 0;
      const ay = p[k + 1] ?? 0;
      const ex = (p[k + 2] ?? 0) - ax;
      const ey = (p[k + 3] ?? 0) - ay;
      const n = Math.max(1, Math.ceil(Math.sqrt(ex * ex + ey * ey) / 0.25));
      for (let i = 0; i <= n; i++) if (map.clearanceM(ax + (ex * i) / n, ay + (ey * i) / n, fp) < fp) return false;
    }
    return true;
  }

  private followUav(ctx: TickCtx): Step {
    const a = this.agent;
    if (a.kind !== "uav") return RUNNING;
    const early = this.pollLegs(ctx);
    if (early) return early;
    const target = this.uavPath[this.uavIndex];
    if (!target) {
      if (this.legsPending) {
        this.beginHold(ctx.simTime); // hover at the end of the ready waypoints until the next leg comes
        return RUNNING;
      }
      return this.returning ? this.beginLanding() : this.success(false);
    }
    const s = a.state;
    const x = s.x;
    const y = s.y;
    const z = s.z;
    const reached = stepUavTowards(s, a.body, target[0], target[1], this.cruise, ctx.dtS);
    const veto = this.guard(ctx, { x, y, z }, { x: s.x, y: s.y, z: s.z }, this.planMap);
    if (veto) {
      s.x = x;
      s.y = y;
      s.z = z;
      s.lastStepM = 0;
      return { kind: "reflex", trigger: veto };
    }
    const touched = this.ports.spatial.contactCells(s.x, s.y, s.z, a.body.footprintRadiusM, "uav");
    if (touched.length > 0) {
      const speedMps = s.lastStepM / ctx.dtS;
      const zM = s.z;
      s.x = x;
      s.y = y;
      s.z = z;
      s.lastStepM = 0;
      return this.collide(ctx, touched, zM, speedMps);
    }
    // Legal limits are not a collision: the geofence reflex keeps the UAV inside (this only fires without it).
    const lim = this.ports.spatial.altitudeLimitsM;
    if (!this.ports.spatial.insideFence(s.x, s.y, s.z) || s.z < lim.min || s.z > lim.max) {
      s.x = x;
      s.y = y;
      s.z = z;
      s.lastStepM = 0;
      return fail("geofence", "the UAV would leave a geofence or its altitude limits, or enter a no-fly volume");
    }
    if (reached) this.uavIndex++;
    return RUNNING;
  }

  private beginLanding(): Step {
    const a = this.agent;
    if (a.kind !== "uav") return RUNNING;
    // A decision before touching down, so on the agent's own map (F2 audit of 2026-10-10); touchdown itself is physics.
    if (!this.ports.planner.knownSpace(a.id).landable(a.state.x, a.state.y)) return fail("landing_blocked", "the base is believed occupied");
    this.phase = "landing";
    return RUNNING;
  }

  private success(landed: boolean): Step {
    const p = agentPosition(this.agent);
    return { kind: "succeeded", result: this.returning ? { position: p, landed } : { position: p, pathLengthM: this.agent.odometerM } };
  }
}
