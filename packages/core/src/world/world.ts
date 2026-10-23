import { hashAgent, type SimAgent } from "../actions/agent.ts";
import type { PlannerPort, TraceSink } from "../actions/ports.ts";
import type { ActionRuntime } from "../actions/runtime.ts";
import { contentHash64 } from "../numerics/content-hash.ts";
import { StateHasher } from "../numerics/state-hash.ts";
import type { Steppable, TickContext } from "../time/scheduler.ts";
import type { Scheduler } from "../time/scheduler.ts";
import type { Brain, DecisionEnvelope, DecisionRequest, SelfView, TimerOp } from "./brain.ts";
import { Inbox, isControl, type AgentEvent, type DecisionEvent, type InboxSnapshot } from "./events.ts";
import { EMPTY_MIND_VIEW, round2 as r2, round3 as r3, type MindViewPort } from "./mind-view.ts";

export interface WorldParts {
  /** Agents in ID order (the order of every per-agent phase). */
  readonly agents: readonly SimAgent[];
  readonly runtime: ActionRuntime;
  readonly planner: PlannerPort;
  readonly trace: TraceSink;
  /** The mind of each agent that has one; agents without a brain only run what the world starts. */
  readonly brains?: ReadonlyMap<string, Brain>;
  /**
   * The sensing phase (F2): after the actions of each tick, the due sensors observe the ground truth and update
   * the agents' beliefs (ADR-0012 addition of 2026-10-09). None = no sensors (F1 core tests).
   */
  readonly sensing?: {
    sense(tick: number, simTimeS: number): void;
    /** Beliefs are mutable agent state: they enter the state hash (F2 M2b). */
    hashInto?(h: StateHasher): void;
    /** Perception and discovery events of the tick just sensed (`detected`, `lost`, `frontierExhausted`), taken once. */
    takeEvents?(): AgentEvent[];
  };
  /**
   * Minimum sim time between decision requests for perception events (ADR-0005 addition; run configuration,
   * ADR-0028): default 1 s. Control events always request a decision at once.
   */
  readonly minDecisionIntervalS?: number;
  /** The beliefs and space parts of a request (F2 M2d), from the agent's own map. None = empty views (core tests). */
  readonly mindView?: MindViewPort;
  /**
   * Genesis (default true): at construction each agent with a brain gets a `start` event and its first decision request,
   * and both are traced. `false` builds the world as the target of a restore: none of that happens, and `restore` puts the
   * snapshot's inboxes, requests and timing in place (ADR-0035 addition of 2026-10-17, item 8).
   */
  readonly genesis?: boolean;
}

/** What a `World` keeps between ticks, as plain data (a snapshot: ADR-0035 addition of 2026-10-17, item 8). */
export interface WorldSnapshot {
  readonly tick: number;
  readonly simTimeS: number;
  /** The step of the last tick: timers and requests convert with it. */
  readonly dtS: number;
  /**
   * The state hash the last tick reported. It is taken before that tick's requests move the inbox's events into request
   * slots, so it cannot be recomputed from the state a snapshot leaves: it is captured as it was.
   */
  readonly stateHash: string;
  /** The hash of the state as the snapshot leaves it, recomputed by a restore: a different one means the parts do not agree. */
  readonly checkHash: string;
  /** The agents' mutable state, by agent ID order: body state, battery, odometer. Restored in place (the objects are shared). */
  readonly agents: readonly { readonly id: string; readonly state: Readonly<Record<string, number | boolean>>; readonly battery: { readonly soc: number }; readonly odometerM: number }[];
  readonly inboxes: readonly InboxSnapshot[];
  /** Sim time of each agent's previous request, -Infinity before the first. */
  readonly lastRequestS: readonly number[];
  readonly prevSoc: readonly number[];
  /** Active timers of each agent's mind: (tag, due tick), sorted by tag. */
  readonly timers: readonly (readonly (readonly [string, number])[])[];
  /** Space summaries already traced, by hash, sorted. */
  readonly seenSpaces: readonly string[];
  /** Decision requests asked and not yet applied, by agent index, with the answer once it arrived. */
  readonly slots: readonly ({ readonly agentId: string; readonly request: DecisionRequest; readonly envelope?: DecisionEnvelope } | undefined)[];
  readonly unanswered: number;
  readonly inputLog: readonly RunInput[];
  readonly nextInput: number;
}

