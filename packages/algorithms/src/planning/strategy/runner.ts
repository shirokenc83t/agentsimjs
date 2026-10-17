import { compileExpr, evaluateCondition, type CompiledExpr } from "@agentsim/core";
import { FEATURES, type Feature } from "../../cost-profile.ts";
import { DIR_DX, DIR_DY } from "../../grid/search-space.ts";
import { PLANNING_CONDITION_CONTEXT } from "../planning-condition.ts";
import { STRATEGY_LIMITS, type StrategyAlgorithm, type StrategyHeuristic, type StrategyNode } from "./schema.ts";

/**
 * The stage runner of ADR-0037 (§5 and the additions of 2026-10-13): a pure state machine that walks a strategy tree and says
 * which search to run next, given the results of the searches before it. It owns no maps, no engines and no clock: the
 * `PlanningService` (or, later, a planning worker, ADR-0034) runs each requested search, charges its expansions, and tells
 * the runner. Everything the runner decides is a function of the tree, the attempt's context numbers and those results,
 * so a restart or a snapshot restore replays it exactly.
 */

/** The numbers of the `planning-condition` context at the start of one attempt (names as in the context; enums by index). */
export type ConditionValues = Readonly<Record<string, number>>;

export function buildConditionValues(i: {
  readonly distM: number;
  readonly vehicle: "uav" | "ugv";
  readonly altitudeM: number;
  readonly profileWeights: Readonly<Record<Feature, number>>;
  readonly totalBudget: number;
  readonly replanCount: number;
  readonly knownFrac: number;
}): ConditionValues {
  const out: Record<string, number> = {
    "dist.m": i.distM,
    vehicle: i.vehicle === "uav" ? 0 : 1, // the index in the context's enum (uav, ugv)
    altitude: i.altitudeM,
    "budget.total": i.totalBudget,
    "replan.count": i.replanCount,
    "known.frac": i.knownFrac,
  };
  for (const f of FEATURES) out[`profile.${f}`] = i.profileWeights[f] !== 0 ? 1 : 0;
  return out;
}

export type StageRole = "plan" | "coarse" | "leg" | "pass";

/** One search the runner asks for. */
export interface StageSpec {
  /** Place of the node in the tree (`/root/stages/1`, `/root/local[2]`, `/root/weights/0`). */
  readonly path: string;
  readonly role: StageRole;
  readonly algorithm: StrategyAlgorithm;
  readonly weight?: number;
  readonly heuristic: StrategyHeuristic;
  /** The node's own cap on expansions; the effective cap also takes what is left of the query's total (the caller's). */
  readonly stageBudget?: number;
  readonly from: number;
  readonly to: number;
  readonly startDir?: number;
  /** An `hpa` search that ends after its abstract phase and reports waypoints (the coarse node of a `refine`). */
  readonly coarseOnly: boolean;
}

export interface StageResult {
  readonly status: "found" | "not_found" | "budget_exceeded";
  /** Path cells, start first (empty unless found; empty for a coarse-only search). */
  readonly cells: readonly number[];
  readonly cost: number;
  readonly expansions: number;
  /** A coarse-only `hpa` search: the cells of its abstract path. */
  readonly waypoints?: readonly number[];
}

export interface StageFeedback {
  readonly result: StageResult;
  /** The search's path in metres (smoothed, rounded, thinned), for the trace; only for a found search (ADR-0037 seventh addition). */
  readonly geometry?: readonly (readonly [number, number])[];
  /** What remains of the query's `totalBudget` after this search. */
  readonly remainingAfter: number;
  readonly startedTick: number;
  readonly endedTick: number;
}

export interface RunnerOutcome {
  readonly status: "found" | "not_found" | "budget_exceeded";
  readonly cells: number[];
  readonly cost: number;
}

/**
 * A leg of a lazy `refine` that became executable (ADR-0037 fourth addition): published when its search completes, so the
 * action can start driving before the later legs are planned. `cells` are that leg's own cells (its first cell is the
 * previous leg's last); `count` is the number of legs, known as soon as the coarse path is, after thinning.
 */
