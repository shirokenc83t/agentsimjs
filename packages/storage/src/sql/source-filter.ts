import { isValidSourcePattern, matchesSource, type SourcePattern } from "@agentsim/trace";
import type { TraceQuery } from "../ports.ts";
import type { SqlValue } from "./driver.ts";

/** Patterns arrive from another realm (the UI via the worker): re-validated; an invalid one is a bad request. */
function checked(patterns: readonly SourcePattern[] | undefined): readonly SourcePattern[] | undefined {
  if (patterns === undefined) return undefined;
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 32) throw new RangeError("invalid source filter");
  for (const p of patterns) if (!isValidSourcePattern(p)) throw new RangeError("invalid source filter");
  return patterns;
}

function orClause(patterns: readonly SourcePattern[], params: SqlValue[]): string {
  const parts = patterns.map((p) => {
    if (p.owner !== null && p.component !== null) {
      params.push(p.owner, p.component);
      return "(t.source_owner = ? AND t.source_component = ?)";
    }
    if (p.owner !== null) {
      params.push(p.owner);
      return "t.source_owner = ?";
    }
    params.push(p.component);
    return "t.source_component = ?";
  });
  return `(${parts.join(" OR ")})`;
}

/**
 * Compiles a source filter (ADR-0031) to a parameterized WHERE fragment over `trace_records t`. Values
 * never reach the SQL text: owner-only patterns use the (run_id, source_owner, sim_time) index,
 * component-only patterns the (run_id, source_component, sim_time) index.
 */
export function compileSourceFilter(source: TraceQuery["source"]): { sql: string; params: SqlValue[] } {
  const include = checked(source?.include);
  const exclude = checked(source?.exclude);
  const params: SqlValue[] = [];
  let sql = "";
  if (include) sql += ` AND ${orClause(include, params)}`;
  if (exclude) sql += ` AND NOT ${orClause(exclude, params)}`;
  return { sql, params };
}

/** Validates a filter up front (also when no record would be tested against it). */
export function checkSourceFilter(source: TraceQuery["source"]): void {
  checked(source?.include);
  checked(source?.exclude);
}

/** Same semantics in memory (in-memory adapter). */
export function sourceFilterMatches(source: TraceQuery["source"], recordSource: string): boolean {
  const include = checked(source?.include);
  const exclude = checked(source?.exclude);
  if (include && !matchesSource(include, recordSource)) return false;
  return !(exclude && matchesSource(exclude, recordSource));
}
