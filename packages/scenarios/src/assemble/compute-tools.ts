import { GridSearch, smoothPath, type GridAlgorithm, type SearchSpace } from "@agentsim/algorithms";
import { round2, type ComputeOutcome, type ComputePort, type DecisionRequest, type SimAgent } from "@agentsim/core";
import { COMPUTE_LIMITS, getCapability, validateParams } from "@agentsim/tools-schema";
import { toPlanningConfig } from "../run-config/resolve.ts";
import type { PlanningServiceAdapter } from "./adapters.ts";

// The compute tools a mind may ask for while it decides (F4 M2, ADR-0014 addition of 2026-10-29): planPath, estimateCost, kShortestPaths and querySpace. Each answers from the agent's own planning view (its
// belief grid; the ground truth only for an `ideal` agent, which is its own map too) and from the space summary its request carried, with the node budget of its planner. Nothing here changes the world or the
// agent, and nothing is random: the same view and parameters give the same answer, which is what lets a replay recompute and compare.

type Algorithm = GridAlgorithm;
type Status = "found" | "not_found" | "budget_exceeded";
interface Point {
  readonly xM: number;
  readonly yM: number;
}
interface Leg {
  readonly status: Status;
  readonly cells: readonly number[];
  readonly expansions: number;
  readonly waypoints: readonly (readonly [number, number])[];
  readonly lengthM: number;
}

const fail = (code: string, message: string): ComputeOutcome => ({ ok: false, code, message });
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Cells within this many cells (Chebyshev) of a route's two ends stay open when the next alternative is searched, or no alternative could start or end. */
const ENDS_OPEN_CELLS = 3;

export class ComputeToolsService implements ComputePort {
  private readonly byId: ReadonlyMap<string, SimAgent>;

  constructor(
    agents: readonly SimAgent[],
    private readonly planner: PlanningServiceAdapter,
  ) {
    this.byId = new Map(agents.map((a) => [a.id, a]));
  }

  call(agentId: string, tool: string, params: unknown, req: DecisionRequest): ComputeOutcome {
    const cap = getCapability(tool);
    if (cap === undefined || cap.kind !== "compute") return fail("unknown_tool", `"${tool.slice(0, 64)}" is not a compute tool`);
    const valid = validateParams(tool, params);
    if (!valid.ok) {
      // What is wrong and where, and, for a point, what a point looks like (a model that is only told "must be object" asks again with the same fault).
      const where = valid.error.issues.slice(0, 3).map((i) => `${i.path === "" ? "parameters" : i.path}: ${i.message}`);
      const point = valid.error.issues.some((i) => /(^|\/)(route|to|from)(\/|$)/.test(i.path));
      return fail("invalid_params", `${where.join("; ")}${point ? ' (a point is an object {"xM": 20, "yM": 40}: two numbers in metres, never a string or a name; "home" is the base)' : ""}`);
    }
    const agent = this.byId.get(agentId);
    if (agent === undefined) return fail("unknown_agent", `no agent ${agentId}`);
    const p = valid.value as Record<string, unknown>;
    switch (tool) {
      case "planPath":
        return this.planPath(agent, p);
      case "estimateCost":
        return this.estimateCost(agent, p);
      case "kShortestPaths":
        return this.kShortestPaths(agent, p);
      case "querySpace":
        return this.querySpace(p, req);
      default:
        return fail("unknown_tool", `no implementation for ${tool}`);
    }
  }

  // ---- the planner's side ------------------------------------------------------------------------------------------------------------------------

  /** The agent's planning view, algorithm and node budget; undefined when it has no configuration (not an agent of this run). */
  private planning(agent: SimAgent): { readonly space: SearchSpace; readonly algorithm: Algorithm; readonly budget: number } | undefined {
    const cfg = this.planner.configOf(agent.id);
    const space = this.planner.liveView(agent.id);
    if (cfg === undefined || space === undefined) return undefined;
    const pc = toPlanningConfig(cfg);
    // An HPA* agent searches the plain grid here: a compute call answers from the one view, with the budget of the agent's planner.
    const algorithm: Algorithm = pc.algorithm.kind === "hpa" ? { kind: "astar" } : pc.algorithm;
    return { space, algorithm, budget: pc.totalBudget };
  }

