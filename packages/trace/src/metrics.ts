import { isValidSource, parseSource, sourceOf, type OwnerKind, type SourceComponent } from "./source.ts";

// The metric registry (ADR-0035 section 4 and its addition of 2026-10-17, item 4): a metric is a named time series defined here, in trusted code, by name. Its source
// path (ADR-0031) is assigned by this code from the component the series is about, never by a mind. Metrics are observer data: they are read from the run between ticks,
// after the tick's state hash, change nothing and are not reachable from a decision request.

export const METRIC_AGGREGATIONS = ["last", "mean", "max", "count"] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export interface MetricDef {
  /** The series' name, unique in the registry. */
  readonly name: string;
  /** Whose series it is: the world, or an agent (the source is then `<agent>/<component>`). */
  readonly owner: "world" | "agent";
  /** The component the series is about (ADR-0031's closed vocabulary); it must be one of the owner kind's components. */
  readonly component: SourceComponent;
  readonly unit: string;
  /** How the observations of one sampling interval fold into the one sample that is stored. */
  readonly aggregation: MetricAggregation;
  /** Samples per second of sim time: `"profile"` follows the `metrics` channel's rate, `"observer"` is one sample per report of the observer that compares beliefs with the ground truth. */
  readonly rateHz: "profile" | "observer";
  /** Computed from ground truth: labelled as observer data and never visible to minds. */
  readonly observer: boolean;
  readonly description: string;
}

/**
 * The registry. Mind metrics (latency, tokens, cost, cache hits) arrive with F4, protocol ones (open instances, deadline misses) with the protocol layer, swarm ones with
 * F9 (ADR-0035 section 4); none of them is registered before the data exists.
 */
export const METRIC_REGISTRY: readonly MetricDef[] = [
  { name: "sim.tickMs", owner: "world", component: "sim", unit: "ms", aggregation: "mean", rateHz: "profile", observer: false, description: "Wall time of a tick: the world's step, trail and sensing included, the recording's own work not." },
  { name: "sim.tickBudgetUse", owner: "world", component: "sim", unit: "ratio", aggregation: "max", rateHz: "profile", observer: false, description: "Tick wall time over the tick's real-time budget (the step in ms): above 1 a realtime run falls behind." },
  { name: "sim.senseMs", owner: "world", component: "sim", unit: "ms", aggregation: "mean", rateHz: "profile", observer: false, description: "Wall time of the sensing phase." },
  { name: "sim.otherPhasesMs", owner: "world", component: "sim", unit: "ms", aggregation: "mean", rateHz: "profile", observer: false, description: "Wall time of every other phase together: the tick minus the sensing phase." },
  { name: "sim.planExpansions", owner: "world", component: "sim", unit: "count", aggregation: "mean", rateHz: "profile", observer: false, description: "Search expansions the planner spent in a tick." },
  { name: "sim.planBudgetUse", owner: "world", component: "sim", unit: "ratio", aggregation: "max", rateHz: "profile", observer: false, description: "Planner expansions over the planner's budget of the tick." },
  { name: "storage.backlogRecords", owner: "world", component: "storage", unit: "records", aggregation: "max", rateHz: "profile", observer: false, description: "Records handed to the storage worker and not yet reported saved." },
  { name: "storage.backlogBytes", owner: "world", component: "storage", unit: "bytes", aggregation: "max", rateHz: "profile", observer: false, description: "The same backlog, in (estimated) bytes." },
  { name: "agent.soc", owner: "agent", component: "body", unit: "fraction", aggregation: "last", rateHz: "profile", observer: false, description: "Battery state of charge, 0 to 1." },
  { name: "agent.speedMps", owner: "agent", component: "body", unit: "m/s", aggregation: "mean", rateHz: "profile", observer: false, description: "Speed over the ground." },
  { name: "belief.unknownPct", owner: "agent", component: "beliefs", unit: "percent", aggregation: "last", rateHz: "observer", observer: true, description: "Reachable cells the agent knows nothing about, from the observer that compares beliefs with the ground truth." },
  { name: "belief.falseFreePct", owner: "agent", component: "beliefs", unit: "percent", aggregation: "last", rateHz: "observer", observer: true, description: "Cells believed free that are truly blocked, as a share of the cells believed free." },
  { name: "belief.entityMeanErrM", owner: "agent", component: "beliefs", unit: "m", aggregation: "last", rateHz: "observer", observer: true, description: "Mean distance between the believed and the true positions of the entities the agent knows." },
];