export interface LegReady {
  readonly index: number;
  readonly count: number;
  readonly cells: number[];
  readonly cost: number;
  readonly last: boolean;
}

export interface SelectTrace {
  readonly path: string;
  readonly branch: number | "else";
  readonly values: Readonly<Record<string, number>>;
}
export interface SearchTrace {
  readonly path: string;
  readonly role: StageRole;
  readonly algorithm: StrategyAlgorithm;
  readonly weight?: number;
  readonly heuristic: StrategyHeuristic;
  readonly stageBudget?: number;
  readonly expansions: number;
  readonly result: StageResult["status"];
  readonly startedTick: number;
  readonly endedTick: number;
  /** The path this search found, in metres (ADR-0037 seventh addition, item 14): what a stages overlay draws. */
  readonly waypoints?: readonly (readonly [number, number])[];
}
export interface StrategyTrace {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly selects: readonly SelectTrace[];
  /** More than 64 legs were thinned to `kept` (ADR-0037 addition, §6). */
  readonly thinned?: { readonly legs: number; readonly kept: number };
  readonly searches: readonly SearchTrace[];
}

/** A strategy as the planner receives it: what it does (id, version, tree) and its content hash. */
export interface StrategyPlan {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly root: StrategyNode;
}

interface NodeResult {
  readonly status: StageResult["status"];
  readonly cells: number[];
  readonly cost: number;
  readonly waypoints?: number[];
}
const FAILED = (status: "not_found" | "budget_exceeded"): NodeResult => ({ status, cells: [], cost: Number.POSITIVE_INFINITY });

/** Index of the move from cell `a` to the adjacent cell `b` in the 8-direction table, or undefined if they are not neighbours. */
function headingOf(cells: readonly number[], sizeX: number): number | undefined {
  const b = cells.at(-1);
  const a = cells.at(-2);
  if (a === undefined || b === undefined) return undefined;
  const di = (b % sizeX) - (a % sizeX);
  const dj = Math.floor(b / sizeX) - Math.floor(a / sizeX);
  for (let d = 0; d < 8; d++) if (DIR_DX[d] === di && DIR_DY[d] === dj) return d;
  return undefined;
}

type Gen = Generator<StageSpec, NodeResult, StageFeedback>;

export class StrategyRunner {
  private readonly gen: Gen;
  private pending: IteratorResult<StageSpec, NodeResult> | undefined;
  private readonly selects: SelectTrace[] = [];
  private readonly searches: SearchTrace[] = [];
  private thinned: { legs: number; kept: number } | undefined;
  private readonly legs: LegReady[] = [];
  private readonly compiled = new Map<string, CompiledExpr>();
  private readonly strategy: StrategyPlan;
  private readonly context: ConditionValues;
  private readonly sizeX: number;
  private readonly waypointsOf: (cells: readonly number[]) => number[];

  constructor(opts: {
    readonly strategy: StrategyPlan;
    readonly context: ConditionValues;
    readonly from: number;
    readonly to: number;
    readonly startDir?: number;
    /** Grid width, to read headings off cell indices. */
    readonly sizeX: number;
    readonly deps: {
      /** The waypoints (cells) of a path: its smoothed path (ADR-0037 addition, §6); the caller's, since it needs the map. */
      readonly waypointsOf: (cells: readonly number[]) => number[];
    };
  }) {
    this.strategy = opts.strategy;
    this.context = opts.context;
    this.sizeX = opts.sizeX;
    this.waypointsOf = opts.deps.waypointsOf;
    this.gen = this.run(opts.strategy.root, "/root", opts.from, opts.to, opts.startDir, "plan");
  }

  /** The search to run now, or `undefined` once the strategy has finished. Asking again returns the same request. */
  current(): StageSpec | undefined {
    this.pending ??= this.gen.next();
    return this.pending.done ? undefined : this.pending.value;
  }