/**
 * A researcher command recorded as a run input (ADR-0015 clarification of 2026-10-04): applied at the start of
 * `tick` (input phase), in input-ID order; replaying the same inputs reproduces the run.
 */
export interface RunInput {
  readonly inputId: string;
  readonly tick: number;
  readonly agentId: string;
  /** A base action started on the agent's behalf (world scope). */
  readonly name: string;
  readonly params: unknown;
}

interface Pending {
  readonly agentId: string;
  readonly request: DecisionRequest;
  envelope?: DecisionEnvelope;
}

function deepRound(v: unknown): unknown {
  if (typeof v === "number") return r2(v);
  if (Array.isArray(v)) return v.map(deepRound);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRound(x)]));
  return v;
}

/** The event as a mind sees it: same fields, numbers rounded (positions and times to 0.01, soc to 0.001). */
function roundEvent(e: DecisionEvent): DecisionEvent {
  switch (e.kind) {
    case "actionCompleted":
      return { kind: e.kind, actionId: e.actionId, name: e.name, result: deepRound(e.result) };
    case "batteryLow":
      return { kind: e.kind, soc: r3(e.soc), level: r3(e.level) };
    case "lost":
      return { kind: e.kind, entityId: e.entityId, entityKind: e.entityKind, lastSeenS: r2(e.lastSeenS), transitions: e.transitions };
    case "detected":
      return { kind: e.kind, entityId: e.entityId, entityKind: e.entityKind, xM: r2(e.xM), yM: r2(e.yM), zM: r2(e.zM), observedAtS: r2(e.observedAtS), transitions: e.transitions };
    default:
      return e;
  }
}

/** Timer limits (ADR-0005 addition of 2026-10-09); the same numbers as the `setTimer` capability's description. */
const TIMER_MAX_ACTIVE = 8;
const TIMER_MIN_DELAY_S = 0.1;
const TIMER_MAX_DELAY_S = 3600;
/** Timer operations processed per decision (a mind cannot flood the brain phase); the rest are rejected. */
const TIMER_OPS_PER_DECISION = 16;

/**
 * The F2 world loop (ROADMAP F1/F2, ADR-0002, ADR-0003, ADR-0005 addition of 2026-10-09). Each tick runs the same
 * phases in the same order:
 *
 * 1. inputs / world commands;
 * 2. brains: decisions answered since the last tick are applied, in agent-ID order;
 * 3. planning: every agent's query advances by its onboard budget (ADR-0024);
 * 4. actions, reflexes, kinematics and battery, per agent in ID order (inside `ActionRuntime.tick`), then
 *    sensing, which observes the end-of-tick state, then the events of the tick (ended actions, battery,
 *    perception, discovery) go into the agents' inboxes;
 * 5. state hash, then the next decision requests: an agent with a mind is asked when its inbox holds a control
 *    event, or a perception event and `minDecisionIntervalS` has passed since its last request, and no reflex
 *    recovery is running.
 *
 * Minds are asynchronous; the world is not. Requests collected at the end of a tick must be answered
 * before the next tick (`lockstep`: the sim pauses while a decision is outstanding), so the outcome is a
 * pure function of the inputs and the mind responses. `runLockstep` does the waiting.
 */
export class World implements Steppable {
  private readonly agents: readonly SimAgent[];
  /** Brain of each agent by index (undefined: no mind). */
  private readonly brainAt: readonly (Brain | undefined)[];
  /** Undelivered events of each agent by index (empty for agents without a mind). */
  private readonly inboxes: readonly Inbox[];
  /** Sim time of each agent's previous decision request, by index. */
  private readonly lastRequestS: number[];
  /** State of charge at the previous tick, by index (to detect the downward crossing of `lowSoc`). */
  private readonly prevSoc: number[];
  private readonly minDecisionIntervalS: number;
  /** Active timers of each agent's mind by index: tag → the tick at which it fires (agent state: hashed when any). */
  private readonly timers: Map<string, number>[];
  /** The run's step in seconds, from the last tick (timers are set in whole ticks). */
  private dtS = 0.1;
  /** Space summaries already recorded in the trace, by 64-bit content hash (see `traceRequest`). */
  private readonly seenSpaces = new Set<string>();
  /** At most one request per agent, by index, so every phase walks them in agent-ID order. */
  private readonly slots: (Pending | undefined)[];
  private unanswered = 0;
  /** Set when a step threw midway: the state is inconsistent, so every later step refuses. */
  private failed: unknown = undefined;
  private readonly inputLog: RunInput[] = [];
  private nextInput = 1;
  private readonly hasher = new StateHasher();
  private lastTick = 0;
  private lastSimTimeS = 0;
  private lastHash = "";

