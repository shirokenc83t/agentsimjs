import type { PlanningService, PlanningSnapshot, PlanOutcome, PlanRestart, SearchSpace } from "@agentsim/algorithms";
import { err, ok, type CapabilityPort, type CodedError, type KnownSpace, type PlanMap, type PlannerPort, type PlanProgress, type PlanQuery, type PlanResult, type Result, type Scope, type SpatialPort, type TraceSink } from "@agentsim/core";
import { OCCUPANCY_FREE, TERRAIN_IMPASSABLE, type BeliefGrid, type GridSpace, type PlanningGrid } from "@agentsim/spatial";
import { capabilityManifest, getCapability, isInjectable, validateParams } from "@agentsim/tools-schema";
import type { TraceBuffer } from "@agentsim/trace";
import { EXPLORE_BUILTIN, toPlanningConfig, type EffectiveAgentConfig } from "../run-config/resolve.ts";
import { traversalFor } from "../traversal.ts";

/** The state of a `PlanningServiceAdapter` between ticks, as plain data (see `PlanningServiceAdapter.snapshot`). */
export interface PlannerAdapterSnapshot {
  readonly service: PlanningSnapshot;
  /** The configurations a `setConfig` changed since assembly, by agent ID. */
  readonly overrides: readonly (readonly [string, EffectiveAgentConfig])[];
}

/**
 * PlannerPort over the per-agent PlanningService (ADR-0024, ADR-0028). Each agent plans with its own
 * effective configuration; a world-scope change (`setConfig`) applies from the agent's next query.
 */
export class PlanningServiceAdapter implements PlannerPort {
  private readonly completed = new Map<string, PlanOutcome>();
  /** The trace record of each query's outcome and of each interrupted query's restart, by query ID: what a failure or a replan of the action names as its cause (until read). */
  private readonly outcomeRecords = new Map<string, string>();
  private readonly restartRecords = new Map<string, string>();
  private readonly configs = new Map<string, EffectiveAgentConfig>();
  /** Each agent's configuration at assembly: `setConfig` changes are what a snapshot keeps. */
  private readonly initial = new Map<string, EffectiveAgentConfig>();

  constructor(
    readonly service: PlanningService,
    agents: readonly EffectiveAgentConfig[],
    /** The ground-truth map: what `ideal` agents (and F1 runs) know. */
    private readonly knownMap: GridSpatialAdapter,
    /** Where completed queries are traced (ADR-0004: every algorithm query), with the run's step for sim time. */
    private readonly trace?: { readonly sink: TraceSink; readonly dtS: number },
    /** Each non-ideal agent's belief grid (F2): its queries and onboard checks use it, never ground truth. */
    private readonly beliefGrids: ReadonlyMap<string, BeliefGrid> = new Map(),
  ) {
    for (const a of agents) {
      this.configs.set(a.agentId, a);
      this.initial.set(a.agentId, a);
    }
  }

  /**
   * The agent's current planning view (ADR-0024 addition of 2026-10-10): its live view for its body's traversal and
   * current planning configuration, over its belief grid (or the ground truth for `ideal` agents), as of the last
   * sync point. Onboard checks (target fit, back-off, remaining path) use it; never ground truth for belief agents.
   * Its version is the map's version the view was last synced to. A UAV's traversal depends on the altitude its path is
   * planned at: `cruiseAltitudeM` names it (default: the body's cruise altitude), as a query's request does.
   */
  /** The agent's live planning view (its body's traversal and current configuration), or undefined. */
  liveView(agentId: string, cruiseAltitudeM?: number): SearchSpace | undefined {
    const cfg = this.configs.get(agentId);
    const v = cfg ? this.service.view(this.beliefGrids.has(agentId) ? agentId : undefined, traversalFor(cfg, cruiseAltitudeM), toPlanningConfig(cfg)) : undefined;
    return v?.ok ? v.value : undefined;
  }

