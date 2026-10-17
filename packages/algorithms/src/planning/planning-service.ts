import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { PlanningGrid } from "@agentsim/spatial";
import { compileCostProfile, DEFAULT_COST_PROFILE, type CompiledCostProfile, type CostProfile } from "../cost-profile.ts";
import { GridSearch, type GridAlgorithm, type SearchStatus } from "../grid/grid-search.ts";
import { SearchSpace, type VehicleTraversal } from "../grid/search-space.ts";
import { smoothPath } from "../grid/smoothing.ts";
import { AbstractGraph } from "../hpa/abstract-graph.ts";
import { HpaQuery } from "../hpa/hpa-query.ts";
import { checkHeuristicScale } from "../grid/heuristic-scale.ts";
import { knownFractionAlong } from "./planning-condition.ts";
import { buildConditionValues, StrategyRunner, type ConditionValues, type StageResult, type StageSpec, type StrategyPlan, type StrategyTrace } from "./strategy/runner.ts";
import { strategyFacts } from "./strategy/tree.ts";
import { checkStrategyForAgent } from "./strategy/validate.ts";

/** Per-agent planning configuration (ADR-0028 entry, resolved). */
export type PlanningAlgorithm = GridAlgorithm | { readonly kind: "hpa" };

export interface PlanningConfig {
  readonly algorithm: PlanningAlgorithm;
  readonly onboardComputeExpansionsPerTick: number;
  readonly totalBudget: number;
  readonly costProfile?: CostProfile;
  /**
   * A planning strategy (ADR-0037): when present it plans instead of `algorithm`, which then only holds the built-in
   * placeholder. Absent: every query takes the plain single-search path, exactly as before ADR-0037.
   */
  readonly strategy?: StrategyPlan;
}

export const PLANNING_LIMITS = {
  minExpansionsPerTick: 100,
  maxExpansionsPerTick: 1_000_000,
  maxTotalBudget: 10_000_000,
  minWeight: 1,
  maxWeight: 10,
} as const;

export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  algorithm: { kind: "astar" },
  onboardComputeExpansionsPerTick: 20_000,
  totalBudget: 2_000_000,
};

export type PlanningErrorCode =
  | "weight_out_of_range"
  | "budget_out_of_range"
  | "profile_feature_unsupported"
  | "invalid_profile"
  | "native_unknown"
  | "profile_degenerate"
  | "constraint_invalid"
  | "stage_budget_exceeds_total"
  | "invalid_endpoint"
  | "invalid_map";

export type PlanningError = CodedError<PlanningErrorCode>;

export interface PlanRequest {
  readonly agentId: string;
  readonly traversal: VehicleTraversal;
  readonly config: PlanningConfig;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly startDir?: number;
  /**
   * The map the agent plans on (F2): a key resolved by the service's `mapFor` (e.g. the agent's belief grid).
   * Absent: the service's own grid (the ground truth; F1, and `ideal` agents). A key, not the map, so requests
   * and snapshots stay plain data.
   */
  readonly mapKey?: string;
}

export interface PlanOutcome {
  readonly queryId: string;
  readonly agentId: string;
  readonly status: Exclude<SearchStatus, "running">;
  /** Path cells (grid indices), start first; empty unless found. */
  readonly cells: readonly number[];
  /** Smoothed waypoints in metres; empty unless found. */
  readonly waypoints: readonly (readonly [number, number])[];
  readonly cost: number;
  /** Sim-time cost of the query (ADR-0024): expansions from a cold start, cache or not. */
  readonly expansionsCharged: number;
  readonly submittedTick: number;
  readonly completedTick: number;
  /** Times the query restarted because a chunk it had read changed (or, for HPA*, its graph changed). */
  readonly restarts: number;
  /** Times the query continued onto a newer view whose changes it had not read (ADR-0024 addition of 2026-10-09). */
  readonly continuations: number;
  /** Diagnostic only; never affects results or timing. For a strategy query: every executed search came from the cache. */
  readonly cacheHit: boolean;
  /**
   * Strategy queries only (ADR-0037 addition of 2026-10-13, item 8): the path through the tree, the conditions evaluated
   * with their values and every search with its charge and ticks, of the attempt that produced this outcome. Absent for
   * a plain query, whose record is unchanged.
   */
  readonly strategy?: StrategyTrace;
  /**
   * The live planning view the query ran on (ADR-0024 addition of 2026-10-10): the planner's map, updated at the
   * run's sync points. Checks of the plan use the agent's current view, never ground truth (ADR-0005).
   */
  readonly space: SearchSpace;
}

/** A leg of a lazy `refine` that is ready to be driven (ADR-0037 fourth addition): metre waypoints, its first point the previous leg's last. */
export interface LazyPlanLeg {
  readonly index: number;
  /** Number of legs, known once the coarse path is (after thinning). */
  readonly count: number;
  readonly last: boolean;
  readonly waypoints: readonly (readonly [number, number])[];
  /** The tick its search completed. */
  readonly tick: number;
}

/** What `PlanningService.takeLegs` returns for a lazy query: the legs that became ready since the last call, and how it ended. */
export interface LazyPlanProgress {
  readonly legs: readonly LazyPlanLeg[];
  /** The query is over: the last leg is out, it failed, or it was interrupted. */
  readonly done: boolean;
  readonly status?: Exclude<SearchStatus, "running">;
  /** A map change after a leg was handed out ended the query: the action replans from where it is (ADR-0024 clarification of 2026-10-13). */
  readonly interrupted?: "map_changed";
  /** The live planning view the legs were planned on. */
  readonly map: SearchSpace;
  readonly expansionsCharged: number;
  readonly completedTick: number;
}

/** Why a query in progress restarted (traced from `<agent>/planner`). */
export interface PlanRestart {
  readonly queryId: string;
  readonly agentId: string;
  readonly tick: number;
  readonly reason: "read_set_overlap" | "graph_changed";
  /** read_set_overlap: the changed chunks the search had read. */
  readonly chunks: readonly number[];
  /** Cumulative charge before this restart (it counts against totalBudget). */
  readonly spent: number;
  /** A lazy query that had handed out a leg: it ended here instead of restarting (the action replans from where it is). */
  readonly interrupted?: true;
}