  /** Reports the result of the search `current()` returned; the next call to `current()` is what comes after it. */
  complete(fb: StageFeedback): void {
    const p = this.pending;
    if (p === undefined || p.done) throw new Error("complete() without a pending search");
    this.pending = this.gen.next(fb);
  }

  /** The legs of a lazy `refine` that became ready since the last call, in order (empty for everything else). */
  drainLegs(): LegReady[] {
    return this.legs.splice(0);
  }

  /** The strategy's result, once it has finished. */
  outcome(): RunnerOutcome | undefined {
    const p = this.pending;
    if (p === undefined || !p.done) return undefined;
    return { status: p.value.status, cells: p.value.cells, cost: p.value.cost };
  }

  trace(): StrategyTrace {
    return {
      id: this.strategy.id,
      version: this.strategy.version,
      hash: this.strategy.hash,
      selects: this.selects,
      ...(this.thinned ? { thinned: this.thinned } : {}),
      searches: this.searches,
    };
  }

  private evaluate(when: string): { readonly holds: boolean; readonly values: Record<string, number> } {
    let c = this.compiled.get(when);
    if (!c) {
      const r = compileExpr(when, PLANNING_CONDITION_CONTEXT, "boolean");
      if (!r.ok) throw new Error(`condition no longer compiles: ${r.error.message}`); // validated before the strategy reaches a runner
      c = r.value;
      this.compiled.set(when, c);
    }
    const values: Record<string, number> = {};
    const slots = c.variables.map((v) => {
      const x = this.context[v] ?? Number.NaN;
      values[v] = x;
      return x;
    });
    return { holds: evaluateCondition(c, slots), values };
  }

  private record(spec: StageSpec, fb: StageFeedback): void {
    this.searches.push({
      path: spec.path,
      role: spec.role,
      algorithm: spec.algorithm,
      ...(spec.weight === undefined ? {} : { weight: spec.weight }),
      heuristic: spec.heuristic,
      ...(spec.stageBudget === undefined ? {} : { stageBudget: spec.stageBudget }),
      expansions: fb.result.expansions,
      result: fb.result.status,
      startedTick: fb.startedTick,
      endedTick: fb.endedTick,
      ...(fb.geometry ? { waypoints: fb.geometry.map(([x, y]): [number, number] => [x, y]) } : {}),
    });
  }