  constructor(private readonly parts: WorldParts) {
    const agents = parts.agents;
    for (let i = 1; i < agents.length; i++) {
      if ((agents[i - 1] as SimAgent).id >= (agents[i] as SimAgent).id) throw new Error("world agents must be in strictly increasing ID order");
    }
    this.agents = agents;
    const brains = parts.brains ?? new Map<string, Brain>();
    for (const id of brains.keys()) if (!agents.some((a) => a.id === id)) throw new Error(`brain for unknown agent ${id}`);
    this.brainAt = agents.map((a) => brains.get(a.id));
    this.inboxes = agents.map(() => new Inbox());
    this.lastRequestS = agents.map(() => Number.NEGATIVE_INFINITY);
    this.prevSoc = agents.map((a) => a.battery.soc);
    this.minDecisionIntervalS = parts.minDecisionIntervalS ?? 1;
    this.timers = agents.map(() => new Map<string, number>());
    this.slots = agents.map(() => undefined);
    if (parts.genesis !== false) {
      for (let i = 0; i < agents.length; i++) {
        if (!this.brainAt[i]) continue;
        this.addEvent(i, { kind: "start" }, 0, 0);
        this.ask(i, 0, 0);
      }
    }
    this.lastHash = this.computeHash();
  }

  /**
   * The world's state between ticks as plain data: the agents' bodies, batteries and odometers, the inboxes, request timing,
   * timers, the requests asked and not yet applied (and their answers), the space summaries already traced, the run
   * inputs and the counters. A snapshot is taken between ticks only, after the tick's state hash. A world that failed
   * midway is inconsistent and refuses.
   */
  snapshot(): WorldSnapshot {
    if (this.failed !== undefined) throw new Error("cannot snapshot a world that failed in an earlier step", { cause: this.failed });
    const byTag = (x: readonly [string, number], y: readonly [string, number]): number => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
    return {
      tick: this.lastTick,
      simTimeS: this.lastSimTimeS,
      dtS: this.dtS,
      stateHash: this.lastHash,
      checkHash: this.computeHash(),
      agents: this.agents.map((a) => ({ id: a.id, state: { ...a.state }, battery: { soc: a.battery.soc }, odometerM: a.odometerM })),
      inboxes: this.inboxes.map((b) => b.snapshot()),
      lastRequestS: [...this.lastRequestS],
      prevSoc: [...this.prevSoc],
      timers: this.timers.map((m) => [...m].sort(byTag)),
      seenSpaces: [...this.seenSpaces].sort(),
      slots: this.slots.map((p) => (p ? { agentId: p.agentId, request: p.request, ...(p.envelope ? { envelope: p.envelope } : {}) } : undefined)),
      unanswered: this.unanswered,
      inputLog: this.inputLog.map((i) => ({ ...i })),
      nextInput: this.nextInput,
    };
  }