  private point(agent: SimAgent, p: unknown): Point | ComputeOutcome {
    if (p === undefined) return { xM: agent.state.x, yM: agent.state.y };
    if (p === "home") return agent.base === undefined ? fail("no_home", "you have no base") : { xM: agent.base.xM, yM: agent.base.yM };
    const q = p as Point;
    return { xM: q.xM, yM: q.yM };
  }

  /** One search between two points on a view; the cells of the route and the metre waypoints of its smoothed form. */
  private search(space: SearchSpace, from: Point, to: Point, algorithm: Algorithm, budget: number, blocked?: ReadonlySet<number>): Leg | ComputeOutcome {
    const g = space.grid;
    const si = g.cellI(from.xM);
    const sj = g.cellJ(from.yM);
    const ti = g.cellI(to.xM);
    const tj = g.cellJ(to.yM);
    if (!g.inBounds(si, sj) || !g.inBounds(ti, tj)) return fail("point_out_of_bounds", "a point lies outside your map");
    const none = (status: Status, expansions: number): Leg => ({ status, cells: [], expansions, waypoints: [], lengthM: 0 });
    if (!space.passable(si, sj) || !space.passable(ti, tj)) return none("not_found", 0);
    const start = sj * space.sizeX + si;
    const goal = tj * space.sizeX + ti;
    if (start === goal) return { status: "found", cells: [start], expansions: 0, waypoints: [[from.xM, from.yM]], lengthM: 0 };
    const gs = new GridSearch(space, start, goal, algorithm, budget, blocked === undefined ? {} : { blocked });
    gs.step(budget);
    const status: Status = gs.status === "found" ? "found" : gs.status === "not_found" ? "not_found" : "budget_exceeded";
    if (status !== "found") return none(status, gs.expanded);
    const cells = gs.path();
    const waypoints = smoothPath(space, cells);
    let length = 0;
    for (let k = 1; k < waypoints.length; k++) length += Math.hypot((waypoints[k]?.[0] ?? 0) - (waypoints[k - 1]?.[0] ?? 0), (waypoints[k]?.[1] ?? 0) - (waypoints[k - 1]?.[1] ?? 0));
    return { status, cells, expansions: gs.expanded, waypoints, lengthM: length };
  }

  /** The figures of a length for the agent: time at its speed, share of a full battery. */
  private figures(agent: SimAgent, space: SearchSpace, lengthM: number): { readonly lengthM: number; readonly etaS: number; readonly energyPct: number } {
    const t = space.traversal;
    const capacityWh = agent.body.battery.capacityWh;
    return { lengthM: round2(lengthM), etaS: round2(t.speedMps > 0 ? lengthM / t.speedMps : 0), energyPct: round1(capacityWh > 0 ? ((lengthM * t.energyWhPerM) / capacityWh) * 100 : 0) };
  }

  // ---- the tools ---------------------------------------------------------------------------------------------------------------------------------

  private planPath(agent: SimAgent, p: Record<string, unknown>): ComputeOutcome {
    const plan = this.planning(agent);
    if (plan === undefined) return fail("no_map", "you have no planning view");
    const to = this.point(agent, p["to"]);
    if ("ok" in to) return to;
    const from = this.point(agent, p["from"]);
    if ("ok" in from) return from;
    const leg = this.search(plan.space, from, to, plan.algorithm, plan.budget);
    if ("ok" in leg) return leg;
    return {
      ok: true,
      status: leg.status,
      expansions: leg.expansions,
      result: { status: leg.status, ...this.figures(agent, plan.space, leg.lengthM), expansions: leg.expansions, waypoints: simplify(leg.waypoints).map(([x, y]) => ({ xM: round2(x), yM: round2(y) })) },
    };
  }

