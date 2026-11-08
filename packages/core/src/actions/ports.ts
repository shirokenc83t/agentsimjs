import type { CodedError, Result } from "../result.ts";

/**
 * Ports of the action runtime. Core is the lowest layer (spatial, algorithms, tools-schema and trace all
 * depend on it), so the runtime reaches them through these interfaces; `@agentsim/scenarios/assemble`
 * wires the real implementations. Tests use small fakes.
 */

export interface PlanQuery {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  /** UAV only: altitude the path is planned at. */
  readonly cruiseAltitudeM?: number;
  /** A search window (ADR-0040): the planner never expands outside this rectangle (metres; `x1`, `y1` exclusive), so a query that cannot be answered ends after its cells. */
  readonly window?: PlanWindow;
}

/** A rectangle of the map in metres: `x0 <= x < x1`, `y0 <= y < y1`. */
export interface PlanWindow {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The map a plan was made on: ground truth in F1, the agent's belief map from F2. Checks of a plan use
 * this map only, never ground truth, so an agent never acts on obstacles it does not know (ADR-0005).
 */
export interface PlanMap {
  readonly version: number;
  /** Distance from (x, y) to the nearest cell this vehicle cannot occupy on this map (or its edge), capped at `maxM`. */
  clearanceM(x: number, y: number, maxM: number): number;
  /** Whether the planner can place the vehicle at (x, y) on this map: the planning view's passability, inflation included. False outside the map. */
  passableAt(x: number, y: number): boolean;
}

export interface PlanResult {
  readonly status: "found" | "not_found" | "budget_exceeded";
  /** Waypoints in metres, start first; empty unless found. */
  readonly waypoints: readonly (readonly [number, number])[];
  readonly expansionsCharged: number;
  readonly completedTick: number;
  readonly map: PlanMap;
  /** The id of the trace record of this query's outcome (the `plan` record of the planner), when the planner traces. */
  readonly causeRecord?: string;
}

/** A leg of a lazy `refine` strategy that is ready to drive (ADR-0037 fourth addition): metre waypoints, the first being the previous leg's last. */
export interface PlanLeg {
  readonly index: number;
  /** How many legs the plan has (known once its coarse path is). */
  readonly count: number;
  readonly last: boolean;
  readonly waypoints: readonly (readonly [number, number])[];
  /** The tick the leg became ready. */
  readonly tick: number;
}

/** The legs of a lazy query that became ready since the last call, and how the query stands. */
export interface PlanProgress {
  readonly legs: readonly PlanLeg[];
  /** The query is over: the last leg is out, it failed, or it was interrupted. */
  readonly done: boolean;
  readonly status?: PlanResult["status"];
  /** A map change after a leg was handed out ended the query; the action replans from where it is. */
  readonly interrupted?: "map_changed";
  /** The map the legs were planned on (live view). */
  readonly map: PlanMap;
  readonly expansionsCharged: number;
  readonly completedTick: number;
  /** The id of the planner's trace record that explains this progress: the `restart` of an interrupted query, the `plan` of a finished one. */
  readonly causeRecord?: string;
}

/** The per-agent planning service (ADR-0024, ADR-0028), advanced in the planning phase of each tick. */
export interface PlannerPort {
  /** Planning phase: advances every agent's query by its own onboard budget. */
  advance(tick: number): void;
  submit(agentId: string, q: PlanQuery, tick: number): Result<string, CodedError>;
  /** The outcome of a completed query (returned once), or undefined while it is still running. */
  take(agentId: string, queryId: string): PlanResult | undefined;
  /**
   * The legs of a **lazy** query that became ready since the last call (each once), or undefined for every other query and
   * while there is nothing new. Optional: a planner without lazy strategies never has legs. `take` is unchanged and still
   * returns the whole outcome of a lazy query once everything is planned (ADR-0037 fourth addition, item 2).
   */
  takeLegs?(agentId: string, queryId: string): PlanProgress | undefined;
  cancel(agentId: string): void;
  /**
   * The map the agent would plan on now (F1: the ground-truth grid it knows; from F2: its belief map).
   * Every onboard decision of the runtime (target fit, replanning) uses it, never `SpatialPort`. A UAV's view depends
   * on the altitude its path is planned at: `cruiseAltitudeM` names it (default: the body's cruise altitude), which is
   * how a restored goTo gets back the map of the plan it was following (ADR-0035 addition of 2026-10-17, item 8).
   */
  currentMap(agentId: string, cruiseAltitudeM?: number): PlanMap;
  /**
   * Start-time checks on the agent's own map (ADR-0005; F2 audit of 2026-10-10): its belief grid, or the ground
   * truth for `ideal` agents. Cells the agent has never observed count as free (optimistic): a mind is told no more
   * than its agent knows, and the physical outcome comes later, when it happens.
   */
  knownSpace(agentId: string): KnownSpace;
  /** The agent's exploration scope (ADR-0040): the radius of an iteration and the margin its search windows add, from its planning configuration. */
  exploreParams(agentId: string): { readonly radiusM: number; readonly windowMarginM: number };
}

/** What an agent's own map says about a point (see `PlannerPort.knownSpace`); zones and limits are mission data. */
export interface KnownSpace {
  /** Not believed blocked, passable terrain (as known), inside every geofence. */
  freeForGround(x: number, y: number): boolean;
  /** Inside the map, the altitude limits and every geofence, outside no-fly volumes, and z clear of the believed top. */
  freeForAir(x: number, y: number, z: number, clearanceM: number): boolean;
  /** A UAV may land here: not believed occupied, inside every geofence, not in a no-fly volume at ground level. */
  landable(x: number, y: number): boolean;
}

/** An unmarked frontier group of an agent's own map (ADR-0039), as `explore` sees it. */
export interface FrontierCandidate {
  /** Valid for this query only: groups split and merge as the map grows. */
  readonly id: string;
  readonly region: string;
  /** Cell indices (j · sizeX + i), ascending. */
  readonly cells: readonly number[];
  /** Representative cell, and its centre in metres: the target. */
  readonly point: number;
  readonly xM: number;
  readonly yM: number;
  /** Marked unreachable for the current iteration only (ADR-0040): not a target until an iteration ends or the map changes around it. */
  readonly temporary: boolean;
}

/**
 * An agent's frontier groups, regions and unreachable marks (ADR-0039 and its addition of 2026-10-10), from its own
 * map only. Read by `explore`; goTo marks a frontier target it could not reach.
 */
export interface FrontierPort {
  /** Whether the agent has a range sensor (lidar or proximity): the `hasRangeSensor` precondition of `explore`. */
  hasRangeSensor(agentId: string): boolean;
  hasRegion(agentId: string, region: string): boolean;
  /** Region rectangle in metres, or undefined for an unknown region. */
  regionRect(agentId: string, region: string): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | undefined;
  /** Frontier groups not marked unreachable, in a stable order (regions by index, groups by lowest cell); the temporarily marked ones are flagged. */
  candidates(agentId: string): readonly FrontierCandidate[];
  /** Groups currently marked unreachable (permanent marks). */
  markedCount(agentId: string): number;
  /** Centre of a grid cell (index `j · sizeX + i`) in metres. */
  cellCentre(agentId: string, cell: number): { readonly xM: number; readonly yM: number };
  /** Whether the cell is still a frontier cell (known free, next to unknown). */
  isFrontier(agentId: string, cell: number): boolean;
  /** Whether the point is known (observed) on the agent's map: before its first reading, nothing is. */
  isKnown(agentId: string, xM: number, yM: number): boolean;
  /**
   * Whether the region still has unknown cells the agent could reach: it has unknown cells and is connected to the
   * agent's region in the region graph (edges of either class). Reachability itself is settled by the planner.
   */
  regionHasReachableUnknown(agentId: string, region: string, xM: number, yM: number): boolean;
  /** Marks unreachable the frontier group holding the cell at (x, y), if any (traced); returns whether it did. */
  markAt(agentId: string, xM: number, yM: number, simTime: number): boolean;
  /**
   * Marks the group holding the cell at (x, y) unreachable for the current iteration (ADR-0040): it stays a candidate
   * flagged `temporary`, and the mark clears when the map changes around it like a permanent one, or at `clearTemporary`.
   */
  markTemporaryAt(agentId: string, xM: number, yM: number, simTime: number): boolean;
  /** Clears every temporary mark of the agent (an iteration ended, or the action did). */
  clearTemporary(agentId: string, simTime: number): void;
}

/** Ground-truth spatial queries for one vehicle class (the runtime's physical checks, not the mind's view). */
export interface SpatialPort {
  /** Ground-truth version; changes on every edit. */
  readonly version: number;
  readonly altitudeLimitsM: { readonly min: number; readonly max: number };
  inBounds(x: number, y: number): boolean;
  freeForGround(x: number, y: number): boolean;
  freeForAir(x: number, y: number, z: number, clearanceM: number): boolean;
  groundHeightM(x: number, y: number): number;
  /** A UAV can land here: free ground cell inside every geofence. */
  landable(x: number, y: number): boolean;
  /** Distance from (x, y) to the nearest cell impassable for ground vehicles (or the map edge), capped at `maxM`. */
  groundClearanceM(x: number, y: number, maxM: number): number;
  /**
   * Inside the map and every geofence, and (at altitude z) outside every no-fly volume. Legal limits only:
   * obstacles are not considered.
   */
  insideFence(x: number, y: number, z: number): boolean;
  /**
   * Physical contact on ground truth (ADR-0012 addition of 2026-10-09): the cells a footprint disc of `radiusM`
   * at (x, y) touches that stop the body, as flat (i, j) pairs in index order. A UGV is stopped by occupied
   * cells and impassable terrain; a UAV at altitude z by cells whose obstacle top reaches z. Empty: no contact.
   */
  contactCells(x: number, y: number, z: number, radiusM: number, vehicle: "uav" | "ugv"): readonly number[];
}

/**
 * The latest proximity reading of each agent (ADR-0012 addition of 2026-10-09): the points its proximity sensors
 * hit (flat x, y in metres), as the agent sensed them. The obstacle reflex acts on these, never on ground truth.
 */
export interface ProximityPort {
  hits(agentId: string): readonly number[];
}

/** Where contact observations go (a bump): the touched cells become believed occupied (ADR-0012 addition). */
export interface ContactPort {
  contact(agentId: string, cells: readonly number[], lowerM: number, simTime: number): void;
}

export type Scope = "world" | "leader" | "self";

/** Capability definitions from `tools-schema` (ADR-0007). */
export interface CapabilityPort {
  /** Every capability, by name: the menu a mind is offered (its parameter schema comes from the generated manifest). */
  list(): readonly { readonly name: string; readonly kind: "action" | "bookkeeping" | "compute"; readonly paramsSchema: Readonly<Record<string, unknown>> }[];
  /** `action` starts a behavior; `bookkeeping` (timers, the notebook) changes agent state only and accompanies a decision; `compute` answers a question from the agent's own map (ADR-0014 addition of 2026-10-29). */
  kind(name: string): "action" | "bookkeeping" | "compute";
  /** In the closed set of world-scope commands a researcher can inject (ADR-0015 addition of 2026-10-12). */
  injectable(name: string): boolean;
  validate(name: string, params: unknown): Result<unknown, CodedError<"unknown_capability" | "invalid_params">>;
  vehicles(name: string): readonly string[];
  scope(name: string): Scope;
  preconditions(name: string): readonly { readonly name: string; readonly vehicles?: readonly string[] }[];
}

/**
 * Where the runtime's trace records go (ADR-0004, ADR-0031: source `<agent>/actions`). `emit` returns the id of the record it wrote, so that a later record can name it
 * as its parent or its cause; `parentId` and `causeIds` are given only by trusted code (never by a mind) and name records of the same run written before.
 */
export interface TraceSink {
  emit(r: {
    /** The record this one belongs to (an action's start for what happens during the action). */
    readonly parentId?: string;
    /** The records that made this one happen. */
    readonly causeIds?: readonly string[];
    readonly source: string;
    readonly simTime: number;
    readonly kind: "action" | "reflex" | "thought" | "compute" | "injected" | "event" | "observation" | "lifecycle";
    readonly agentId: string;
    /** Mind slot of a decision record (`thought`). */
    readonly tier?: "S1" | "S2";
    readonly detail: "full" | "transitions";
    readonly payload: unknown;
  }): string;
  /**
   * The id a record of this run has at `seq`, when the sink knows its run: a snapshot restored into another run (a derived run continues the parent's sequence under its own
   * run ID) names the action's start by the id it has in the run it is restored into.
   */
  idOf?(seq: number): string;
}