  /**
   * Puts a snapshot back in place, into a world built without genesis over the same agents. Everything else the world's
   * hash reads (the action runtime, sensing and the maps) must be restored first: the hash of the restored state is
   * recomputed here against the snapshot's `checkHash`, and a different one means the parts do not agree with the
   * snapshot, so it throws rather than continue.
   */
  restore(s: WorldSnapshot): void {
    const n = this.agents.length;
    if (s.agents.length !== n || s.inboxes.length !== n || s.lastRequestS.length !== n || s.prevSoc.length !== n || s.timers.length !== n || s.slots.length !== n) {
      throw new RangeError(`snapshot is for ${s.agents.length} agents, the world has ${n}`);
    }
    for (let i = 0; i < n; i++) {
      const a = this.agents[i] as SimAgent;
      const sa = s.agents[i] as WorldSnapshot["agents"][number];
      if (sa.id !== a.id) throw new RangeError(`snapshot agent ${i} is ${sa.id}, the world's is ${a.id}`);
      Object.assign(a.state, sa.state);
      a.battery.soc = sa.battery.soc;
      a.odometerM = sa.odometerM;
      (this.inboxes[i] as Inbox).restore(s.inboxes[i] as InboxSnapshot);
      this.lastRequestS[i] = s.lastRequestS[i] as number;
      this.prevSoc[i] = s.prevSoc[i] as number;
      const mine = this.timers[i] as Map<string, number>;
      mine.clear();
      for (const [tag, due] of s.timers[i] as readonly (readonly [string, number])[]) mine.set(tag, due);
      const slot = s.slots[i];
      if (slot && slot.agentId !== a.id) throw new RangeError(`snapshot request of slot ${i} is for ${slot.agentId}, the world's agent is ${a.id}`);
      this.slots[i] = slot ? { agentId: slot.agentId, request: slot.request, ...(slot.envelope ? { envelope: slot.envelope } : {}) } : undefined;
    }
    this.seenSpaces.clear();
    for (const h of s.seenSpaces) this.seenSpaces.add(h);
    this.unanswered = s.unanswered;
    this.failed = undefined;
    this.inputLog.length = 0;
    for (const i of s.inputLog) this.inputLog.push({ ...i });
    this.nextInput = s.nextInput;
    this.dtS = s.dtS;
    this.lastTick = s.tick;
    this.lastSimTimeS = s.simTimeS;
    const hash = this.computeHash();
    if (hash !== s.checkHash) throw new Error(`restored state hash ${hash} differs from the snapshot's ${s.checkHash}: restore the action runtime, sensing and the maps before the world`);
    this.lastHash = s.stateHash;
  }

  /**
   * Records a world-scope command as a run input, applied at the start of `atTick` (default: the next tick).
   * Past ticks are refused (an input never rewrites history). Returns the recorded input.
   */
  inject(cmd: { readonly agentId: string; readonly name: string; readonly params: unknown }, atTick = this.lastTick + 1): RunInput {
    if (!Number.isInteger(atTick) || atTick <= this.lastTick) throw new RangeError(`run inputs apply at a future tick (now ${this.lastTick}, asked ${atTick})`);
    if (!this.agents.some((a) => a.id === cmd.agentId)) throw new RangeError(`unknown agent ${cmd.agentId}`);
    const input: RunInput = { inputId: `inp-${String(this.nextInput++).padStart(6, "0")}`, tick: atTick, agentId: cmd.agentId, name: cmd.name, params: cmd.params };
    this.inputLog.push(input);
    return input;
  }

  /** Every run input recorded so far, in input-ID order (replay them to reproduce the run). */
  get inputs(): readonly RunInput[] {
    return this.inputLog;
  }

  /** Number of requests that must be answered before the next tick. */
  get outstandingCount(): number {
    return this.unanswered;
  }

  /** Requests that must be answered before the next tick, in agent-ID order. */
  get outstanding(): readonly DecisionRequest[] {
    const out: DecisionRequest[] = [];
    for (const p of this.slots) if (p && !p.envelope) out.push(p.request);
    return out;
  }

  /**
   * Asks every outstanding request's brain and stores the answers (applied in the next tick's brain phase).
   * Answers that arrive are kept even if another brain fails, so a retry asks only the unanswered ones and
   * stateful minds are never asked twice for the same request.
   */
  async decide(): Promise<void> {
    const open: Pending[] = [];
    for (const p of this.slots) if (p && !p.envelope) open.push(p);
    const settled = await Promise.allSettled(open.map((p) => (this.brainAt[this.indexOf(p.agentId)] as Brain).decide(p.request)));
    const failures: string[] = [];
    for (let i = 0; i < open.length; i++) {
      const p = open[i] as Pending;
      const r = settled[i] as PromiseSettledResult<DecisionEnvelope>;
      if (r.status === "fulfilled") {
        p.envelope = r.value;
        this.unanswered--;
      } else failures.push(p.agentId);
    }
    if (failures.length > 0) throw new Error(`brains failed to decide for ${failures.join(", ")}`);
  }