  /**
   * The adapter's state between ticks (F3a M1; ADR-0035 addition of 2026-10-17, item 8): the planning service's
   * snapshot, and the planning configurations a `setConfig` changed since assembly. Taken between ticks: completed
   * outcomes, restart events and lazy legs are all handed to the runtime within the tick, so none may be waiting (a
   * snapshot that found some would lose them).
   */
  snapshot(): PlannerAdapterSnapshot {
    const out = this.service.pendingOutputs();
    if (this.completed.size > 0 || out.completed > 0 || out.restarts > 0 || out.legs > 0) {
      throw new Error(`cannot snapshot the planner with outputs not yet taken (${this.completed.size + out.completed} outcomes, ${out.restarts} restarts, ${out.legs} legs): snapshots are taken between ticks`);
    }
    const overrides = [...this.configs]
      .filter(([id, c]) => this.initial.get(id) !== c)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, c]): [string, EffectiveAgentConfig] => [id, c]);
    return { service: this.service.snapshot(), overrides };
  }

  /** Puts a snapshot back in place: the changed configurations first (queries restart with them), then the service's queries. */
  restore(s: PlannerAdapterSnapshot): void {
    this.completed.clear();
    for (const [id, c] of s.overrides) {
      if (!this.configs.has(id)) throw new RangeError(`snapshot has a planning configuration for unknown agent ${id}`);
      this.configs.set(id, c);
    }
    this.service.restore(s.service);
  }

  currentMap(agentId: string, cruiseAltitudeM?: number): PlanMap {
    const space = this.liveView(agentId, cruiseAltitudeM);
    if (space) return { version: space.version, clearanceM: (x, y, maxM) => space.clearanceM(x, y, maxM), passableAt: passableOn(space) };
    // No configuration (not an agent of this run): fall back to the map itself.
    const bg = this.beliefGrids.get(agentId);
    if (bg) return { version: bg.version, clearanceM: (x, y, maxM) => groundClearanceOn(bg, x, y, maxM), passableAt: (x, y) => bg.inBounds(bg.cellI(x), bg.cellJ(y)) && knownSpaceOn(bg).freeForGround(x, y) };
    const m = this.knownMap;
    return { version: m.version, clearanceM: (x, y, maxM) => m.groundClearanceM(x, y, maxM), passableAt: (x, y) => m.inBounds(x, y) && m.freeForGround(x, y) };
  }

  /** The agent's exploration scope (ADR-0040) from its planning configuration as it is now (a `setConfig` applies from the next explore). */
  exploreParams(agentId: string): { readonly radiusM: number; readonly windowMarginM: number } {
    const cfg = this.configs.get(agentId);
    if (!cfg) return { radiusM: EXPLORE_BUILTIN.radiusM.ugv, windowMarginM: EXPLORE_BUILTIN.windowMarginM };
    return { radiusM: cfg.planning.radiusM, windowMarginM: cfg.planning.windowMarginM };
  }

  /** Start-time checks on the agent's own map: its belief grid, or the ground truth for `ideal` agents. */
  knownSpace(agentId: string): KnownSpace {
    return knownSpaceOn(this.beliefGrids.get(agentId) ?? this.knownMap.grid);
  }

  setConfig(a: EffectiveAgentConfig): void {
    this.configs.set(a.agentId, a);
  }

  advance(tick: number): void {
    this.service.tick(tick);
    for (const r of this.service.takeRestarts()) this.traceRestart(r);
    for (const o of this.service.takeCompleted()) {
      this.completed.set(o.queryId, o);
      this.traceOutcome(o, tick);
    }
  }

  /** The sync point after sensing (ADR-0024 addition of 2026-10-10): live views catch up with this tick's beliefs. */
  syncViews(): void {
    this.service.syncViews();
  }

  /** Each restart of a query in progress, with its reason (ADR-0024 addition of 2026-10-09). */
  private traceRestart(r: PlanRestart): void {
    if (!this.trace) return;
    const id = this.trace.sink.emit({
      source: `${r.agentId}/planner`,
      simTime: r.tick * this.trace.dtS,
      kind: "compute",
      agentId: r.agentId,
      detail: "transitions",
      payload: { op: "restart", queryId: r.queryId, reason: r.reason, ...(r.chunks.length > 0 ? { chunks: r.chunks } : {}), spent: r.spent, ...(r.interrupted ? { interrupted: true } : {}) },
    });
    // The record that explains an interrupted query's replan (the action's `replan` note names it as its cause).
    if (r.interrupted) this.restartRecords.set(r.queryId, id);
  }

  /**
   * One `compute` record per completed query, from `<agent>/planner`: the algorithm and its sim-time cost
   * explain why runs with different planning configurations diverge (ADR-0028). Cache hits are left out:
   * they are a host diagnostic and must not make traces differ (ADR-0024).
   */
  private traceOutcome(o: PlanOutcome, tick: number): void {
    if (!this.trace) return;
    const cfg = this.configs.get(o.agentId);
    const id = this.trace.sink.emit({
      source: `${o.agentId}/planner`,
      simTime: tick * this.trace.dtS,
      kind: "compute",
      agentId: o.agentId,
      detail: "full",
      payload: {
        op: "plan",
        queryId: o.queryId,
        // A strategy query names its strategy here; a plain query's record is exactly what it was before ADR-0037.
        algorithm: o.strategy ? `strategy:${o.strategy.id}@${o.strategy.version}` : cfg?.planning.algorithm,
        status: o.status,
        expansionsCharged: o.expansionsCharged,
        submittedTick: o.submittedTick,
        completedTick: o.completedTick,
        restarts: o.restarts,
        continuations: o.continuations,
        cost: o.cost,
        mapVersion: o.space.version,
        waypoints: o.waypoints,
        // The path through the strategy's tree: the conditions with their values and every search (ADR-0037 addition, item 8).
        ...(o.strategy ? { strategy: o.strategy } : {}),
      },
    });
    // The record of this outcome: a failed action that planning ended names it as its cause.
    this.outcomeRecords.set(o.queryId, id);
  }

  submit(agentId: string, q: PlanQuery, tick: number): Result<string, CodedError> {
    const cfg = this.configs.get(agentId);
    if (!cfg) return err({ code: "unknown_agent", message: `no planning configuration for ${agentId}` });
    // A window in metres becomes the cell rectangle that covers it, clipped to the map (ADR-0040): the planner never leaves it.
    const grid = this.beliefGrids.get(agentId) ?? this.knownMap.grid;
    const res = grid.resolutionM;
    const window = q.window
      ? { i0: Math.max(0, Math.floor(q.window.x0 / res)), j0: Math.max(0, Math.floor(q.window.y0 / res)), i1: Math.min(grid.sizeX, Math.ceil(q.window.x1 / res)), j1: Math.min(grid.sizeY, Math.ceil(q.window.y1 / res)) }
      : undefined;
    return this.service.submit(
      { agentId, traversal: traversalFor(cfg, q.cruiseAltitudeM), config: toPlanningConfig(cfg), from: q.from, to: q.to, ...(this.beliefGrids.has(agentId) ? { mapKey: agentId } : {}), ...(window ? { window } : {}) },
      tick,
    );
  }

  take(_agentId: string, queryId: string): PlanResult | undefined {
    const o = this.completed.get(queryId);
    if (!o) return undefined;
    this.completed.delete(queryId);
    // The plan's map is the live planning view it ran on (ADR-0024 addition of 2026-10-10): the agent's current
    // beliefs as of the last sync point, never ground truth. Version and clearance are read when checked.
    const space = o.space;
    const causeRecord = this.outcomeRecords.get(queryId);
    this.outcomeRecords.delete(queryId);
    return {
      ...(causeRecord === undefined ? {} : { causeRecord }),
      status: o.status,
      waypoints: o.waypoints,
      expansionsCharged: o.expansionsCharged,
      completedTick: o.completedTick,
      map: {
        get version() {
          return space.version;
        },
        clearanceM: (x, y, maxM) => space.clearanceM(x, y, maxM),
        passableAt: passableOn(space),
      },
    };
  }

  /**
   * The legs of a lazy plan that became ready (ADR-0037 fourth addition), or undefined for any other query. The outcome of a
   * lazy query is not kept once its legs are all out: nothing will `take` it.
   */
  takeLegs(agentId: string, queryId: string): PlanProgress | undefined {
    const p = this.service.takeLegs(agentId, queryId);
    if (!p) return undefined;
    if (p.done) this.completed.delete(queryId);
    const space = p.map;
    const causeRecord = p.interrupted ? this.restartRecords.get(queryId) : p.done ? this.outcomeRecords.get(queryId) : undefined;
    if (p.done) {
      this.outcomeRecords.delete(queryId);
      this.restartRecords.delete(queryId);
    }
    return {
      ...(causeRecord === undefined ? {} : { causeRecord }),
      legs: p.legs,
      done: p.done,
      ...(p.status ? { status: p.status } : {}),
      ...(p.interrupted ? { interrupted: p.interrupted } : {}),
      map: {
        get version() {
          return space.version;
        },
        clearanceM: (x, y, maxM) => space.clearanceM(x, y, maxM),
        passableAt: passableOn(space),
      },
      expansionsCharged: p.expansionsCharged,
      completedTick: p.completedTick,
    };
  }

  cancel(agentId: string): void {
    this.service.cancel(agentId);
  }
}

