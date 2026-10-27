import { asciiLower, parseFilter, type FilterAst, type FilterTerm, type SourcePattern, type TimeRange } from "@agentsim/trace";
import type { SqlValue } from "./driver.ts";

// The SQL backend of the filter language (ADR-0035 section 5, UI-SPEC section 5.2): a parsed AST compiled to a parameterized WHERE fragment. The text of the filter never
// reaches the SQL: the fragment is built from the AST's closed shapes and every value is a bound parameter. `matchesRecord` and `matchesSample` of the trace package are the
// same filter as a predicate; filter-equivalence.test.ts holds the two to the same result.
//
// Every condition is written so that it is never NULL (a missing agent, tier or parent is false, not unknown), so that negating a term gives the same answer as the predicate.

export interface Fragment {
  readonly sql: string;
  readonly params: SqlValue[];
  /** A term that an index serves from its value (the children or the effects of a record): the query is better driven by it than by the seq order, and sorts what it finds. */
  readonly driven?: boolean;
}

/** Parses a filter that arrived over the worker's boundary and checks it selects the kind of row asked for; a bad one is a bad request. */
export function parseQueryFilter(text: string, target: FilterAst["target"]): FilterAst {
  const parsed = parseFilter(text);
  if (!parsed.ok) throw new RangeError(`invalid filter: ${parsed.error.message}`);
  if (parsed.value.target !== target) {
    throw new RangeError(target === "records" ? "a metric filter selects samples: ask the metrics" : "this filter selects trace records: a metric filter has a metric: term");
  }
  return parsed.value;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

function rangeClause(column: string, ranges: readonly TimeRange[], params: SqlValue[]): string {
  const parts = ranges.map((r) => {
    const conds: string[] = [];
    if (Number.isFinite(r.min)) {
      conds.push(`${column} ${r.minOpen ? ">" : ">="} ?`);
      params.push(r.min);
    }
    if (Number.isFinite(r.max)) {
      conds.push(`${column} ${r.maxOpen ? "<" : "<="} ?`);
      params.push(r.max);
    }
    return conds.length === 0 ? "1" : `(${conds.join(" AND ")})`;
  });
  return `(${parts.join(" OR ")})`;
}

function sourceClause(owner: string, component: string, patterns: readonly SourcePattern[], params: SqlValue[]): string {
  const parts = patterns.map((p) => {
    if (p.owner !== null && p.component !== null) {
      params.push(p.owner, p.component);
      return `(${owner} = ? AND ${component} = ?)`;
    }
    if (p.owner !== null) {
      params.push(p.owner);
      return `${owner} = ?`;
    }
    params.push(p.component);
    return `${component} = ?`;
  });
  return `(${parts.join(" OR ")})`;
}

function recordTerm(t: FilterTerm, runId: string, params: SqlValue[]): string {
  switch (t.key) {
    case "agent":
    case "group":
    case "tier": {
      const column = t.key === "agent" ? "t.agent_id" : t.key === "group" ? "t.group_id" : "t.tier";
      params.push(...t.values);
      return `COALESCE(${column} IN (${placeholders(t.values.length)}), 0)`;
    }
    case "kind":
      params.push(...t.values);
      return `t.kind IN (${placeholders(t.values.length)})`;
    case "detector":
    case "status":
      // The path is one of two constants; the values are parameters.
      params.push(...t.values);
      return `COALESCE(json_extract(t.payload, '$.${t.key}') IN (${placeholders(t.values.length)}), 0)`;
    case "t":
      return rangeClause("t.sim_time", t.ranges, params);
    case "text":
      params.push(asciiLower(t.text));
      return "instr(lower(t.payload), ?) > 0";
    case "cause":
      params.push(runId, ...t.seqs.map((s) => `${runId}#${s}`));
      // Uncorrelated, so the causes index starts the lookup from the cause (an EXISTS per record would visit every record of the run).
      return `t.id IN (SELECT c.record_id FROM trace_causes c WHERE c.run_id = ? AND c.cause_id IN (${placeholders(t.seqs.length)}))`;
    case "parent":
      params.push(...t.seqs.map((s) => `${runId}#${s}`));
      // `IS NOT NULL AND ... IN`: false (not unknown) for a record with no parent, so a negation still keeps it, and the planner can use the partial parent index.
      return `(t.parent_id IS NOT NULL AND t.parent_id IN (${placeholders(t.seqs.length)}))`;
    case "source":
      return sourceClause("t.source_owner", "t.source_component", t.patterns, params);
    case "metric":
      throw new RangeError("a metric term does not apply to trace records");
  }
}

/** The WHERE fragment (` AND ...`, or empty) of a record filter over `trace_records t`, for the run being queried. */
export function compileRecordFilter(ast: FilterAst, runId: string): Fragment {
  const params: SqlValue[] = [];
  let sql = "";
  let driven = false;
  for (const t of ast.terms) {
    const clause = recordTerm(t, runId, params);
    sql += t.negated ? ` AND NOT (${clause})` : ` AND (${clause})`;
    if (!t.negated && (t.key === "cause" || t.key === "parent")) driven = true;
  }
  return { sql, params, ...(driven ? { driven } : {}) };
}

const SAMPLE_OWNER = "substr(m.source, 1, instr(m.source, '/') - 1)";
const SAMPLE_COMPONENT = "substr(m.source, instr(m.source, '/') + 1)";

function sampleTerm(t: FilterTerm, params: SqlValue[]): string {
  switch (t.key) {
    case "metric":
      params.push(...t.names);
      return `m.name IN (${placeholders(t.names.length)})`;
    case "source":
      return sourceClause(SAMPLE_OWNER, SAMPLE_COMPONENT, t.patterns, params);
    case "t":
      return rangeClause("m.sim_time", t.ranges, params);
    case "agent":
      params.push(...t.values);
      return `${SAMPLE_OWNER} IN (${placeholders(t.values.length)})`;
    default:
      throw new RangeError(`${t.key}: does not apply to metric samples`);
  }
}

/** The WHERE fragment (` AND ...`) of a metric filter over `metrics m`. */
export function compileMetricFilter(ast: FilterAst): Fragment {
  const params: SqlValue[] = [];
  let sql = "";
  for (const t of ast.terms) {
    const clause = sampleTerm(t, params);
    sql += t.negated ? ` AND NOT (${clause})` : ` AND (${clause})`;
  }
  return { sql, params };
}
