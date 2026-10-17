import type { TraceRecord } from "@agentsim/trace";

/** One search of a strategy query (ADR-0037 trace): the stage, what it did and the path it found. */
export interface SearchView {
  readonly path: string;
  readonly role: string;
  readonly algorithm: string;
  readonly weight: number | undefined;
  readonly heuristic: string;
  readonly stageBudget: number | undefined;
  readonly expansions: number;
  readonly result: string;
  readonly startedTick: number;
  readonly endedTick: number;
  readonly waypoints: readonly (readonly [number, number])[] | undefined;
}

/** A condition of a `select` node with the values it was evaluated on, and the branch taken. */
export interface SelectView {
  readonly path: string;
  readonly branch: number | "else";
  readonly values: Readonly<Record<string, number>>;
}

export interface StrategyView {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly selects: readonly SelectView[];
  readonly searches: readonly SearchView[];
  readonly thinned: { readonly legs: number; readonly kept: number } | undefined;
}

export interface RestartView {
  readonly reason: string;
  readonly spent: number;
  readonly interrupted: boolean;
  readonly simTimeS: number;
}

/** A leg of a lazy plan the moment it became ready (the goTo action's `leg` note). */
export interface LegView {
  readonly index: number;
  readonly count: number;
  readonly last: boolean;
  readonly tick: number;
}

export type QueryStatus = "running" | "found" | "not_found" | "budget_exceeded" | "interrupted";

/** A planning query of one agent, assembled from its `compute` and `action` records. */
export interface QueryRow {
  readonly queryId: string;
  readonly agentId: string;
  /** Sequence number of the first record of this query: the table's order. */
  readonly seq: number;
  readonly status: QueryStatus;
  readonly algorithm: string | undefined;
  readonly submittedTick: number | undefined;
  readonly completedTick: number | undefined;
  readonly expansionsCharged: number | undefined;
  readonly restarts: readonly RestartView[];
  readonly interruptions: number;
  readonly legs: readonly LegView[];
  readonly strategy: StrategyView | undefined;
  /** The path of the whole query (found plans). */
  readonly waypoints: readonly (readonly [number, number])[] | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function points(v: unknown): readonly (readonly [number, number])[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: [number, number][] = [];
  for (const p of v) if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") out.push([p[0], p[1]]);
  return out;
}

/** A strategy trace as the worker sends it (a `plan` record's or a sandbox result's), read defensively; `undefined` if it is not one. */
export function strategyViewOf(v: unknown): StrategyView | undefined {
  if (!isObj(v) || typeof v["id"] !== "string") return undefined;
  const selects = Array.isArray(v["selects"]) ? v["selects"] : [];
  const searches = Array.isArray(v["searches"]) ? v["searches"] : [];
  const th = v["thinned"];
  return {
    id: v["id"],
    version: num(v["version"]) ?? 0,
    hash: str(v["hash"]) ?? "",
    selects: selects.filter(isObj).map((s) => ({
      path: str(s["path"]) ?? "",
      branch: s["branch"] === "else" ? "else" : (num(s["branch"]) ?? 0),
      values: isObj(s["values"]) ? (Object.fromEntries(Object.entries(s["values"]).filter((e): e is [string, number] => typeof e[1] === "number")) as Record<string, number>) : {},
    })),
    searches: searches.filter(isObj).map((s) => ({
      path: str(s["path"]) ?? "",
      role: str(s["role"]) ?? "",
      algorithm: str(s["algorithm"]) ?? "",
      weight: num(s["weight"]),
      heuristic: str(s["heuristic"]) ?? "",
      stageBudget: num(s["stageBudget"]),
      expansions: num(s["expansions"]) ?? 0,
      result: str(s["result"]) ?? "",
      startedTick: num(s["startedTick"]) ?? 0,
      endedTick: num(s["endedTick"]) ?? 0,
      waypoints: points(s["waypoints"]),
    })),
    thinned: isObj(th) ? { legs: num(th["legs"]) ?? 0, kept: num(th["kept"]) ?? 0 } : undefined,
  };
}

interface MutableRow {
  queryId: string;
  agentId: string;
  seq: number;
  status: QueryStatus;
  algorithm: string | undefined;
  submittedTick: number | undefined;
  completedTick: number | undefined;
  expansionsCharged: number | undefined;
  restarts: RestartView[];
  interruptions: number;
  legs: LegView[];
  strategy: StrategyView | undefined;
  waypoints: readonly (readonly [number, number])[] | undefined;
}

/**
 * The planning queries of every agent, assembled incrementally from the run's trace records (UI-SPEC: the Inspector's
 * query table). A cursor over the record list means a new batch costs its own size, never a rescan; a new run (another
 * run id, or an earlier sequence number) resets the index. Records are data from the worker: nothing here simulates.
 *
 * A query is one `queryId` of one agent. Its `restart` records arrive while it runs, its `plan` record when it
 * completes, and the `leg` and interrupted-`replan` notes of the goTo that owns it carry the same `queryId`.
 */
export class PlanQueryIndex {
  private runId: string | undefined;
  private lastSeq = -1;
  private rows = new Map<string, Map<string, MutableRow>>();
  /** Per agent: a version that moves when its rows change, and the rows as last handed out. */
  private versions = new Map<string, number>();
  private cache = new Map<string, { version: number; rows: readonly QueryRow[] }>();

