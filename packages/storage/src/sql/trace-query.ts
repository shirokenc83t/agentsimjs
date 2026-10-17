import type { TraceQuery } from "../ports.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";
import { compileSourceFilter } from "./source-filter.ts";

const MAX_LIMIT = 10_000;

/** Inclusive seq range of a run's records within a sim-time window, or null if the window is empty. */
export interface SeqRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Maps a sim-time window to a seq range (ADR-0031 amendment) with four index lookups on
 * (run_id, sim_time): seq order is sim-time order within a run, so the records of the window are exactly
 * those between the first and last seq at its boundary times.
 */
export function timeWindowToSeqRange(db: SqlDriver, runId: string, window: NonNullable<TraceQuery["simTime"]>): SeqRange | null {
  const from = window.from ?? Number.NEGATIVE_INFINITY;
  const to = window.to ?? Number.POSITIVE_INFINITY;
  if (!(from <= to)) return null; // also rejects NaN
  const t0 = db.get<{ t: number | null }>("SELECT min(sim_time) AS t FROM trace_records WHERE run_id = ? AND sim_time >= ?", [runId, from])?.t ?? null;
  const t1 = db.get<{ t: number | null }>("SELECT max(sim_time) AS t FROM trace_records WHERE run_id = ? AND sim_time <= ?", [runId, to])?.t ?? null;
  if (t0 === null || t1 === null || t0 > t1) return null;
  const min = db.get<{ s: number }>("SELECT min(seq) AS s FROM trace_records WHERE run_id = ? AND sim_time = ?", [runId, t0])?.s;
  const max = db.get<{ s: number }>("SELECT max(seq) AS s FROM trace_records WHERE run_id = ? AND sim_time = ?", [runId, t1])?.s;
  return min === undefined || max === undefined ? null : { min, max };
}

/**
 * The paged trace query: a run, a seq lower bound (paging), an optional seq range (time window) and a
 * source filter, ordered by seq. Fully parameterized; the source filter uses the (run_id, owner|component,
 * seq) indexes, which also supply the seq order.
 */
export function buildTraceQuery(q: TraceQuery, range: SeqRange | undefined): { sql: string; params: SqlValue[] } {
  const filter = compileSourceFilter(q.source);
  const params: SqlValue[] = [q.runId, Math.max(q.afterSeq ?? -1, range ? range.min - 1 : -1)];
  let where = "t.run_id = ? AND t.seq > ?";
  if (range) {
    // Unary plus: the upper bound filters rows but is not offered to the planner as an index range, so a
    // source filter keeps its (run_id, owner|component, seq) index instead of a two-sided PK range.
    where += " AND +t.seq <= ?";
    params.push(range.max);
  }
  params.push(...filter.params, Math.max(0, Math.min(q.limit, MAX_LIMIT)));
  return {
    sql: `SELECT t.*, (SELECT json_group_array(cause_id) FROM (SELECT cause_id FROM trace_causes c
                     WHERE c.run_id = t.run_id AND c.record_id = t.id ORDER BY cause_id)) AS cause_ids_all
          FROM trace_records t WHERE ${where}${filter.sql} ORDER BY t.seq LIMIT ?`,
    params,
  };
}