  private estimateCost(agent: SimAgent, p: Record<string, unknown>): ComputeOutcome {
    const plan = this.planning(agent);
    if (plan === undefined) return fail("no_map", "you have no planning view");
    const route = p["route"] as readonly unknown[];
    let at = this.point(agent, p["from"]);
    if ("ok" in at) return at;
    const legs: { status: Status; lengthM: number; etaS: number; energyPct: number }[] = [];
    let total = 0;
    let expansions = 0;
    let status: Status = "found";
    for (const next of route) {
      const to = this.point(agent, next);
      if ("ok" in to) return to;
      const leg = this.search(plan.space, at, to, plan.algorithm, plan.budget);
      if ("ok" in leg) return leg;
      expansions += leg.expansions;
      total += leg.lengthM;
      legs.push({ status: leg.status, ...this.figures(agent, plan.space, leg.lengthM) });
      if (leg.status !== "found" && status === "found") status = leg.status;
      at = to;
    }
    return { ok: true, status, expansions, result: { status, ...this.figures(agent, plan.space, total), legs } };
  }

  private kShortestPaths(agent: SimAgent, p: Record<string, unknown>): ComputeOutcome {
    const plan = this.planning(agent);
    if (plan === undefined) return fail("no_map", "you have no planning view");
    const to = this.point(agent, p["to"]);
    if ("ok" in to) return to;
    const from = this.point(agent, p["from"]);
    if ("ok" in from) return from;
    const k = Math.min(p["k"] as number, COMPUTE_LIMITS.maxAlternatives);
    const first = this.search(plan.space, from, to, plan.algorithm, plan.budget);
    if ("ok" in first) return first;
    let expansions = first.expansions;
    const found: Leg[] = first.status === "found" ? [first] : [];
    if (first.status === "found" && k > 1) {
      // Alternatives are searched with the earlier routes' cells blocked (but for their ends) in the search itself: the live view is neither copied nor touched.
      const blocked = new Set<number>();
      const sx = plan.space.sizeX;
      const open = (c: number, ends: readonly number[]) => ends.some((e) => Math.max(Math.abs((c % sx) - (e % sx)), Math.abs(Math.floor(c / sx) - Math.floor(e / sx))) <= ENDS_OPEN_CELLS);
      for (let n = 1; n < k; n++) {
        const last = found[found.length - 1] as Leg;
        const ends = [last.cells[0] as number, last.cells[last.cells.length - 1] as number];
        for (const c of last.cells) if (!open(c, ends)) blocked.add(c);
        const alt = this.search(plan.space, from, to, plan.algorithm, plan.budget, blocked);
        if ("ok" in alt) return alt;
        expansions += alt.expansions;
        if (alt.status !== "found") break;
        found.push(alt);
      }
    }
    const base = new Set(found[0]?.cells ?? []);
    const paths = found.map((leg, n) => {
      const shared = n === 0 ? 0 : Math.round((100 * leg.cells.filter((c) => base.has(c)).length) / Math.max(1, leg.cells.length));
      return { ...this.figures(agent, plan.space, leg.lengthM), sharedPct: shared };
    });
    return { ok: true, status: first.status, expansions, result: { status: first.status, expansions, paths } };
  }

  private querySpace(p: Record<string, unknown>, req: DecisionRequest): ComputeOutcome {
    const id = p["region"] as string | undefined;
    if (id === undefined) return { ok: true, status: "found", expansions: 0, result: { summary: req.space } };
    const region = req.space.regions.find((r) => r.id === id);
    if (region === undefined) return fail("unknown_region", `no region ${id.slice(0, 64)} in your summary`);
    return { ok: true, status: "found", expansions: 0, result: { region, frontiers: req.space.frontiers.filter((f) => f.region === id) } };
  }
}

/** At most `COMPUTE_LIMITS.maxWaypoints` points of a route, the first and the last kept, the others evenly spaced along it (deterministic). */
function simplify(points: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const max = COMPUTE_LIMITS.maxWaypoints;
  if (points.length <= max) return [...points];
  const out: (readonly [number, number])[] = [];
  for (let k = 0; k < max; k++) out.push(points[Math.round((k * (points.length - 1)) / (max - 1))] as readonly [number, number]);
  return out;
}