  step(ctx: TickContext): void {
    if (this.failed !== undefined) throw new Error("the world failed in an earlier step", { cause: this.failed });
    if (this.unanswered > 0) throw new Error("lockstep: decisions are outstanding (call decide() before step())");
    try {
      this.run(ctx);
    } catch (e) {
      this.failed = e;
      throw e;
    }
  }

  private run(ctx: TickContext): void {
    const { tick, simTimeS } = ctx;
    this.dtS = ctx.dtS;
    const { runtime, planner, trace } = this.parts;
    const n = this.agents.length;
    // 1. Inputs / world commands: recorded run inputs due at this tick, in input-ID order.
    for (const input of this.inputLog) {
      if (input.tick !== tick) continue;
      const agent = this.agents.find((a) => a.id === input.agentId);
      if (!agent) continue;
      const r = runtime.startInjected(agent, input.name, input.params, input.inputId, tick, simTimeS);
      trace.emit({
        source: "world/sim",
        simTime: simTimeS,
        kind: "injected",
        agentId: agent.id,
        detail: "full",
        payload: { op: "command", caller: "world", inputId: input.inputId, name: input.name, params: input.params, ...(r.ok ? { ok: true, actionId: r.value } : { ok: false, failure: r.error.code }) },
      });
    }
    // 2. Brains, in agent-ID order.
    for (let i = 0; i < n; i++) {
      const p = this.slots[i];
      if (!p) continue;
      this.slots[i] = undefined;
      const agent = this.agents[i] as SimAgent;
      const brain = this.brainAt[i] as Brain;
      const env = p.envelope as DecisionEnvelope;
      const d = env.decision;
      const slot = mindSlot(brain);
      const decisionId = trace.emit({
        source: `${agent.id}/${slot === "S1" ? "s1" : "s2"}`,
        simTime: simTimeS,
        kind: "thought",
        agentId: agent.id,
        tier: slot,
        detail: "full",
        payload: {
          op: "decision",
          brain: brain.id,
          brainKind: brain.tier,
          tier: slot,
          events: p.request.events,
          ...(p.request.eventsDropped > 0 ? { eventsDropped: p.request.eventsDropped } : {}),
          decision: d,
          ...(env.rationale === undefined ? {} : { rationale: env.rationale }),
        },
      });
      // Timer bookkeeping comes before the decision's action, and may accompany an idle decision.
      if (env.timers && env.timers.length > 0) this.applyTimers(i, env.timers, tick, simTimeS);
      if (d.kind !== "action") continue;
      const started = runtime.start(agent, d.name, d.params, { scope: "self", id: agent.id }, tick, simTimeS, decisionId);
      // The brain hears about a rejection at once (at the end of this tick); a script moves on to its next step.
      if (!started.ok) this.addEvent(i, { kind: "actionRejected", name: d.name, code: started.error.code }, tick, simTimeS, runtime.takeRejectedRecord(agent.id));
    }
    // 3. Planning.
    planner.advance(tick);
    // 4. Actions, reflexes, kinematics, battery; then sensing, which observes the end-of-tick state; then the
    // events of the tick.
    for (let i = 0; i < n; i++) runtime.tick(this.agents[i] as SimAgent, tick, simTimeS);
    this.parts.sensing?.sense(tick, simTimeS);
    this.collectEvents(tick, simTimeS);
    this.fireTimers(tick, simTimeS);
    // 5. Hash, then the next requests.
    this.lastTick = tick;
    this.lastSimTimeS = simTimeS;
    this.lastHash = this.computeHash();
    for (let i = 0; i < n; i++) {
      if (!this.brainAt[i] || this.slots[i]) continue;
      const inbox = this.inboxes[i] as Inbox;
      if (inbox.size === 0 || runtime.isRecovering((this.agents[i] as SimAgent).id)) continue;
      // Control events request a decision at once; perception events wait out the minimum decision interval,
      // measured from the previous request of any kind. Delayed, not lost.
      if (!inbox.hasControl() && simTimeS - (this.lastRequestS[i] as number) < this.minDecisionIntervalS - 1e-9) continue;
      this.ask(i, tick, simTimeS);
    }
  }