const BY_NAME = new Map(METRIC_REGISTRY.map((d) => [d.name, d]));

export const METRIC_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

export function metricDef(name: string): MetricDef | undefined {
  return BY_NAME.get(name);
}

const OWNER_KIND: Readonly<Record<MetricDef["owner"], OwnerKind>> = { world: "world", agent: "agent" };

/** The source of a series: `world/sim` for the world's, `<agent>/<component>` for an agent's. Only trusted code calls this. */
export function metricSource(def: MetricDef, agentId?: string): string {
  if (def.owner === "world") return sourceOf("world", def.component);
  if (agentId === undefined) throw new Error(`metric ${def.name} needs an agent`);
  return sourceOf(agentId, def.component);
}

/** One stored point of a series. */
export interface MetricSample {
  readonly source: string;
  readonly name: string;
  /** The tick the sample was taken after: unique per series, and the order of the series. */
  readonly tick: number;
  readonly simTime: number;
  readonly value: number;
}

/** True when the sample's name is registered and its source is the one trusted code would give that series. */
export function isRegisteredSample(s: Pick<MetricSample, "source" | "name">): boolean {
  const def = BY_NAME.get(s.name);
  if (!def || !isValidSource(s.source)) return false;
  const p = parseSource(s.source);
  return p !== undefined && p.component === def.component && p.ownerKind === OWNER_KIND[def.owner];
}

// ---- sampling -------------------------------------------------------------------------------------------------------------

interface Accumulator {
  sum: number;
  max: number;
  last: number;
  n: number;
}

/**
 * Folds the observations of each series into samples at the sampling rate: `observe` is called each tick (or each report) with a value, `take` at a sampling point gives
 * the aggregates of the interval and starts the next. Pure bookkeeping: it reads nothing of the run.
 */
export class MetricSampler {
  private readonly acc = new Map<string, { def: MetricDef; source: string; a: Accumulator }>();
  private nextDueS = 0;

  constructor(private readonly rateHz: number) {}

  observe(def: MetricDef, source: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = `${source}\u0000${def.name}`;
    let e = this.acc.get(key);
    if (!e) {
      e = { def, source, a: { sum: 0, max: -Infinity, last: 0, n: 0 } };
      this.acc.set(key, e);
    }
    e.a.sum += value;
    e.a.max = Math.max(e.a.max, value);
    e.a.last = value;
    e.a.n++;
  }

  /** True when a sample is due at this sim time (the first call always is). */
  due(simTimeS: number): boolean {
    return simTimeS + 1e-9 >= this.nextDueS;
  }

  /** The samples of the interval that ended at this tick, in a stable order (source, name); the next interval starts empty. */
  take(tick: number, simTimeS: number): MetricSample[] {
    const period = 1 / this.rateHz;
    this.nextDueS = (Math.floor((simTimeS + 1e-9) / period) + 1) * period;
    const out: MetricSample[] = [];
    for (const { def, source, a } of this.acc.values()) {
      if (def.rateHz !== "profile" || a.n === 0) continue;
      out.push({ source, name: def.name, tick, simTime: simTimeS, value: valueOf(def.aggregation, a) });
      a.sum = 0;
      a.max = -Infinity;
      a.n = 0;
    }
    return out.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }
}

function valueOf(agg: MetricAggregation, a: Accumulator): number {
  switch (agg) {
    case "last":
      return a.last;
    case "mean":
      return a.sum / a.n;
    case "max":
      return a.max;
    case "count":
      return a.n;
  }
}
