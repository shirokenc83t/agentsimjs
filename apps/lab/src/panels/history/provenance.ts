import type { TraceRecord } from "@agentsim/trace";
import type { AnalysisSeries, SeriesPoint } from "../analysis/analysis-model.ts";
import { seqOfId } from "../debug/trace-tree.ts";
import { recordWords } from "./audit-model.ts";

// Where a value on a chart comes from (T-103, U-017): a point of a planner series is one `compute` record, with the chain of what it came from (its causes, then its parent and
// what caused that); a point of a recorded metric is a sample with its tick and its rate, and the line between samples is drawn, not measured. Pure but for the lookup it is given.

export interface ChainStep {
  /** `value`, `cause` (←) or `parent`. */
  readonly relation: "value" | "cause" | "parent";
  readonly label: string;
  readonly seq: number | undefined;
  readonly tick: number | undefined;
}

export interface Provenance {
  readonly kind: "compute" | "metric";
  readonly agentId: string;
  readonly series: string;
  readonly t: number;
  readonly value: number;
  readonly lead: string;
  readonly chain: readonly ChainStep[];
  /** The record the value is, for a planner series (the audit row, the trace graph and the Log jump to it). */
  readonly seq: number | undefined;
}

export type Lookup = (seq: number) => Promise<TraceRecord | undefined>;

const unitWords = (s: AnalysisSeries): string => (s.name === "planner expansions" ? "expansions" : s.name === "planning latency" ? "ticks of latency" : s.unit);
const fmtValue = (v: number, unit: string): string => (unit === "fraction" ? v.toFixed(2) : Number.isInteger(v) ? String(v) : v.toFixed(2));

/** The nearest point of `series` to time `t` (ties go to the earlier), for a click on a chart. */
export function nearestPoint(points: readonly SeriesPoint[], t: number): SeriesPoint | undefined {
  let best: SeriesPoint | undefined;
  for (const p of points) if (best === undefined || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
}

/** The metric's provenance: the sample, its tick and rate (from the gap to its neighbours), and what the line between samples is. */
export function metricProvenance(series: AnalysisSeries, point: SeriesPoint, dtS: number): Provenance {
  const at = series.points.findIndex((p) => p.t === point.t && p.v === point.v);
  const next = series.points[at + 1];
  const prev = series.points[at - 1];
  const gap = next !== undefined ? next.t - point.t : prev !== undefined ? point.t - prev.t : undefined;
  const metric = series.name === "battery" ? "agent.soc" : "agent.speedMps";
  const tick = point.tick ?? Math.round(point.t / dtS);
  const unit = series.unit === "fraction" ? "" : ` ${series.unit}`;
  const lead = `${fmtValue(point.v, series.unit)}${unit} is the sample of ${metric} at tick ${tick}${gap === undefined ? "" : ` (every ${gap.toFixed(1)} s)`}${next === undefined ? "" : `; the line to ${fmtValue(next.v, series.unit)}${unit} at ${next.t.toFixed(1)} s is drawn straight between two samples, it is not measured`}.`;
  return { kind: "metric", agentId: series.agentId, series: series.name, t: point.t, value: point.v, lead, chain: [{ relation: "value", label: `${metric} sample · tick ${tick}`, seq: undefined, tick }], seq: undefined };
}

/**
 * The chain behind a planner point: the compute record, then what caused it (each cause's own cause, up to `depth`), then its parent and what caused that. `lookup` reads one
 * record by its number.
 */
export async function computeProvenance(series: AnalysisSeries, point: SeriesPoint, lookup: Lookup, depth = 4): Promise<Provenance> {
  const seq = point.seq;
  const record = seq === undefined ? undefined : await lookup(seq);
  if (record === undefined) {
    return { kind: "compute", agentId: series.agentId, series: series.name, t: point.t, value: point.v, lead: `${fmtValue(point.v, series.unit)} ${unitWords(series)} at ${point.t.toFixed(1)} s is a planner value; its record is not in the part of the run that was read.`, chain: [], seq };
  }
  const chain: ChainStep[] = [{ relation: "value", label: `${recordWords(record)}${point.tick === undefined ? "" : ` · tick ${point.tick}`}`, seq: record.seq, tick: point.tick }];
  const walkCauses = async (from: TraceRecord, relation: "cause" | "parent"): Promise<TraceRecord | undefined> => {
    let cur = from;
    let first: TraceRecord | undefined;
    for (let i = 0; i < depth; i++) {
      const s = seqOfId(cur.causeIds?.[0]);
      const next = s === undefined ? undefined : await lookup(s);
      if (next === undefined) break;
      chain.push({ relation: i === 0 ? relation : "cause", label: recordWords(next), seq: next.seq, tick: undefined });
      first ??= next;
      cur = next;
    }
    return first;
  };
  const cause = await walkCauses(record, "cause");
  const parentSeq = seqOfId(record.parentId);
  const parent = parentSeq === undefined ? undefined : await lookup(parentSeq);
  if (parent !== undefined) {
    chain.push({ relation: "parent", label: recordWords(parent), seq: parent.seq, tick: undefined });
    await walkCauses(parent, "cause");
  }
  const what = series.name === "planner expansions" ? `${fmtValue(point.v, series.unit)} expansions` : `${fmtValue(point.v, series.unit)} ticks of planning latency`;
  const own = `${what} at ${point.t.toFixed(1)} s is one compute record`;
  const lead = cause === undefined ? `${own}: a plan ${series.agentId} made${parent === undefined ? "" : ` inside ${recordWords(parent)}`}, with no cause recorded.` : `${own}: the plan ${series.agentId} made after ${recordWords(cause).replace(/ #\d+$/, "")}.`;
  return { kind: "compute", agentId: series.agentId, series: series.name, t: point.t, value: point.v, lead, chain, seq: record.seq };
}