/** Whether the planner can place the vehicle at a point: the planning view's passability (inflation included), false outside the map. */
function passableOn(space: SearchSpace): (x: number, y: number) => boolean {
  const res = space.resolutionM;
  return (x, y) => space.passable(Math.floor(x / res), Math.floor(y / res));
}

/**
 * Start-time checks on a map (ADR-0005; F2 audit of 2026-10-10). On the ground truth these are exactly
 * GridSpace.isFreeForGround / isFreeForAir and the landing rule, so `ideal` agents decide as before; on a belief
 * grid, cells never observed count as free (optimistic) and obstacle tops are the believed ones.
 */
export function knownSpaceOn(g: PlanningGrid): KnownSpace {
  return {
    freeForGround: (x, y) => {
      const i = g.cellI(x);
      const j = g.cellJ(y);
      return !g.isBlocked(i, j) && g.terrainAt(i, j) !== TERRAIN_IMPASSABLE && !g.zones.outsideGeofence(x, y);
    },
    freeForAir: (x, y, z, clearanceM) => {
      const i = g.cellI(x);
      const j = g.cellJ(y);
      if (!g.inBounds(i, j) || z < g.altitudeLimitsM.min || z > g.altitudeLimitsM.max) return false;
      if (g.zones.outsideGeofence(x, y) || g.zones.isNoFly(x, y, z)) return false;
      return z >= g.obstacleTopM(i, j) + clearanceM;
    },
    landable: (x, y) => {
      const i = g.cellI(x);
      const j = g.cellJ(y);
      return g.inBounds(i, j) && !g.isBlocked(i, j) && !g.zones.outsideGeofence(x, y) && !g.zones.isNoFly(x, y, g.groundHeightM(i, j));
    },
  };
}