  /**
   * Applies a decision's timer operations in order (ADR-0005 addition of 2026-10-09): parameters validated against the
   * tools-schema capabilities, then the runtime's limits. A refused operation raises `actionRejected` (name `setTimer` or
   * `cancelTimer`) with `delay_out_of_range`, `timer_limit` or `timer_not_found`; the others still apply.
   */
  private applyTimers(i: number, ops: readonly TimerOp[], tick: number, simTimeS: number): void {
    const a = this.agents[i] as SimAgent;
    const brain = this.brainAt[i] as Brain;
    const source = `${a.id}/${mindSlot(brain) === "S1" ? "s1" : "s2"}`;
    const mine = this.timers[i] as Map<string, number>;
    const reject = (name: string, code: string) => this.addEvent(i, { kind: "actionRejected", name, code }, tick, simTimeS);
    ops.forEach((op, n) => {
      const name = op.op === "set" ? "setTimer" : "cancelTimer";
      if (n >= TIMER_OPS_PER_DECISION) return reject(name, "timer_limit");
      const v = this.parts.runtime.checkBookkeeping(name, op.op === "set" ? { delayS: op.delayS, tag: op.tag } : { tag: op.tag });
      if (!v.ok) return reject(name, v.error.code);
      if (op.op === "cancel") {
        if (!mine.delete(op.tag)) return reject(name, "timer_not_found");
        this.parts.trace.emit({ source, simTime: simTimeS, kind: "event", agentId: a.id, detail: "full", payload: { op: "timer-cancel", tag: op.tag } });
        return;
      }
      if (!(op.delayS >= TIMER_MIN_DELAY_S && op.delayS <= TIMER_MAX_DELAY_S)) return reject(name, "delay_out_of_range");
      if (!mine.has(op.tag) && mine.size >= TIMER_MAX_ACTIVE) return reject(name, "timer_limit");
      // Fires at the first tick at or after the due time, in whole ticks (integer arithmetic: no float comparison).
      const dueTick = tick + Math.max(1, Math.ceil(op.delayS / this.dtS - 1e-9));
      mine.set(op.tag, dueTick);
      this.parts.trace.emit({ source, simTime: simTimeS, kind: "event", agentId: a.id, detail: "full", payload: { op: "timer-set", tag: op.tag, delayS: op.delayS, dueTick } });
    });
  }

  /** Fires the timers due at this tick, in due order then tag; each becomes a `timer` event (and is removed). */
  private fireTimers(tick: number, simTimeS: number): void {
    for (let i = 0; i < this.agents.length; i++) {
      const mine = this.timers[i] as Map<string, number>;
      if (mine.size === 0) continue;
      const due = [...mine].filter(([, d]) => d <= tick).sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      for (const [tag] of due) {
        mine.delete(tag);
        this.addEvent(i, { kind: "timer", tag }, tick, simTimeS);
      }
    }
  }