  /** Walks one node; yields each search it needs and returns its result. */
  private *run(node: StrategyNode, path: string, from: number, to: number, startDir: number | undefined, role: Exclude<StageRole, "pass">): Gen {
    switch (node.kind) {
      case "algorithm": {
        const spec: StageSpec = {
          path,
          role,
          algorithm: node.algorithm,
          ...(node.weight === undefined ? {} : { weight: node.weight }),
          heuristic: node.heuristic ?? "octile",
          ...(node.stageBudget === undefined ? {} : { stageBudget: node.stageBudget }),
          from,
          to,
          ...(startDir === undefined ? {} : { startDir }),
          coarseOnly: role === "coarse" && node.algorithm === "hpa",
        };
        const fb: StageFeedback = yield spec;
        this.record(spec, fb);
        const r = fb.result;
        if (r.status !== "found") return FAILED(r.status);
        const cells = [...r.cells];
        const out: NodeResult = { status: "found", cells, cost: r.cost };
        if (role !== "coarse") return out;
        return { ...out, waypoints: r.waypoints ? [...r.waypoints] : this.waypointsOf(cells) };
      }
      case "anytime": {
        let best: NodeResult | undefined;
        let failure: NodeResult = FAILED("not_found");
        let spent = 0;
        for (const [k, weight] of node.weights.entries()) {
          const left = node.stageBudget === undefined ? undefined : node.stageBudget - spent;
          if (left !== undefined && left <= 0) break; // the node's own cap is spent: keep what it has
          const spec: StageSpec = {
            path: `${path}/weights/${k}`,
            role: "pass",
            algorithm: "weighted-astar",
            weight,
            heuristic: node.heuristic ?? "octile",
            ...(left === undefined ? {} : { stageBudget: left }),
            from,
            to,
            ...(startDir === undefined ? {} : { startDir }),
            coarseOnly: false,
          };
          const fb: StageFeedback = yield spec;
          this.record(spec, fb);
          spent += fb.result.expansions;
          if (fb.result.status !== "found") {
            failure = FAILED(fb.result.status);
            break; // a pass that cannot finish ends the node; the best completed path stands
          }
          if (best === undefined || fb.result.cost < best.cost) best = { status: "found", cells: [...fb.result.cells], cost: fb.result.cost };
        }
        if (best === undefined) return failure;
        return role === "coarse" ? { ...best, waypoints: this.waypointsOf(best.cells) } : best;
      }
      case "select": {
        const names = new Set<string>();
        const seen: Record<string, number> = {};
        for (const [k, b] of node.branches.entries()) {
          const e = this.evaluate(b.when);
          for (const [n, v] of Object.entries(e.values)) {
            names.add(n);
            seen[n] = v;
          }
          if (e.holds) {
            this.selects.push({ path, branch: k, values: sorted(seen, names) });
            return yield* this.run(b.then, `${path}/branches/${k}/then`, from, to, startDir, role);
          }
        }
        this.selects.push({ path, branch: "else", values: sorted(seen, names) });
        return yield* this.run(node.else, `${path}/else`, from, to, startDir, role);
      }
      case "fallback": {
        let last: NodeResult = FAILED("not_found");
        for (const [k, stage] of node.stages.entries()) {
          last = yield* this.run(stage, `${path}/stages/${k}`, from, to, startDir, role);
          if (last.status === "found") return last;
        }
        return last;
      }
      case "refine": {
        // Only a refine whose legs are the path the action drives publishes them (the validator keeps a lazy refine at the
        // root or below select branches); anywhere else it runs as eager.
        const publish = node.mode === "lazy" && role === "plan";
        const coarse = yield* this.run(node.coarse, `${path}/coarse`, from, to, startDir, "coarse");
        if (coarse.status !== "found") return coarse;
        let points = (coarse.waypoints ?? [from, to]).filter((c, i, all) => i === 0 || c !== all[i - 1]);
        if (points.length < 2) {
          if (publish) this.legs.push({ index: 0, count: 1, cells: [from], cost: 0, last: true });
          return { status: "found", cells: [from], cost: 0 };
        }
        const legs = points.length - 1;
        if (legs > STRATEGY_LIMITS.maxLegs) {
          // Deterministic thinning: the smallest stride that fits, the goal always kept.
          const stride = Math.ceil(legs / STRATEGY_LIMITS.maxLegs);
          const kept: number[] = [];
          for (let i = 0; i < legs; i += stride) kept.push(points[i] ?? from);
          kept.push(points[legs] ?? to);
          points = kept;
          this.thinned = { legs, kept: kept.length - 1 };
        }
        const cells: number[] = [];
        let cost = 0;
        let dir = startDir;
        for (let k = 0; k + 1 < points.length; k++) {
          const a = points[k] ?? from;
          const b = points[k + 1] ?? to;
          const leg = yield* this.run(node.local, `${path}/local[${k}]`, a, b, dir, "leg");
          if (leg.status !== "found") return FAILED(leg.status);
          if (publish) this.legs.push({ index: k, count: points.length - 1, cells: [...leg.cells], cost: leg.cost, last: k + 2 === points.length });
          for (const c of leg.cells) if (cells.at(-1) !== c) cells.push(c); // the joint cell of two legs once
          cost += leg.cost;
          dir = headingOf(leg.cells, this.sizeX) ?? dir;
        }
        const out: NodeResult = { status: "found", cells, cost };
        return role === "coarse" ? { ...out, waypoints: this.waypointsOf(cells) } : out;
      }
    }
  }
}

function sorted(values: Readonly<Record<string, number>>, names: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of [...names].sort()) out[n] = values[n] ?? Number.NaN;
  return out;
}
