import type { SimAgent } from "../actions/agent.ts";
import type { PlanMap, ProximityPort, SpatialPort } from "../actions/ports.ts";

/**
 * Always-on safety behaviors (ROADMAP F1): they override actions and plans. Each reflex has a stable code;
 * when it acts, the running action ends `preempted` with that code, and the reflex may start a recovery
 * action on the agent's behalf. Every trigger is traced (kind `reflex`, source `<agent>/reflexes`).
 *
 * The interface is deliberately open: a neighbour-based reflex (agent–agent avoidance, multi-agent phases)
 * adds its context to `ReflexContext` and implements `beforeMove` like the obstacle reflex.
 */
export interface ReflexContext {
  readonly tick: number;
  readonly simTime: number;
  readonly dtS: number;
  /** Legal limits (geofences, no-fly volumes) for the geofence reflex. Obstacles are sensed, never read here. */
  readonly spatial: SpatialPort;
  /** What the proximity sensors last reported (F2): the only source of obstacles for the obstacle reflex. */
  readonly proximity: ProximityPort | undefined;
}

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ReflexTrigger {
  /** Stable code, e.g. `obstacle_ahead`, `geofence`, `battery_critical`. */
  readonly code: string;
  readonly message: string;
  /** Recovery action started on the agent's behalf after the preemption (e.g. returnToBase). */
  readonly then?: { readonly name: string; readonly params: Readonly<Record<string, unknown>> };
}

export interface Reflex {
  readonly name: string;
  /**
   * Called before the body moves from `from` to `to`. Returning a trigger vetoes the motion: the body stays
   * at `from` and the action is preempted. `planMap` is the map of the plan being followed, if any.
   */
  beforeMove?(ctx: ReflexContext, agent: SimAgent, from: Pose, to: Pose, planMap: PlanMap | undefined): ReflexTrigger | undefined;
  /** Called once per tick after the action step (state-based reflexes such as the battery). */
  afterStep?(ctx: ReflexContext, agent: SimAgent, runningAction: string | undefined): ReflexTrigger | undefined;
  /**
   * A reflex that keeps state between ticks (the battery reflex's latch) hands it over as plain data for a snapshot
   * (ADR-0035 addition of 2026-10-17, item 8), and takes it back in place. Stateless reflexes have neither.
   */
  snapshot?(): unknown;
  restore?(data: unknown): void;
}