/** The union of two ascending lists of chunk indices, ascending, without repeats. */
function unionAscending(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/** Cache key of a view: the map it is over, then traversal and profile. */
function viewKey(mapKey: string, t: VehicleTraversal, profile: CompiledCostProfile): string {
  return `${mapKey}#${SearchSpace.key(t, profile)}`;
}

/** Validates a planning config against the ADR-0028 ranges and the profile; returns the compiled profile. */
export function validatePlanningConfig(c: PlanningConfig): Result<CompiledCostProfile, PlanningError> {
  const L = PLANNING_LIMITS;
  if (c.algorithm.kind === "weighted-astar" && !(c.algorithm.weight >= L.minWeight && c.algorithm.weight <= L.maxWeight)) {
    return err({ code: "weight_out_of_range", message: `weight must be in [${L.minWeight}, ${L.maxWeight}]` });
  }
  const e = c.onboardComputeExpansionsPerTick;
  if (!Number.isInteger(e) || e < L.minExpansionsPerTick || e > L.maxExpansionsPerTick) {
    return err({ code: "budget_out_of_range", message: `onboardComputeExpansionsPerTick must be an integer in [${L.minExpansionsPerTick}, ${L.maxExpansionsPerTick}]` });
  }
  if (!Number.isInteger(c.totalBudget) || c.totalBudget < e || c.totalBudget > L.maxTotalBudget) {
    return err({ code: "budget_out_of_range", message: `totalBudget must be an integer in [onboardComputeExpansionsPerTick, ${L.maxTotalBudget}]` });
  }
  const p = compileCostProfile(c.costProfile ?? DEFAULT_COST_PROFILE);
  if (!p.ok) return err({ code: p.error.code, message: p.error.message });
  if (c.algorithm.kind === "hpa" && p.value.turnAware) {
    return err({ code: "profile_feature_unsupported", message: "turn costs/constraints are not supported by hpa" });
  }
  if (c.strategy) {
    // A stage cannot be given more than the query's total, and an hpa leaf cannot run under a turn-aware profile (ADR-0037 §9).
    const s = checkStrategyForAgent(c.strategy, { totalBudget: c.totalBudget, profile: p.value });
    if (!s.ok) return err({ code: s.error.code === "stage_budget_exceeds_total" ? "stage_budget_exceeds_total" : "profile_feature_unsupported", message: s.error.message });
  }
  return ok(p.value);
}

interface Views {
  readonly id: number;
  readonly space: SearchSpace;
  graph?: AbstractGraph;
}

type Engine = GridSearch | HpaQuery;

/**
 * When a search that has just ended is noticed (ADR-0024: caches never change completion ticks). A search stops when its
 * call's budget runs out; whatever still has to happen to *end* it (finding the goal is part of the last expansion, but
 * an exhausted open list, a spent cap, or HPA*'s refinement phase need one more loop iteration) happens in the next call
 * when the last expansion landed exactly on the budget. `GridSearch` notices a found path in the call that finds it, and
 * everything else, like every `HpaQuery` ending, one call later in that case. A cached result records this once, so
 * charging it out follows the cold search tick for tick. One rule for plain queries and the searches of strategies.
 */
function needsExtraIteration(e: Engine): boolean {
  return e instanceof HpaQuery || e.status !== "found";
}

/** Whether a cached search whose charge is complete ends in this call: not when it needs one more iteration and the call's budget is spent. */
function endsInCall(extraIteration: boolean, consumed: number, left: number): boolean {
  return !extraIteration || consumed < left;
}

interface ActiveQuery {
  readonly queryId: string;
  readonly request: PlanRequest;
  readonly submittedTick: number;
  readonly key: string;
  readonly views: Views;
  readonly hpa: boolean;
  readonly startCell: number;
  readonly goalCell: number;
  /** View content version (HPA*: graph version) at the query's last slice. */
  seen: number;
  restarts: number;
  continuations: number;
  /** Charge of the current attempt. */
  charged: number;
  /** Cumulative charge of earlier attempts (restarts); with `charged`, capped by totalBudget. */
  readonly spent: number;
  /** Real search (cold path), or the cached outcome being charged out (warm path). */
  engine?: Engine;
  cached?: CachedResult;
  /** Strategy queries (ADR-0037): the runner and the stage in progress; plain queries have none and use `engine`/`cached`. */
  strat?: StrategyExec;
  /** A restored query's unexamined change, applied at its next slice (ADR-0024 addition of 2026-10-17). */
  carry?: { readonly chunks: readonly number[]; readonly read: ReadonlySet<number> | undefined } | undefined;
}

interface CachedResult {
  readonly status: Exclude<SearchStatus, "running">;
  readonly cells: readonly number[];
  readonly cost: number;
  readonly expansions: number;
  /** Chunks the search read (grid searches): a cached run continues or restarts like the real one. */
  readonly readChunks: Uint8Array | undefined;
  /** A coarse-only `hpa` stage: the cells of its abstract path. */
  readonly waypoints?: readonly number[];
  /** The cold search noticed its end only one call after its last expansion when that landed on a call's budget (see `needsExtraIteration`). */
  readonly extraIteration: boolean;
}

/** One search of a strategy query in progress. */
interface StageState {
  readonly spec: StageSpec;
  /** Effective cap: the node's `stageBudget` and what remained of the query's total when it started. */
  readonly cap: number;
  readonly startedTick: number;
  /** Expansions charged to this stage so far. */
  charged: number;
  engine?: Engine;
  cached?: CachedResult;
  /** Answered from the result cache (diagnostic). */
  readonly fromCache: boolean;
  /** Nothing was left of the total, so it ended at once with `budget_exceeded` and no engine. */
  readonly synthesized: boolean;
}

/** The legs of one lazy query, kept by query ID until the action has them all (or the query is cancelled or replaced). */
interface LazyState {
  readonly agentId: string;
  pending: LazyPlanLeg[];
  produced: number;
  taken: number;
  done: boolean;
  status?: Exclude<SearchStatus, "running">;
  interrupted?: "map_changed";
  space: SearchSpace;
  expansionsCharged: number;
  completedTick: number;
}

interface StrategyExec {
  /** Lazy refine only. */
  lazy?: LazyState;
  readonly runner: StrategyRunner;
  /** The attempt's context numbers (kept for snapshots: `known.frac` would differ on a restored map). */
  readonly context: ConditionValues;
  stage: StageState | undefined;
  /** Completed searches of this attempt, for snapshots and the restore replay. */
  readonly completed: { expansions: number; startedTick: number; endedTick: number }[];
  completedCharge: number;
  /** Union of the chunks read by every completed grid search of this attempt. */
  readUnion: Uint8Array | undefined;
  usedHpa: boolean;
  seenSpace: number;
  seenGraph: number;
  /** Every executed search came from the cache. */
  allCached: boolean;
  executed: number;
}

/**
 * A change of a query's view that the query has not examined yet (ADR-0024 addition of 2026-10-17): the chunks whose
 * planning content changed since its last slice (ascending) and whether its HPA* graph moved. Views are synced after
 * sensing and a query reads the change at the start of its next slice, so at a tick boundary this is the normal state.
 */
export interface PendingChange {
  readonly chunks: readonly number[];
  readonly graphChanged: boolean;
}

/** What a snapshot keeps of a strategy query beyond its request (ADR-0037 addition, item 9). */
export interface StrategySnapshot {
  readonly context: Readonly<Record<string, number>>;
  readonly stages: readonly { readonly expansions: number; readonly startedTick: number; readonly endedTick: number }[];
  readonly current?: { readonly charged: number; readonly startedTick: number };
  /** Lazy refine: how many legs were produced and how many were taken by the action. */
  readonly legs?: { readonly produced: number; readonly taken: number };
  /** The change of its view the query has not examined (ADR-0037 addition of 2026-10-17); absent when there is none. */
  readonly pending?: PendingChange;
  /**
   * With a non-empty `pending.chunks`, when the query has a read set: the chunks its searches have read so far (the union over
   * the completed searches and the current stage), ascending. Absent: no read set yet (as for a query without an engine).
   */
  readonly read?: readonly number[];
}

export interface PlanningServiceOptions {
  /** Disable all caches (query results and precomputed views): results and timing must not change. */
  readonly cachesEnabled?: boolean;
  /** Distinct (vehicle, profile) views kept per map (abstract graphs per profile, ADR-0024 LRU). */
  readonly viewCacheSize?: number;
  readonly resultCacheSize?: number;
  /** Resolves a request's `mapKey` (F2: each agent's belief grid). Unknown keys fail the query with `invalid_map`. */
  readonly mapFor?: (key: string) => PlanningGrid | undefined;
  /**
   * Test mode: every new view is checked with `checkHeuristicScale` (ADR-0037 addition, §7) and a view whose heuristic
   * scale is not admissible throws. A full scan of the view per build, so off by default.
   */
  readonly checkAdmissibility?: boolean;
}

/** A view to build before tick 0: the planner's view of a body under one planning configuration. */
export interface PrepareTarget {
  readonly traversal: VehicleTraversal;
  readonly config: PlanningConfig;
  /** The map the view is over (default: the service's own grid). */
  readonly mapKey?: string;
}

/** Snapshot of the service (ADR-0024): no caches, no search frontiers — only (request, expansions charged). */
export interface PlanningSnapshot {
  readonly nextQuery: number;
  readonly active: readonly {
    readonly queryId: string;
    readonly request: PlanRequest;
    readonly submittedTick: number;
    readonly charged: number;
    readonly restarts: number;
    readonly continuations: number;
    readonly spent: number;
    /** Strategy queries only. */
    readonly strategy?: StrategySnapshot;
    /** Plain queries: the change of its view the query has not examined; absent when there is none (ADR-0024 addition of 2026-10-17). */
    readonly pending?: PendingChange;
    /** Plain queries, with a non-empty `pending.chunks`: the chunks its search has read so far, ascending; absent: no read set. */
    readonly read?: readonly number[];
  }[];
}

/**
 * Plans for every agent within its own onboard compute budget (ADR-0024, ADR-0028). One active query per
 * agent (a new submission replaces the previous one). Caches save wall time only: a cache hit is charged
 * the expansions the query originally cost, so results and completion ticks are identical with caches on
 * or off, any cache size, and after a snapshot restore.
 */
export class PlanningService {
  private readonly active = new Map<string, ActiveQuery>();
  private readonly completed: PlanOutcome[] = [];
  private readonly restartEvents: PlanRestart[] = [];
  private readonly views = new Map<string, Views>();
  private nextViewId = 1;
  /** Each agent's last completed plan's views: kept in sync even if evicted, since the agent checks its plan on them. */
  private readonly retained = new Map<string, Views>();
  private readonly results = new Map<string, CachedResult>();
  private nextQuery = 1;
  private readonly cachesEnabled: boolean;
  /** View keys built by `prepare`: kept whatever the LRU size, so no prepared structure is built again in a tick. */
  private readonly pinned = new Set<string>();
  /** Lazy queries' legs, by query ID. */
  private readonly lazy = new Map<string, LazyState>();
  /** Views and HPA* graphs built from scratch (local syncs not counted). Diagnostic only. */
  readonly diagnostics = { viewsBuilt: 0, graphsBuilt: 0 };

  constructor(
    readonly grid: PlanningGrid,
    private readonly opts: PlanningServiceOptions = {},
  ) {
    this.cachesEnabled = opts.cachesEnabled ?? true;
  }

  /** The map a request plans on: its `mapKey`'s map, or the service's own grid. */
  private mapOf(mapKey: string | undefined): PlanningGrid | undefined {
    return mapKey === undefined ? this.grid : this.opts.mapFor?.(mapKey);
  }

  /**
   * Builds the planning views (and HPA* graphs, for targets planning with `hpa`) these targets use, before
   * tick 0 (ADR-0024: "at scenario load"), and keeps them cached for the run. Costs wall time only: results
   * and completion ticks are the same as building on first use. With caches off (a test mode) it does nothing.
   * `onProgress` is called with (0, total), then after each distinct view.
   */
  prepare(targets: readonly PrepareTarget[], onProgress?: (done: number, total: number) => void): Result<{ views: number; graphs: number }, PlanningError> {
    const distinct = new Map<string, { traversal: VehicleTraversal; profile: CompiledCostProfile; needGraph: boolean; map: PlanningGrid; mapKey: string }>();
    for (const t of targets) {
      const p = validatePlanningConfig(t.config);
      if (!p.ok) return p;
      const map = this.mapOf(t.mapKey);
      if (!map) return err({ code: "invalid_map", message: `no map "${t.mapKey ?? ""}"` });
      const mapKey = t.mapKey ?? "";
      const key = viewKey(mapKey, t.traversal, p.value);
      const needGraph = t.config.strategy ? strategyFacts(t.config.strategy.root).hpa : t.config.algorithm.kind === "hpa";
      const prev = distinct.get(key);
      if (prev) prev.needGraph ||= needGraph;
      else distinct.set(key, { traversal: t.traversal, profile: p.value, needGraph, map, mapKey });
    }
    if (!this.cachesEnabled) return ok({ views: 0, graphs: 0 });
    const total = distinct.size;
    onProgress?.(0, total);
    let done = 0;
    let graphs = 0;
    for (const [key, d] of distinct) {
      this.pinned.add(key);
      this.viewsFor(d.map, d.mapKey, d.traversal, d.profile, d.needGraph);
      if (d.needGraph) graphs++;
      onProgress?.(++done, total);
    }
    return ok({ views: total, graphs });
  }

  /** Submits a query at `tick`; replaces the agent's query in progress. */
  submit(request: PlanRequest, tick: number): Result<string, PlanningError> {
    const queryId = `plan-${String(this.nextQuery).padStart(6, "0")}`;
    this.dropLegs(request.agentId); // a new submission replaces the agent's query and any legs it left behind
    const r = this.start(request, tick, queryId, { charged: 0, restarts: 0, continuations: 0, spent: 0 });
    if (!r.ok) return r;
    this.nextQuery++;
    return ok(queryId);
  }

  /**
   * The live view an agent's queries use for this traversal and planning configuration (created if needed, never
   * synced here): the agent's current planning view, which plan checks read (ADR-0024 addition of 2026-10-10).
   */
  view(mapKey: string | undefined, traversal: VehicleTraversal, config: PlanningConfig): Result<SearchSpace, PlanningError> {
    const profile = validatePlanningConfig(config);
    if (!profile.ok) return profile;
    const g = this.mapOf(mapKey);
    if (!g) return err({ code: "invalid_map", message: `no map "${mapKey ?? ""}"` });
    return ok(this.viewsFor(g, mapKey ?? "", traversal, profile.value, false).space);
  }

  /**
   * One of the run's fixed sync points (ADR-0024 addition of 2026-10-10): brings every live view and graph up to
   * date with its map, in place. Called after sensing and at the start of the planning phase (`tick`).
   */
  syncViews(): void {
    const done = new Set<Views>();
    const syncOne = (v: Views) => {
      if (done.has(v)) return;
      done.add(v);
      if (v.graph) v.graph.sync();
      else v.space.sync();
    };
    for (const v of this.views.values()) syncOne(v);
    for (const id of [...this.active.keys()].sort()) {
      const q = this.active.get(id);
      if (q) syncOne(q.views);
    }
    for (const id of [...this.retained.keys()].sort()) {
      const v = this.retained.get(id);
      if (v) syncOne(v);
    }
  }

  private start(
    request: PlanRequest,
    tick: number,
    queryId: string,
    prior: { readonly charged: number; readonly restarts: number; readonly continuations: number; readonly spent: number },
    /** Strategy queries: the tick the attempt starts in (restarts), and the snapshot to replay (restore). */
    strategy?: { readonly now: number; readonly replay?: StrategySnapshot },
  ): Result<ActiveQuery, PlanningError> {
    if (request.config.strategy) return this.startStrategy(request, tick, queryId, prior, strategy?.now ?? tick, strategy?.replay);
    const profile = validatePlanningConfig(request.config);
    if (!profile.ok) return profile;
    const g = this.mapOf(request.mapKey);
    if (!g) return err({ code: "invalid_map", message: `no map "${request.mapKey ?? ""}"` });
    const mapKey = request.mapKey ?? "";
    const si = g.cellI(request.from.x);
    const sj = g.cellJ(request.from.y);
    const ti = g.cellI(request.to.x);
    const tj = g.cellJ(request.to.y);
    if (!g.inBounds(si, sj) || !g.inBounds(ti, tj)) return err({ code: "invalid_endpoint", message: "start or goal outside the map" });
    const hpa = request.config.algorithm.kind === "hpa";
    const views = this.viewsFor(g, mapKey, request.traversal, profile.value, hpa);
    const start = sj * g.sizeX + si;
    const goal = tj * g.sizeX + ti;
    const alg = request.config.algorithm;
    const remaining = request.config.totalBudget - prior.spent;
    const q: ActiveQuery = {
      queryId,
      request,
      submittedTick: tick,
      key: this.resultKey(mapKey, views, request, profile.value, start, goal),
      views,
      hpa,
      startCell: start,
      goalCell: goal,
      seen: hpa ? (views.graph?.version ?? 0) : views.space.contentVersion,
      restarts: prior.restarts,
      continuations: prior.continuations,
      charged: prior.charged,
      spent: prior.spent,
    };
    // Only first attempts use the result cache: a restarted query has a reduced budget.
    const hit = this.cachesEnabled && prior.spent === 0 ? this.results.get(q.key) : undefined;
    if (hit) q.cached = hit;
    else {
      q.engine = hpa
        ? new HpaQuery(views.graph ?? new AbstractGraph(views.space), start, goal, remaining)
        : new GridSearch(views.space, start, goal, alg as GridAlgorithm, remaining, { trackReads: true, ...(request.startDir === undefined ? {} : { startDir: request.startDir }) });
      // Restore: deterministically re-run the search to the expansions already charged (wall time only).
      if (prior.charged > 0) q.engine.step(prior.charged);
    }
    this.active.set(request.agentId, q);
    return ok(q);
  }

  /** Result-cache key: the view's identity and content version, so a hit requires an identical view. */
  private resultKey(mapKey: string, views: Views, request: PlanRequest, profile: CompiledCostProfile, start: number, goal: number): string {
    const alg = request.config.algorithm;
    return `${mapKey}#${views.id}.${views.space.contentVersion}|${SearchSpace.key(request.traversal, profile)}|${JSON.stringify(alg)}|${request.config.totalBudget}|${start}|${goal}|${request.startDir ?? -1}`;
  }

  /** Live views for the map (created on first use; synced only at the sync points). */
  private viewsFor(g: PlanningGrid, mapKey: string, t: VehicleTraversal, profile: CompiledCostProfile, needGraph: boolean): Views {
    if (!this.cachesEnabled) {
      const space = this.checked(new SearchSpace(g, t, profile));
      return needGraph ? { id: this.nextViewId++, space, graph: new AbstractGraph(space) } : { id: this.nextViewId++, space };
    }
    const key = viewKey(mapKey, t, profile);
    let views = this.views.get(key);
    if (!views) {
      views = { id: this.nextViewId++, space: this.checked(new SearchSpace(g, t, profile)) };
      this.diagnostics.viewsBuilt++;
    }
    if (needGraph && !views.graph) {
      views.graph = new AbstractGraph(views.space);
      this.diagnostics.graphsBuilt++;
    }
    this.views.delete(key);
    this.views.set(key, views); // most recently used last
    // Evict this map's least recently used views beyond the LRU size (per map: agents never evict each other's
    // belief views); prepared (pinned) views are never evicted. A query in progress keeps its own view.
    const prefix = `${mapKey}#`;
    let mine = 0;
    for (const k of this.views.keys()) if (k.startsWith(prefix) && !this.pinned.has(k)) mine++;
    let excess = mine - (this.opts.viewCacheSize ?? 4);
    for (const k of this.views.keys()) {
      if (excess <= 0) break;
      if (!k.startsWith(prefix) || this.pinned.has(k)) continue;
      this.views.delete(k);
      excess--;
    }
    return views;
  }

  /**
   * Advances every agent's query by its own budget at `tick` (agents in id order). First the planning phase's sync
   * point; then, at the start of each slice (never mid-slice), the read-set check (ADR-0024 addition of
   * 2026-10-09): a query continues if none of the chunks it read changed since its last slice, and restarts from
   * zero otherwise, its cumulative charge capped by totalBudget.
   */
  /**
   * What the planning phase of the latest tick spent (diagnostics for the HUD; never traced, hashed or read by the
   * simulation): expansions charged, the budget of the queries that were stepped, and how many there were.
   */
  readonly lastTick = { expansions: 0, budget: 0, queries: 0 };

  tick(tick: number): void {
    this.syncViews();
    let spent = 0;
    let budgeted = 0;
    let stepped = 0;
    for (const agentId of [...this.active.keys()].sort()) {
      let q = this.active.get(agentId);
      if (!q) continue;
      const change = this.changeSinceLastSlice(q);
      if (change) {
        const spent = q.spent + q.charged;
        // A lazy query that has handed out a leg is interrupted, not restarted: the action replans from where it is.
        const interrupting = q.strat?.lazy !== undefined && q.strat.lazy.produced > 0;
        this.restartEvents.push({ queryId: q.queryId, agentId, tick, reason: change.reason, chunks: change.chunks, spent, ...(interrupting ? { interrupted: true as const } : {}) });
        if (interrupting) {
          this.interrupt(q, tick);
          continue;
        }
        if (spent >= q.request.config.totalBudget) {
          this.complete({ ...q, restarts: q.restarts + 1, charged: 0, spent }, { status: "budget_exceeded", cells: [], cost: Number.POSITIVE_INFINITY, expansions: 0, readChunks: undefined, extraIteration: false }, tick, false);
          continue;
        }
        const r = this.start(q.request, q.submittedTick, q.queryId, { charged: 0, restarts: q.restarts + 1, continuations: q.continuations, spent }, { now: tick });
        if (!r.ok) {
          this.active.delete(agentId);
          continue;
        }
        q = r.value;
      }
      const budget = q.request.config.onboardComputeExpansionsPerTick;
      stepped++;
      budgeted += budget;
      if (q.strat) {
        spent += this.stepStrategy(q, q.strat, tick);
        continue;
      }
      if (q.cached) {
        const before = q.charged;
        q.charged = Math.min(q.cached.expansions, q.charged + budget);
        spent += q.charged - before;
        if (q.charged === q.cached.expansions && endsInCall(q.cached.extraIteration, q.charged - before, budget)) this.complete(q, q.cached, tick, true);
        continue;
      }
      const e = q.engine;
      if (!e) continue;
      const before = e.expanded;
      e.step(budget);
      spent += e.expanded - before;
      q.charged = e.expanded;
      if (e.status !== "running") {
        const result: CachedResult = { status: e.status, cells: e.path(), cost: e.cost, expansions: e.expanded, readChunks: e instanceof GridSearch ? e.readChunks?.slice() : undefined, extraIteration: needsExtraIteration(e) };
        // Only first attempts are cached (see `start`), keyed by the view as it is now: a continued query's result
        // equals a cold run on this view.
        if (this.cachesEnabled && q.spent === 0) {
          this.results.set(this.resultKey(q.request.mapKey ?? "", q.views, q.request, q.views.space.profile, q.startCell, q.goalCell), result);
          while (this.results.size > (this.opts.resultCacheSize ?? 256)) {
            const oldest = this.results.keys().next().value;
            if (oldest === undefined) break;
            this.results.delete(oldest);
          }
        }
        this.complete(q, result, tick, false);
      }
    }
    this.lastTick.expansions = spent;
    this.lastTick.budget = budgeted;
    this.lastTick.queries = stepped;
  }

  /** What changed under a query since its last slice that it depends on, or undefined (it continues). */
  private changeSinceLastSlice(q: ActiveQuery): { reason: PlanRestart["reason"]; chunks: number[] } | undefined {
    if (q.strat) return this.changeForStrategy(q, q.strat);
    const carry = q.carry; // a restored query's unexamined change, applied once
    q.carry = undefined;
    if (q.hpa) {
      const v = q.views.graph?.version ?? 0;
      if (v === q.seen) return undefined;
      q.seen = v;
      return { reason: "graph_changed", chunks: [] };
    }
    const space = q.views.space;
    const moved = space.contentVersion !== q.seen;
    if (!moved && !carry) return undefined;
    const changed = unionAscending(carry?.chunks ?? [], moved ? space.changedSince(q.seen) : []);
    q.seen = space.contentVersion;
    const read = q.cached ? q.cached.readChunks : q.engine instanceof GridSearch ? q.engine.readChunks : undefined;
    const overlap = read || carry?.read ? changed.filter((k) => read?.[k] === 1 || carry?.read?.has(k) === true) : changed;
    if (overlap.length === 0) {
      q.continuations++;
      return undefined;
    }
    return { reason: "read_set_overlap", chunks: overlap };
  }

  /**
   * What the service holds for its caller to take: completed outcomes and restart events (taken every tick by the adapter)
   * and legs of lazy queries that were produced and not yet taken. Between ticks all are zero; a snapshot of the caller
   * asserts it (a snapshot does not keep them).
   */
  pendingOutputs(): { readonly completed: number; readonly restarts: number; readonly legs: number } {
    let legs = 0;
    for (const l of this.lazy.values()) legs += l.pending.length;
    return { completed: this.completed.length, restarts: this.restartEvents.length, legs };
  }

  /** Restarts since the last call, in order (tick, then agent id). */
  takeRestarts(): PlanRestart[] {
    return this.restartEvents.splice(0);
  }

  private complete(q: ActiveQuery, r: CachedResult, tick: number, cacheHit: boolean): void {
    this.active.delete(q.request.agentId);
    const ls = q.strat?.lazy;
    if (ls) {
      ls.done = true;
      ls.status = r.status;
      ls.expansionsCharged = q.spent + r.expansions;
      ls.completedTick = tick;
    }
    this.retained.set(q.request.agentId, q.views);
    const waypoints = r.status === "found" ? this.smooth(q.views.space, r.cells) : [];
    this.smoothMemo = undefined; // not kept: it would pin the view of a finished query
    this.completed.push({
      queryId: q.queryId,
      agentId: q.request.agentId,
      status: r.status,
      cells: r.cells,
      waypoints,
      cost: r.cost,
      expansionsCharged: q.spent + r.expansions,
      submittedTick: q.submittedTick,
      completedTick: tick,
      restarts: q.restarts,
      continuations: q.continuations,
      cacheHit,
      space: q.views.space,
      ...(q.strat ? { strategy: q.strat.runner.trace() } : {}),
    });
  }

  /** Completed outcomes since the last call, in completion order (tick, then agent id). */
  takeCompleted(): PlanOutcome[] {
    return this.completed.splice(0);
  }

  isPlanning(agentId: string): boolean {
    return this.active.has(agentId);
  }

  cancel(agentId: string): void {
    this.dropLegs(agentId);
    this.active.delete(agentId);
  }

  /** Forgets every lazy query of the agent (running, or finished with legs nobody took). */
  private dropLegs(agentId: string): void {
    if (this.lazy.size === 0) return;
    for (const [id, ls] of this.lazy) if (ls.agentId === agentId) this.lazy.delete(id);
  }

  /**
   * The legs of a lazy query that became ready since the last call (each is returned once), with how the query stands:
   * `done` once the last leg is out, the query failed, or it was interrupted by a map change. `undefined` for any other
   * query, and while there is nothing new. `take` is unaffected: the whole outcome is still returned once everything is
   * planned (ADR-0037 fourth addition, item 2).
   */
  takeLegs(agentId: string, queryId: string): LazyPlanProgress | undefined {
    const ls = this.lazy.get(queryId);
    if (!ls || ls.agentId !== agentId) return undefined;
    const legs = ls.pending;
    ls.pending = [];
    ls.taken += legs.length;
    if (legs.length === 0 && !ls.done) return undefined;
    if (ls.done) this.lazy.delete(queryId);
    return {
      legs,
      done: ls.done,
      ...(ls.status ? { status: ls.status } : {}),
      ...(ls.interrupted ? { interrupted: ls.interrupted } : {}),
      map: ls.space,
      expansionsCharged: ls.expansionsCharged,
      completedTick: ls.completedTick,
    };
  }

  /** A lazy query that had handed out a leg ends here (ADR-0024 clarification of 2026-10-13); its pending legs are stale. */
  private interrupt(q: ActiveQuery, tick: number): void {
    const ls = q.strat?.lazy;
    if (ls) {
      ls.pending = [];
      ls.done = true;
      ls.interrupted = "map_changed";
      ls.expansionsCharged = q.spent + q.charged;
      ls.completedTick = tick;
    }
    this.active.delete(q.request.agentId);
    this.retained.set(q.request.agentId, q.views);
  }

  snapshot(): PlanningSnapshot {
    return {
      nextQuery: this.nextQuery,
      active: [...this.active.values()]
        .sort((a, b) => (a.request.agentId < b.request.agentId ? -1 : 1))
        .map((q) => {
          const pc = this.pendingChange(q);
          const carried = pc ? { pending: pc.pending, ...(pc.read ? { read: pc.read } : {}) } : {};
          return {
            queryId: q.queryId,
            request: q.request,
            submittedTick: q.submittedTick,
            charged: q.charged,
            restarts: q.restarts,
            continuations: q.continuations,
            spent: q.spent,
            ...(q.strat ? { strategy: { ...this.strategySnapshot(q.strat), ...carried } } : carried),
          };
        }),
    };
  }

  /**
   * Restores a snapshot taken on the same grid state (the world snapshot restores the grid first); every
   * in-progress search is re-run deterministically to the expansions it had been charged.
   */
  restore(s: PlanningSnapshot): void {
    this.active.clear();
    this.completed.length = 0;
    this.lazy.clear();
    this.nextQuery = s.nextQuery;
    for (const a of s.active) {
      const r = this.start(
        a.request,
        a.submittedTick,
        a.queryId,
        { charged: a.charged, restarts: a.restarts, continuations: a.continuations, spent: a.spent },
        a.strategy ? { now: a.submittedTick, replay: a.strategy } : undefined,
      );
      if (!r.ok) throw new Error(`snapshot query ${a.queryId} no longer valid: ${r.error.code}`);
      // The change the query had not examined: its next slice applies the read-set check to these sets.
      const carried = a.strategy ?? a;
      if (carried.pending) {
        r.value.carry = { chunks: [...carried.pending.chunks], read: carried.read ? new Set(carried.read) : undefined };
        // A moved graph comes back as a last-seen version no graph has (versions start at 0): the next comparison finds it moved,
        // exactly when the live query's would (a strategy: once an HPA* stage has run, which may be later than the next slice).
        if (carried.pending.graphChanged) {
          if (r.value.strat) r.value.strat.seenGraph = -1;
          else r.value.seen = -1;
        }
      }
    }
  }

  /**
   * What a query has not examined yet, for a snapshot (ADR-0024 addition of 2026-10-17): the chunks its view changed in
   * since its last slice and whether its graph moved, with the chunks its search has read. A restored query that has not had
   * its next slice yet still carries the change it was restored with, so a snapshot of it keeps that change together with any
   * newer one: `snapshot(restore(s))` equals `s`. Reads, changes nothing.
   */
  private pendingChange(q: ActiveQuery): { readonly pending: PendingChange; readonly read: number[] | undefined } | undefined {
    const st = q.strat;
    if (!st && q.hpa) return (q.views.graph?.version ?? 0) !== q.seen ? { pending: { chunks: [], graphChanged: true }, read: undefined } : undefined;
    // A strategy compares the graph's version with the one it last saw even before an HPA* stage has run; the comparison only
    // acts once one has (`changeForStrategy`), so the plain inequality is what the snapshot keeps.
    const graphChanged = st !== undefined && (q.views.graph?.version ?? 0) !== st.seenGraph;
    const space = q.views.space;
    const seen = st ? st.seenSpace : q.seen;
    const carry = q.carry;
    const chunks = unionAscending(carry?.chunks ?? [], space.contentVersion !== seen ? space.changedSince(seen) : []);
    if (chunks.length === 0 && !graphChanged) return undefined;
    let flags: readonly (Uint8Array | undefined)[];
    if (st) {
      const stage = st.stage;
      flags = [st.readUnion, stage ? (stage.cached ? stage.cached.readChunks : stage.engine instanceof GridSearch ? stage.engine.readChunks : undefined) : undefined];
    } else flags = [q.cached ? q.cached.readChunks : q.engine instanceof GridSearch ? q.engine.readChunks : undefined];
    let read: number[] | undefined;
    if (chunks.length > 0) {
      if (carry) {
        // A restored query that has not sliced yet has read exactly what it was restored with: the search that was replayed on the
        // changed content may have read other chunks, and it has not advanced since.
        read = carry.read ? [...carry.read].sort((a, b) => a - b) : undefined;
      } else if (flags.some((f) => f !== undefined)) {
        read = [];
        const n = Math.max(...flags.map((f) => f?.length ?? 0));
        for (let k = 0; k < n; k++) if (flags.some((f) => f?.[k] === 1)) read.push(k);
      }
    }
    return { pending: { chunks, graphChanged }, read };
  }

  // ---- Planning strategies (ADR-0037 and its additions of 2026-10-13) --------------------------------------------------
  // A strategy query is a sequence of ordinary searches chosen by the pure `StrategyRunner`. The service runs each one
  // under ADR-0024's rules, charges its expansions, and tells the runner. Nothing below runs for a plain query.

  /** Test mode `checkAdmissibility`: a view whose heuristic scale is not admissible is a programmer error. */
  private checked(space: SearchSpace): SearchSpace {
    if (this.opts.checkAdmissibility) {
      const r = checkHeuristicScale(space);
      if (!r.ok) throw new Error(r.error.message);
    }
    return space;
  }

  private strategySnapshot(st: StrategyExec): StrategySnapshot {
    return {
      context: { ...st.context },
      stages: st.completed.map((c) => ({ ...c })),
      ...(st.stage ? { current: { charged: st.stage.charged, startedTick: st.stage.startedTick } } : {}),
      ...(st.lazy ? { legs: { produced: st.lazy.produced, taken: st.lazy.taken } } : {}),
    };
  }

  /** The last smoothed path. A query's final search is smoothed for its trace geometry and again for its outcome, from equal cells. */
  private smoothMemo: { readonly space: SearchSpace; readonly cells: readonly number[]; readonly path: ReturnType<typeof smoothPath> } | undefined;

  /**
   * `smoothPath` once per (view, cells): it is pure, so a second call on equal cells returns the same path. Equality is an exact
   * element-wise comparison, linear in the path; smoothing is not (line-of-sight checks along it).
   */
  private smooth(space: SearchSpace, cells: readonly number[]): ReturnType<typeof smoothPath> {
    const m = this.smoothMemo;
    if (m && m.space === space && (m.cells === cells || (m.cells.length === cells.length && m.cells.every((c, i) => c === cells[i])))) return m.path;
    const path = smoothPath(space, cells);
    this.smoothMemo = { space, cells, path };
    return path;
  }

  /**
   * The path of a found search for the trace (ADR-0037 seventh addition, item 14): smoothed, in metres, rounded to 1 cm and
   * thinned to at most 128 points (a fixed stride, the last point kept). A coarse-only hpa search has no cells: its abstract
   * path is the geometry.
   */
  private stageGeometry(space: SearchSpace, spec: StageSpec, result: StageResult): [number, number][] {
    const g = space.grid;
    const metres: [number, number][] = spec.coarseOnly
      ? (result.waypoints ?? []).map((c): [number, number] => [g.cellCenterX(c % g.sizeX), g.cellCenterY(Math.floor(c / g.sizeX))])
      : this.smooth(space, result.cells).map(([x, y]): [number, number] => [x, y]);
    const rounded = metres.map(([x, y]): [number, number] => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    if (rounded.length <= 128) return rounded;
    const stride = Math.ceil((rounded.length - 1) / 127);
    const out: [number, number][] = [];
    for (let i = 0; i < rounded.length - 1; i += stride) {
      const p = rounded[i];
      if (p) out.push(p);
    }
    const last = rounded.at(-1);
    if (last) out.push(last);
    return out;
  }

  /** The waypoints of a path as cells: its smoothed path (ADR-0037 addition, §6). */
  private waypointCells(space: SearchSpace, cells: readonly number[]): number[] {
    const g = space.grid;
    const out: number[] = [];
    for (const [x, y] of smoothPath(space, cells)) out.push(g.cellJ(y) * g.sizeX + g.cellI(x));
    return out;
  }

  private startStrategy(
    request: PlanRequest,
    tick: number,
    queryId: string,
    prior: { readonly charged: number; readonly restarts: number; readonly continuations: number; readonly spent: number },
    now: number,
    replay: StrategySnapshot | undefined,
  ): Result<ActiveQuery, PlanningError> {
    const profile = validatePlanningConfig(request.config);
    if (!profile.ok) return profile;
    const strategy = request.config.strategy;
    if (!strategy) return err({ code: "invalid_profile", message: "no strategy in the request" }); // the caller checked
    const facts = strategyFacts(strategy.root);
    const g = this.mapOf(request.mapKey);
    if (!g) return err({ code: "invalid_map", message: `no map "${request.mapKey ?? ""}"` });
    const mapKey = request.mapKey ?? "";
    const si = g.cellI(request.from.x);
    const sj = g.cellJ(request.from.y);
    const ti = g.cellI(request.to.x);
    const tj = g.cellJ(request.to.y);
    if (!g.inBounds(si, sj) || !g.inBounds(ti, tj)) return err({ code: "invalid_endpoint", message: "start or goal outside the map" });
    const views = this.viewsFor(g, mapKey, request.traversal, profile.value, facts.hpa);
    const start = sj * g.sizeX + si;
    const goal = tj * g.sizeX + ti;
    // The attempt's context (ADR-0037 §2): planner inputs at query start; a restore replays the stored numbers instead.
    const dx = request.to.x - request.from.x;
    const dy = request.to.y - request.from.y;
    const context =
      replay?.context ??
      buildConditionValues({
        distM: Math.sqrt(dx * dx + dy * dy),
        vehicle: request.traversal.vehicle,
        altitudeM: request.traversal.vehicle === "uav" ? request.traversal.cruiseAltitudeM : 0,
        profileWeights: profile.value.weights,
        totalBudget: request.config.totalBudget,
        replanCount: prior.restarts,
        knownFrac: knownFractionAlong(g, request.from, request.to),
      });
    const space = views.space;
    const runner = new StrategyRunner({
      strategy,
      context,
      from: start,
      to: goal,
      ...(request.startDir === undefined ? {} : { startDir: request.startDir }),
      sizeX: g.sizeX,
      deps: { waypointsOf: (cells) => this.waypointCells(space, cells) },
    });
    let lazy: LazyState | undefined;
    if (facts.lazyRefine) {
      // Legs live under the query's ID: a restart (only possible before the first leg is out) keeps the record.
      lazy = replay ? undefined : this.lazy.get(queryId);
      lazy ??= { agentId: request.agentId, pending: [], produced: 0, taken: 0, done: false, space, expansionsCharged: 0, completedTick: 0 };
      lazy.space = space;
      this.lazy.set(queryId, lazy);
    }
    const st: StrategyExec = {
      ...(lazy ? { lazy } : {}),
      runner,
      context,
      stage: undefined,
      completed: [],
      completedCharge: 0,
      readUnion: undefined,
      usedHpa: false,
      seenSpace: space.contentVersion,
      seenGraph: views.graph?.version ?? 0,
      allCached: true,
      executed: 0,
    };
    const q: ActiveQuery = {
      queryId,
      request,
      submittedTick: tick,
      key: "",
      views,
      hpa: false,
      startCell: start,
      goalCell: goal,
      seen: space.contentVersion,
      restarts: prior.restarts,
      continuations: prior.continuations,
      charged: 0,
      spent: prior.spent,
      strat: st,
    };
    if (replay) {
      this.replayStrategy(q, st, replay);
      if (lazy && replay.legs) {
        if (lazy.produced !== replay.legs.produced) throw new Error(`snapshot of ${queryId} produced ${replay.legs.produced} legs, its replay ${lazy.produced}`);
        lazy.pending.splice(0, replay.legs.taken); // the legs the action already took are not handed out again
        lazy.taken = replay.legs.taken;
      }
    } else {
      // The first search starts now, like a plain query's engine (cache lookup included).
      const spec = runner.current();
      if (spec) st.stage = this.beginStage(q, st, spec, now, false);
    }
    this.active.set(request.agentId, q);
    return ok(q);
  }

  /**
   * Restores a strategy query from a snapshot: every completed search is re-run deterministically to the expansions it
   * was charged and handed to the runner with its ticks, then the search in progress is re-run to its charge.
   */
  private replayStrategy(q: ActiveQuery, st: StrategyExec, replay: StrategySnapshot): void {
    for (const c of replay.stages) {
      const spec = st.runner.current();
      if (!spec) throw new Error("snapshot has more searches than its strategy runs");
      const stage = this.beginStage(q, st, spec, c.startedTick, true);
      const e = stage.engine;
      if (e) {
        while (e.status === "running") e.step(1 << 20);
        stage.charged = e.expanded;
      } else stage.charged = stage.cached?.expansions ?? 0;
      if (stage.charged !== c.expansions) throw new Error(`snapshot search at ${spec.path} no longer reproduces (${stage.charged} expansions, was ${c.expansions})`);
      this.finishStage(q, st, stage, c.endedTick);
    }
    if (replay.current) {
      const spec = st.runner.current();
      if (!spec) throw new Error("snapshot has a search in progress that its strategy does not run");
      const stage = this.beginStage(q, st, spec, replay.current.startedTick, true);
      if (stage.engine) {
        stage.engine.step(replay.current.charged);
        stage.charged = stage.engine.expanded;
      }
      st.stage = stage;
      q.charged = st.completedCharge + stage.charged;
    }
  }

  /** Cache key of one search of a strategy: the view and its content version, the search and its effective cap. */
  private stageKey(q: ActiveQuery, spec: StageSpec, cap: number): string {
    const v = q.views;
    return `S|${q.request.mapKey ?? ""}#${v.id}.${v.space.contentVersion}|${SearchSpace.key(q.request.traversal, v.space.profile)}|${spec.algorithm}:${spec.weight ?? ""}:${spec.heuristic}:${spec.coarseOnly ? 1 : 0}|${cap}|${spec.from}|${spec.to}|${spec.startDir ?? -1}`;
  }

  /** Starts the search the runner asked for: from the result cache (charged out like a real one) or as a new engine. */
  private beginStage(q: ActiveQuery, st: StrategyExec, spec: StageSpec, tick: number, forceCold: boolean): StageState {
    if (spec.algorithm === "hpa") st.usedHpa = true;
    const remaining = q.request.config.totalBudget - q.spent - st.completedCharge;
    const cap = Math.min(spec.stageBudget ?? Number.POSITIVE_INFINITY, remaining);
    if (cap <= 0) {
      // Nothing is left to spend: the search ends at once with budget_exceeded (no engine is built for it).
      const cached: CachedResult = { status: "budget_exceeded", cells: [], cost: Number.POSITIVE_INFINITY, expansions: 0, readChunks: undefined, extraIteration: false };
      return { spec, cap: 0, startedTick: tick, charged: 0, cached, fromCache: false, synthesized: true };
    }
    const hit = !forceCold && this.cachesEnabled ? this.results.get(this.stageKey(q, spec, cap)) : undefined;
    if (hit) return { spec, cap, startedTick: tick, charged: 0, cached: hit, fromCache: true, synthesized: false };
    const views = q.views;
    let engine: Engine;
    if (spec.algorithm === "hpa") {
      engine = new HpaQuery(views.graph ?? new AbstractGraph(views.space), spec.from, spec.to, cap, spec.coarseOnly ? { coarseOnly: true } : {});
    } else {
      const alg: GridAlgorithm = spec.algorithm === "dijkstra" ? { kind: "dijkstra" } : spec.algorithm === "astar" ? { kind: "astar" } : { kind: "weighted-astar", weight: spec.weight ?? 1 };
      engine = new GridSearch(views.space, spec.from, spec.to, alg, cap, {
        trackReads: true,
        ...(spec.startDir === undefined ? {} : { startDir: spec.startDir }),
        ...(spec.heuristic === "euclidean" ? { heuristic: "euclidean" as const } : {}),
      });
    }
    return { spec, cap, startedTick: tick, charged: 0, engine, fromCache: false, synthesized: false };
  }

  /**
   * Spends this tick's budget on the strategy query: the search in progress first, then, with what is left, the searches
   * the runner asks for next (ADR-0037 addition, item 5). One rule for cold and warm searches: a search that ends without
   * a path is noticed by the call after its last expansion, so when it used the call's whole budget it ends in the next
   * tick; a found path ends in the call that finds it. Returns the expansions charged.
   */
  private stepStrategy(q: ActiveQuery, st: StrategyExec, tick: number): number {
    let left = q.request.config.onboardComputeExpansionsPerTick;
    let used = 0;
    for (;;) {
      let stage = st.stage;
      if (!stage) {
        const spec = st.runner.current();
        if (!spec) {
          this.finishStrategy(q, st, tick);
          return used;
        }
        stage = this.beginStage(q, st, spec, tick, false);
        st.stage = stage;
      }
      let consumed: number;
      let finished: boolean;
      const c = stage.cached;
      const e = stage.engine;
      if (c) {
        const before = stage.charged;
        stage.charged = Math.min(c.expansions, stage.charged + left);
        consumed = stage.charged - before;
        finished = stage.charged === c.expansions && endsInCall(c.extraIteration, consumed, left);
      } else if (e) {
        const before = e.expanded;
        e.step(left);
        consumed = e.expanded - before;
        stage.charged = e.expanded;
        finished = e.status !== "running"; // the engine decides when it notices its end; the cached path above follows it
      } else return used; // unreachable: a stage always has an engine or a cached result
      left -= consumed;
      used += consumed;
      q.charged = st.completedCharge + stage.charged;
      if (!finished) return used;
      this.finishStage(q, st, stage, tick);
      if (st.runner.current() === undefined) {
        this.finishStrategy(q, st, tick);
        return used;
      }
      if (left <= 0) return used; // the next search starts next tick
    }
  }

  /** Records a finished search: its read set, its cache entry, its place in the trace; hands the result to the runner. */
  private finishStage(q: ActiveQuery, st: StrategyExec, stage: StageState, tick: number): void {
    let result: StageResult;
    let readChunks: Uint8Array | undefined;
    const c = stage.cached;
    const e = stage.engine;
    if (c) {
      result = { status: c.status, cells: c.cells, cost: c.cost, expansions: c.expansions, ...(c.waypoints ? { waypoints: c.waypoints } : {}) };
      readChunks = c.readChunks;
    } else if (e && e.status !== "running") {
      const coarse = e instanceof HpaQuery && stage.spec.coarseOnly;
      const waypoints = coarse ? e.coarseCells() : undefined;
      result = { status: e.status, cells: coarse ? [] : e.path(), cost: e.cost, expansions: e.expanded, ...(waypoints ? { waypoints } : {}) };
      readChunks = e instanceof GridSearch ? e.readChunks?.slice() : undefined;
      if (this.cachesEnabled) {
        // Keyed by the view as it is now: a continued search's result equals a cold run on this view (ADR-0024).
        this.results.set(this.stageKey(q, stage.spec, stage.cap), { status: result.status, cells: result.cells, cost: result.cost, expansions: result.expansions, readChunks, extraIteration: needsExtraIteration(e), ...(waypoints ? { waypoints } : {}) });
        while (this.results.size > (this.opts.resultCacheSize ?? 256)) {
          const oldest = this.results.keys().next().value;
          if (oldest === undefined) break;
          this.results.delete(oldest);
        }
      }
    } else throw new Error("finishStage on a search that has not finished");
    if (readChunks) {
      if (!st.readUnion) st.readUnion = readChunks.slice();
      else for (let k = 0; k < readChunks.length; k++) if (readChunks[k] === 1) st.readUnion[k] = 1;
    }
    st.completed.push({ expansions: result.expansions, startedTick: stage.startedTick, endedTick: tick });
    st.completedCharge += result.expansions;
    q.charged = st.completedCharge;
    if (!stage.synthesized) {
      st.executed++;
      if (!stage.fromCache) st.allCached = false;
    }
    st.stage = undefined;
    const geometry = result.status === "found" ? this.stageGeometry(q.views.space, stage.spec, result) : undefined;
    st.runner.complete({
      result,
      remainingAfter: q.request.config.totalBudget - q.spent - st.completedCharge,
      startedTick: stage.startedTick,
      endedTick: tick,
      ...(geometry ? { geometry } : {}),
    });
    if (st.lazy) {
      // Each leg is ready in the tick its search completed, whether the search ran cold or came from the cache.
      for (const l of st.runner.drainLegs()) {
        st.lazy.pending.push({ index: l.index, count: l.count, last: l.last, waypoints: smoothPath(q.views.space, l.cells), tick });
        st.lazy.produced++;
      }
    }
  }

  private finishStrategy(q: ActiveQuery, st: StrategyExec, tick: number): void {
    const out = st.runner.outcome();
    if (!out) throw new Error("finishStrategy before the strategy ended");
    this.complete(q, { status: out.status, cells: out.cells, cost: out.cost, expansions: st.completedCharge, readChunks: undefined, extraIteration: false }, tick, st.executed > 0 && st.allCached);
  }

  /**
   * ADR-0024 additions for a strategy (ADR-0037 addition, item 7): continue if no chunk read by a completed or the current
   * search changed (and, once an hpa search has run, the abstract graph did not); otherwise restart from the root.
   */
  private changeForStrategy(q: ActiveQuery, st: StrategyExec): { reason: PlanRestart["reason"]; chunks: number[] } | undefined {
    const carry = q.carry; // a restored query's unexamined change, applied once
    q.carry = undefined;
    let graphChanged = false;
    if (st.usedHpa) {
      const gv = q.views.graph?.version ?? 0;
      if (gv !== st.seenGraph) {
        st.seenGraph = gv;
        graphChanged = true;
      }
    }
    const space = q.views.space;
    const moved = space.contentVersion !== st.seenSpace;
    if (!moved && (carry?.chunks.length ?? 0) === 0) return graphChanged ? { reason: "graph_changed", chunks: [] } : undefined;
    const changed = unionAscending(carry?.chunks ?? [], moved ? space.changedSince(st.seenSpace) : []);
    st.seenSpace = space.contentVersion;
    if (graphChanged) return { reason: "graph_changed", chunks: [] };
    const stage = st.stage;
    const current = stage ? (stage.cached ? stage.cached.readChunks : stage.engine instanceof GridSearch ? stage.engine.readChunks : undefined) : undefined;
    const read = st.readUnion !== undefined || current !== undefined || carry?.read !== undefined;
    const overlap = read ? changed.filter((k) => st.readUnion?.[k] === 1 || current?.[k] === 1 || carry?.read?.has(k) === true) : [];
    if (overlap.length > 0) return { reason: "read_set_overlap", chunks: overlap };
    if (read) q.continuations++;
    return undefined;
  }
}