  /** Reads the records after the cursor. Returns the agents whose rows changed. */
  ingest(records: readonly TraceRecord[]): ReadonlySet<string> {
    const changed = new Set<string>();
    const last = records[records.length - 1];
    if (!last) {
      if (this.lastSeq >= 0) this.reset();
      return changed;
    }
    if (last.runId !== this.runId || last.seq < this.lastSeq) this.reset();
    this.runId = last.runId;
    // Records are in sequence order: walk back to the first one not yet read.
    let from = records.length;
    while (from > 0 && (records[from - 1]?.seq ?? -1) > this.lastSeq) from--;
    for (let k = from; k < records.length; k++) {
      const r = records[k];
      if (r && this.apply(r)) changed.add(r.agentId ?? "");
    }
    this.lastSeq = last.seq;
    for (const id of changed) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    return changed;
  }

  /** The agent's queries in the order they started; the same array while nothing changed. */
  queries(agentId: string): readonly QueryRow[] {
    const version = this.versions.get(agentId) ?? 0;
    const hit = this.cache.get(agentId);
    if (hit && hit.version === version) return hit.rows;
    const rows = [...(this.rows.get(agentId)?.values() ?? [])].sort((a, b) => a.seq - b.seq).map((r): QueryRow => ({ ...r, restarts: [...r.restarts], legs: [...r.legs] }));
    this.cache.set(agentId, { version, rows });
    return rows;
  }

  private reset(): void {
    this.rows = new Map();
    this.versions = new Map();
    this.cache = new Map();
    this.lastSeq = -1;
  }

  private row(r: TraceRecord, queryId: string): MutableRow | undefined {
    if (r.agentId === undefined) return undefined;
    let byQuery = this.rows.get(r.agentId);
    if (!byQuery) this.rows.set(r.agentId, (byQuery = new Map()));
    let row = byQuery.get(queryId);
    if (!row) {
      row = { queryId, agentId: r.agentId, seq: r.seq, status: "running", algorithm: undefined, submittedTick: undefined, completedTick: undefined, expansionsCharged: undefined, restarts: [], interruptions: 0, legs: [], strategy: undefined, waypoints: undefined };
      byQuery.set(queryId, row);
    }
    return row;
  }

  private apply(r: TraceRecord): boolean {
    const p = r.payload;
    if (!isObj(p)) return false;
    const queryId = str(p["queryId"]);
    if (queryId === undefined) return false;
    if (r.kind === "compute" && p["op"] === "restart") {
      const row = this.row(r, queryId);
      if (!row) return false;
      const interrupted = p["interrupted"] === true;
      row.restarts.push({ reason: str(p["reason"]) ?? "?", spent: num(p["spent"]) ?? 0, interrupted, simTimeS: r.simTime });
      if (interrupted) {
        row.interruptions++;
        row.status = "interrupted";
      }
      return true;
    }
    if (r.kind === "compute" && p["op"] === "plan") {
      const row = this.row(r, queryId);
      if (!row) return false;
      const status = str(p["status"]);
      row.status = status === "found" || status === "not_found" || status === "budget_exceeded" ? status : row.interruptions > 0 ? "interrupted" : "running";
      row.algorithm = typeof p["algorithm"] === "string" ? p["algorithm"] : JSON.stringify(p["algorithm"] ?? "?");
      row.submittedTick = num(p["submittedTick"]);
      row.completedTick = num(p["completedTick"]);
      row.expansionsCharged = num(p["expansionsCharged"]);
      row.waypoints = points(p["waypoints"]);
      row.strategy = strategyViewOf(p["strategy"]);
      return true;
    }
    if (r.kind === "action" && p["op"] === "leg") {
      const row = this.row(r, queryId);
      if (!row) return false;
      row.legs.push({ index: num(p["index"]) ?? 0, count: num(p["count"]) ?? 0, last: p["last"] === true, tick: num(p["tick"]) ?? 0 });
      return true;
    }
    return false;
  }
}