/**
 * Distance from (x, y) to the nearest cell a ground vehicle cannot occupy on `g` (believed or known obstacle,
 * impassable terrain, outside a geofence) or to the map edge, capped at `maxM`: exact against cell squares.
 */
export function groundClearanceOn(g: PlanningGrid, x: number, y: number, maxM: number): number {
  const res = g.resolutionM;
  let best = Math.min(maxM, x, y, g.sizeX * res - x, g.sizeY * res - y);
  if (best <= 0) return 0;
  const reach = Math.ceil(best / res);
  const ci = g.cellI(x);
  const cj = g.cellJ(y);
  const geofenced = g.zones.zones.some((z) => z.kind === "geofence");
  for (let j = cj - reach; j <= cj + reach; j++) {
    for (let i = ci - reach; i <= ci + reach; i++) {
      if (!g.inBounds(i, j)) continue;
      const blocked = g.isBlocked(i, j) || g.terrainAt(i, j) === TERRAIN_IMPASSABLE || (geofenced && g.zones.outsideGeofence(g.cellCenterX(i), g.cellCenterY(j)));
      if (!blocked) continue;
      const dx = Math.max(i * res - x, 0, x - (i + 1) * res);
      const dy = Math.max(j * res - y, 0, y - (j + 1) * res);
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
    }
  }
  return best;
}

/** SpatialPort over the ground-truth GridSpace (physical checks of the runtime, never shown to minds). */
export class GridSpatialAdapter implements SpatialPort {
  constructor(readonly grid: GridSpace) {}

  get version(): number {
    return this.grid.version;
  }

  get altitudeLimitsM(): { min: number; max: number } {
    return this.grid.altitudeLimitsM;
  }

  inBounds(x: number, y: number): boolean {
    return this.grid.inBounds(this.grid.cellI(x), this.grid.cellJ(y));
  }

  freeForGround(x: number, y: number): boolean {
    return this.grid.isFreeForGround(x, y);
  }

  freeForAir(x: number, y: number, z: number, clearanceM: number): boolean {
    return this.grid.isFreeForAir(x, y, z, clearanceM);
  }

  groundHeightM(x: number, y: number): number {
    const g = this.grid;
    return g.groundHeightM(g.cellI(x), g.cellJ(y));
  }

  insideFence(x: number, y: number, z: number): boolean {
    const g = this.grid;
    return g.inBounds(g.cellI(x), g.cellJ(y)) && !g.zones.outsideGeofence(x, y) && !g.zones.isNoFly(x, y, z);
  }

  landable(x: number, y: number): boolean {
    const g = this.grid;
    const i = g.cellI(x);
    const j = g.cellJ(y);
    return g.inBounds(i, j) && g.occupancy.get(i, j) === OCCUPANCY_FREE && !g.zones.outsideGeofence(x, y) && !g.zones.isNoFly(x, y, g.groundHeightM(i, j));
  }