  /** Events of the tick just run: ended actions, the battery crossing `lowSoc`, perception and discovery. */
  private collectEvents(tick: number, simTimeS: number): void {
    const index = new Map(this.agents.map((a, i) => [a.id, i]));
    for (const e of this.parts.runtime.takeEnded()) {
      const i = index.get(e.agentId);
      if (i === undefined) continue;
      this.addEvent(
        i,
        e.status === "succeeded"
          ? { kind: "actionCompleted", actionId: e.actionId, name: e.name, result: e.result }
          : { kind: "actionFailed", actionId: e.actionId, name: e.name, status: e.status, code: e.code ?? "failed" },
        tick,
        simTimeS,
        e.recordId,
      );
    }
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i] as SimAgent;
      const low = a.body.battery.lowSoc;
      const prev = this.prevSoc[i] as number;
      this.prevSoc[i] = a.battery.soc;
      if (low !== undefined && prev > low && a.battery.soc <= low) this.addEvent(i, { kind: "batteryLow", soc: a.battery.soc, level: low }, tick, simTimeS);
    }
    for (const e of this.parts.sensing?.takeEvents?.() ?? []) {
      const i = index.get(e.agentId);
      if (i !== undefined) this.addEvent(i, e.event, tick, simTimeS);
    }
  }

  /** Traces the event when it happens, whether or not the agent has a mind, and queues it for the mind if it has one. */
  private addEvent(i: number, event: DecisionEvent, tick: number, simTimeS: number, cause?: string): void {
    const a = this.agents[i] as SimAgent;
    const brain = this.brainAt[i];
    const component =
      event.kind === "detected" || event.kind === "lost" ? "sensors" : event.kind === "batteryLow" ? "body" : event.kind === "frontierExhausted" ? "beliefs" : event.kind === "timer" && brain ? (mindSlot(brain) === "S1" ? "s1" : "s2") : "actions";
    this.parts.trace.emit({
      source: `${a.id}/${component}`,
      simTime: simTimeS,
      kind: "event",
      agentId: a.id,
      detail: isControl(event.kind) ? "full" : "transitions",
      ...(cause === undefined ? {} : { causeIds: [cause] }),
      payload: { op: "event", event },
    });
    if (brain) (this.inboxes[i] as Inbox).add(event, tick);
  }

  /**
   * The decision request an agent's mind gets or would get now, built by the same code as the real one, changing nothing
   * (no event consumed, nothing recorded, no timing or state touched). `pending` is true when it is the request the mind
   * has been asked and has not answered yet; otherwise it is the request the next trigger would send, with the events
   * waiting in the inbox (an answered request, not yet applied, no longer counts as pending). For the researcher's Inspector (ADR-0005 addition of 2026-10-12).
   */
  peekRequest(agentId: string): { readonly request: DecisionRequest; readonly pending: boolean } | undefined {
    const i = this.agents.findIndex((a) => a.id === agentId);
    if (i < 0) return undefined;
    const open = this.slots[i];
    if (open && !open.envelope) return { request: open.request, pending: true };
    const { events, dropped } = (this.inboxes[i] as Inbox).preview();
    return { request: this.request(this.agents[i] as SimAgent, events, dropped, this.lastTick, this.lastSimTimeS), pending: false };
  }

  private ask(i: number, tick: number, simTimeS: number): void {
    const a = this.agents[i] as SimAgent;
    const { events, dropped } = (this.inboxes[i] as Inbox).take();
    const request = this.request(a, events, dropped, tick, simTimeS);
    this.traceRequest(a, request);
    this.slots[i] = { agentId: a.id, request };
    this.lastRequestS[i] = simTimeS;
    this.unanswered++;
  }

  /**
   * The full request as a `thought` record (op `request`) until F3's mind-io channel exists (ADR-0039 §5), without
   * repeating what is bulky and shared: the space summary is recorded once per distinct 64-bit content hash (`op:
   * "space"`) and referenced by it; allowed actions are names plus the hash of the capability manifest (the schemas
   * belong to the simulator version).
   */
  private traceRequest(a: SimAgent, req: DecisionRequest): void {
    const brain = this.brainAt[this.indexOf(a.id)] as Brain;
    const slot = mindSlot(brain);
    const source = `${a.id}/${slot === "S1" ? "s1" : "s2"}`;
    const summary = JSON.stringify(req.space);
    const ref = contentHash64(summary);
    if (!this.seenSpaces.has(ref)) {
      this.seenSpaces.add(ref);
      this.parts.trace.emit({ source, simTime: req.simTimeS, kind: "thought", agentId: a.id, tier: slot, detail: "full", payload: { op: "space", hash: ref, summary: req.space } });
    }
    this.parts.trace.emit({
      source,
      simTime: req.simTimeS,
      kind: "thought",
      agentId: a.id,
      tier: slot,
      detail: "full",
      payload: {
        op: "request",
        tick: req.tick,
        events: req.events,
        eventsDropped: req.eventsDropped,
        self: req.self,
        beliefs: req.beliefs,
        space: ref,
        allowed: { manifest: this.parts.runtime.manifestHash(), names: req.allowedActions.map((x) => x.name) },
        unavailable: req.unavailable,
      },
    });
  }

  private indexOf(agentId: string): number {
    for (let i = 0; i < this.agents.length; i++) if ((this.agents[i] as SimAgent).id === agentId) return i;
    throw new Error(`unknown agent ${agentId}`);
  }

  /** State hash after the last executed tick (ADR-0002): tick, agents (body, battery, odometer) and actions. */
  get stateHash(): string {
    return this.lastHash;
  }

  get tick(): number {
    return this.lastTick;
  }

  get simTimeS(): number {
    return this.lastSimTimeS;
  }

  private computeHash(): string {
    const h = this.hasher;
    h.reset();
    h.u32(this.lastTick);
    for (const a of this.agents) {
      hashAgent(h, a);
      const info = this.parts.runtime.info(a.id);
      if (!info) {
        h.str("");
        continue;
      }
      h.str(info.actionId).str(info.name).str(info.status).str(info.phase).str(info.failure?.code ?? "");
    }
    this.parts.sensing?.hashInto?.(h);
    // Undelivered events are agent state (ADR-0005 addition): hashed only when there are any.
    for (let i = 0; i < this.agents.length; i++) (this.inboxes[i] as Inbox).hashInto(h, (this.agents[i] as SimAgent).id);
    // Active timers are agent state too (ADR-0005 addition): hashed only when there are any, by tag.
    for (let i = 0; i < this.agents.length; i++) {
      const mine = this.timers[i] as Map<string, number>;
      if (mine.size === 0) continue;
      h.str((this.agents[i] as SimAgent).id).u32(mine.size);
      for (const tag of [...mine.keys()].sort()) h.str(tag).u32(mine.get(tag) as number);
    }
    return h.hex();
  }

  private request(a: SimAgent, events: readonly DecisionEvent[], dropped: number, tick: number, simTimeS: number): DecisionRequest {
    const s = a.state;
    const info = this.parts.runtime.info(a.id);
    const running = info && info.status === "running" ? { actionId: info.actionId, name: info.name, phase: info.phase } : null;
    const mine = this.timers[this.indexOf(a.id)] as Map<string, number>;
    const timers = [...mine.keys()].sort().map((tag) => ({ tag, dueInS: r2(Math.max(0, ((mine.get(tag) as number) - tick) * this.dtS)) }));
    const self: SelfView =
      a.kind === "uav"
        ? { kind: "uav", xM: r2(s.x), yM: r2(s.y), zM: r2(a.state.z), headingRad: r3(s.heading), soc: r3(a.battery.soc), running, timers }
        : { kind: "ugv", xM: r2(s.x), yM: r2(s.y), headingRad: r3(s.heading), soc: r3(a.battery.soc), running, timers };
    const view = this.parts.mindView?.view(a.id, simTimeS) ?? EMPTY_MIND_VIEW;
    const menu = this.parts.runtime.actionMenu(a);
    return {
      agentId: a.id,
      tick,
      simTimeS,
      events: events.map(roundEvent),
      eventsDropped: dropped,
      self,
      beliefs: view.beliefs,
      space: view.space,
      allowedActions: menu.allowed,
      unavailable: menu.unavailable,
    };
  }
}

/**
 * The mind slot a brain occupies, which is its trace component (ADR-0031 clarification of 2026-10-04):
 * the fast/reactive slot `S1` (S1 models and workflows, scripts, classical baselines) or the
 * deliberative slot `S2` (LLMs, external agents). `Brain.tier` (ROADMAP appendix) names the brain's
 * kind; records keep it as `brainKind` next to the slot, so a script stays distinguishable from an S1 model.
 */
export function mindSlot(b: Brain): "S1" | "S2" {
  return b.tier === "S2" || b.tier === "external" ? "S2" : "S1";
}

/**
 * Runs `ticks` ticks in `lockstep` (ADR-0003): before each tick, the outstanding decisions are awaited.
 * The headless runner and the tests use it; the live worker adds pacing around the same two calls.
 */
export async function runLockstep(world: World, scheduler: Scheduler, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (world.outstandingCount > 0) await world.decide();
    scheduler.step();
  }
}
