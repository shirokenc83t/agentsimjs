import { PlanningService, validatePlanningConfig, type LazyPlanLeg, type PlanOutcome, type PlanningConfig, type StrategyTrace } from "@agentsim/algorithms";
import type { SimAgent } from "@agentsim/core";
import type { BeliefGrid, GridSpace } from "@agentsim/spatial";
import { resolveStrategySpec, toPlanningConfig, type ResolvedRunConfig } from "../run-config/resolve.ts";
import type { PlanningEntry } from "../run-config/schema.ts";
import { traversalFor } from "../traversal.ts";
import type { AssembledRun } from "./assemble.ts";

/*
 * The researcher's "test on map" sandbox (ADR-0037 seventh addition, item 16): try a planning strategy from an agent's
 * current position on its belief map as it is now (a snapshot copy) or on the ground truth, without touching the run.
 *
 * Isolation by construction: a new `PlanningService` (caches off) over a copy of the map; nothing here calls the run's
 * planner, adapter, trace sink, clock or world. The result is a plain value. A query runs a bounded number of ticks per
 * `step`, so a host can interleave it with the run's own loop; the result depends on sim ticks and expansions only, never
 * on how the steps were sliced.
 */

export interface StrategyTestRequest {
  readonly agentId: string;
  /** A shipped strategy by reference or an inline document; absent: the agent's own planner. */
  readonly strategy?: NonNullable<PlanningEntry["strategy"]>;
  /** The target in metres. */
  readonly to: { readonly xM: number; readonly yM: number };
  /** `belief`: a snapshot copy of the agent's map (the default question: "what would this agent plan"); `truth`: the ground truth (researcher data). */
  readonly map: "belief" | "truth";
}

/** A refusal with its stable machine-readable code (never an exception); `path` points into the strategy when it is the cause. */
export interface StrategyTestError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** A leg of a lazy plan and the tick its search completed (the vehicle of a sandbox does not move: nothing interrupts it). */
export interface StrategyTestLeg {
  readonly index: number;
  readonly count: number;
  readonly last: boolean;
  readonly tick: number;
  readonly waypoints: readonly (readonly [number, number])[];
}

export interface StrategyTestResult {
  /** The map actually planned on: an `ideal` agent's own map is the ground truth, so a `belief` request on it reports `truth`. */
  readonly map: "belief" | "truth";
  readonly status: "found" | "not_found" | "budget_exceeded";
  /** `strategy:<id>@<version>` or the algorithm's name. */
  readonly planner: string;
  /** Sim ticks the query took, counted as the run's would be (completion tick of a query submitted at tick 1). */
  readonly ticks: number;
  readonly expansionsCharged: number;
  readonly waypoints: readonly (readonly [number, number])[];
  /** The path through the tree, the conditions with their values and every search with its geometry; absent for a plain algorithm. */
  readonly strategy: StrategyTrace | undefined;
  /** Lazy refine only: each leg with its ready tick. */
  readonly legs: readonly StrategyTestLeg[];
}