  /**
   * Cells under a footprint disc that stop the body (ADR-0012 addition of 2026-10-09), as flat (i, j) pairs in
   * index order (rows, then columns): a UGV is stopped by occupied cells and impassable terrain, a UAV at z by
   * occupied cells whose obstacle top reaches z. A cell counts when the disc overlaps its square.
   */
  contactCells(x: number, y: number, z: number, radiusM: number, vehicle: "uav" | "ugv"): readonly number[] {
    const g = this.grid;
    const res = g.resolutionM;
    const out: number[] = [];
    const i0 = g.cellI(x - radiusM);
    const i1 = g.cellI(x + radiusM);
    const j0 = g.cellJ(y - radiusM);
    const j1 = g.cellJ(y + radiusM);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!g.inBounds(i, j)) continue;
        const dx = Math.max(i * res - x, 0, x - (i + 1) * res);
        const dy = Math.max(j * res - y, 0, y - (j + 1) * res);
        if (dx * dx + dy * dy >= radiusM * radiusM) continue;
        const occupied = g.occupancy.get(i, j) !== OCCUPANCY_FREE;
        const stops = vehicle === "ugv" ? occupied || g.terrainAt(i, j) === TERRAIN_IMPASSABLE : occupied && g.obstacleTopM(i, j) >= z;
        if (stops) out.push(i, j);
      }
    }
    return out;
  }

  /** Exact distance to the nearest ground-impassable cell square (occupied, terrain 0, outside geofence) or the map edge. */
  groundClearanceM(x: number, y: number, maxM: number): number {
    const g = this.grid;
    const res = g.resolutionM;
    let best = Math.min(maxM, x, y, g.widthM - x, g.heightM - y);
    if (best <= 0) return 0;
    const reach = Math.ceil(best / res);
    const ci = g.cellI(x);
    const cj = g.cellJ(y);
    const geofenced = g.zones.zones.some((z) => z.kind === "geofence");
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (let i = ci - reach; i <= ci + reach; i++) {
        if (!g.inBounds(i, j)) continue;
        const blocked = g.isBlocked(i, j) || g.terrainAt(i, j) === TERRAIN_IMPASSABLE || (geofenced && g.zones.outsideGeofence(g.cellCenterX(i), g.cellCenterY(j)));
        if (!blocked) continue;
        const dx = Math.max(i * res - x, 0, x - (i + 1) * res);
        const dy = Math.max(j * res - y, 0, y - (j + 1) * res);
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
      }
    }
    return best;
  }
}

/** The capabilities and their parameter schemas, from the generated manifest (built once: it never changes at run time). */
let menu: readonly { readonly name: string; readonly kind: "action" | "bookkeeping"; readonly paramsSchema: Readonly<Record<string, unknown>> }[] | undefined;
function capabilityMenu(): NonNullable<typeof menu> {
  menu ??= capabilityManifest().capabilities.map((c) => ({ name: c.name, kind: c.kind, paramsSchema: c.params }));
  return menu;
}

/** CapabilityPort over tools-schema (ADR-0007): the only source of capability definitions. */
export const toolsSchemaCapabilities: CapabilityPort = {
  list: () => capabilityMenu(),
  kind: (name) => getCapability(name)?.kind ?? "action",
  injectable: (name) => isInjectable(name),
  validate: (name, params) => {
    const r = validateParams(name, params);
    return r.ok ? ok(r.value) : err({ code: r.error.code, message: r.error.message });
  },
  vehicles: (name) => getCapability(name)?.vehicles ?? [],
  scope: (name): Scope => getCapability(name)?.scope ?? "self",
  preconditions: (name) => getCapability(name)?.preconditions ?? [],
};

/** TraceSink over the run's TraceBuffer, through tracer handles bound to each source (ADR-0031). */
export class TraceBufferSink implements TraceSink {
  constructor(readonly buffer: TraceBuffer) {}

  idOf(seq: number): string {
    return `${this.buffer.runId}#${seq}`;
  }

  emit(r: Parameters<TraceSink["emit"]>[0]): string {
    return this.buffer.for(r.source).append({
      simTime: r.simTime,
      kind: r.kind,
      agentId: r.agentId,
      ...(r.parentId === undefined ? {} : { parentId: r.parentId }),
      ...(r.causeIds === undefined ? {} : { causeIds: [...r.causeIds] }),
      ...(r.tier === undefined ? {} : { tier: r.tier }),
      detail: r.detail,
      payload: r.payload,
    }).id;
  }
}