/** Points kept of a path in a result (a fixed stride, the last kept): the result is a message to the main thread. */
const MAX_POINTS = 512;
function thin(w: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  if (w.length <= MAX_POINTS) return w;
  const stride = Math.ceil(w.length / MAX_POINTS);
  const out = w.filter((_, i) => i % stride === 0);
  const last = w[w.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

const fail = (code: string, message: string, path?: string): { ok: false; error: StrategyTestError } => ({ ok: false, error: path === undefined ? { code, message } : { code, message, path } });

export class StrategyTestRun {
  private tick = 0;
  private done = false;
  private outcome: PlanOutcome | undefined;
  private readonly legs: LazyPlanLeg[] = [];
  /** Ticks after which a query that has not ended is a bug, not a long query (the budget bounds it: ADR-0037 item 12). */
  private readonly tickLimit: number;

  private constructor(
    private readonly service: PlanningService,
    private readonly agentId: string,
    private readonly queryId: string,
    private readonly map: "belief" | "truth",
    private readonly planner: string,
    config: PlanningConfig,
  ) {
    this.tickLimit = Math.ceil(config.totalBudget / Math.max(1, config.onboardComputeExpansionsPerTick)) + 1024;
  }

  /** @internal use `startStrategyTest` */
  static create(service: PlanningService, agentId: string, queryId: string, map: "belief" | "truth", planner: string, config: PlanningConfig): StrategyTestRun {
    return new StrategyTestRun(service, agentId, queryId, map, planner, config);
  }

  /** Runs at most `maxTicks` ticks of the query; returns true once it has ended (also on later calls). */
  step(maxTicks: number): boolean {
    for (let n = 0; n < maxTicks && !this.done && this.tick < this.tickLimit; n++) {
      this.tick++;
      this.service.tick(this.tick);
      const progress = this.service.takeLegs(this.agentId, this.queryId);
      if (progress) this.legs.push(...progress.legs);
      for (const o of this.service.takeCompleted()) {
        if (o.queryId === this.queryId) {
          this.outcome = o;
          this.done = true;
        }
      }
    }
    return this.done || this.tick >= this.tickLimit;
  }

  result(): { ok: true; value: StrategyTestResult } | { ok: false; error: StrategyTestError } {
    const o = this.outcome;
    if (!o) return fail("sandbox_tick_limit", `the query did not end within ${this.tickLimit} ticks`);
    return {
      ok: true,
      value: {
        map: this.map,
        status: o.status,
        planner: this.planner,
        ticks: o.completedTick,
        expansionsCharged: o.expansionsCharged,
        waypoints: thin(o.waypoints),
        strategy: o.strategy,
        legs: this.legs.map((l) => ({ index: l.index, count: l.count, last: l.last, tick: l.tick, waypoints: thin(l.waypoints) })),
      },
    };
  }
}

/**
 * Starts a sandbox query for `req.agentId` from where it is now. Everything that can be wrong with the request (unknown
 * agent, a strategy that does not validate, a target the planner refuses) is a result with its code, never a throw.
 */
export function startStrategyTest(
  run: Pick<AssembledRun, "agents" | "beliefGrids" | "truthGrid">,
  resolved: ResolvedRunConfig,
  req: StrategyTestRequest,
): { ok: true; value: StrategyTestRun } | { ok: false; error: StrategyTestError } {
  const cfg = resolved.agents.find((a) => a.agentId === req.agentId);
  const agent: SimAgent | undefined = run.agents.find((a) => a.id === req.agentId);
  if (!cfg || !agent) return fail("unknown_agent", `no agent ${req.agentId} in this run`);

  let planning: PlanningConfig = toPlanningConfig(cfg);
  if (req.strategy !== undefined) {
    const s = resolveStrategySpec(req.strategy);
    if (!s.ok) return fail(s.error.code, s.error.message, s.error.path);
    planning = { ...planning, strategy: s.value };
  }
  const valid = validatePlanningConfig(planning);
  if (!valid.ok) return fail(valid.error.code, valid.error.message, "/strategy");

  // An `ideal` agent has no map of its own: it plans on the ground truth, and so does its sandbox (reported as such).
  const own: BeliefGrid | undefined = req.map === "belief" ? run.beliefGrids.get(req.agentId) : undefined;
  const map: "belief" | "truth" = own ? "belief" : "truth";
  const copy = own?.snapshotCopy();
  const grid: GridSpace = run.truthGrid;
  const service = new PlanningService(grid, { cachesEnabled: false, mapFor: (key) => (key === req.agentId ? copy : undefined) });
  const submitted = service.submit(
    {
      agentId: req.agentId,
      traversal: traversalFor(cfg),
      config: planning,
      from: { x: agent.state.x, y: agent.state.y },
      to: { x: req.to.xM, y: req.to.yM },
      ...(copy ? { mapKey: req.agentId } : {}),
    },
    1,
  );
  if (!submitted.ok) return fail(submitted.error.code, submitted.error.message);
  const planner = planning.strategy ? `strategy:${planning.strategy.id}@${planning.strategy.version}` : planning.algorithm.kind;
  return { ok: true, value: StrategyTestRun.create(service, req.agentId, submitted.value, map, planner, planning) };
}
