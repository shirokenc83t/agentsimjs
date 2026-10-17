import { parseSourceFilter, type SourcePattern } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { migrate } from "./migrations.ts";
import type { SqlValue } from "./driver.ts";
import { compileSourceFilter } from "./source-filter.ts";
import { buildTraceQuery, timeWindowToSeqRange } from "./trace-query.ts";

const patterns = (v: string): SourcePattern[] => {
  const r = parseSourceFilter(v);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("source filter compilation (ADR-0031)", () => {
  it("emits only placeholders: values never reach the SQL text", () => {
    const c = compileSourceFilter({ include: patterns("uav-002/planner,uav-003/*,*/reflexes"), exclude: patterns("world/sim") });
    expect(c.sql).toBe(
      " AND ((t.source_owner = ? AND t.source_component = ?) OR t.source_owner = ? OR t.source_component = ?) AND NOT ((t.source_owner = ? AND t.source_component = ?))",
    );
    expect(c.params).toEqual(["uav-002", "planner", "uav-003", "reflexes", "world", "sim"]);
    expect(compileSourceFilter(undefined)).toEqual({ sql: "", params: [] });
  });

  it("rejects patterns that did not come from the parser", () => {
    expect(() => compileSourceFilter({ include: [{ owner: "x') OR 1=1 --", component: null }] })).toThrow();
    expect(() => compileSourceFilter({ include: [] })).toThrow();
    expect(() => compileSourceFilter({ exclude: [{ owner: null, component: null }] })).toThrow();
  });

  // ADR-0031 amendment: the source indexes end in seq, so they serve both the filter and the seq order of
  // paged queries; time windows are first mapped to a seq range. The plans are taken from the exact SQL
  // the store runs. No ANALYZE: the storage worker never runs it, so plans use the default estimates.
  function seeded() {
    const db = openNodeSqlDriver();
    migrate(db, () => 0);
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 0, 'x', 'running')");
    const insert = "INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, kind, payload, source_owner, source_component) VALUES (?, ?, ?, ?, 0, 'event', '{}', ?, ?)";
    db.transaction(() => {
      for (let i = 0; i < 4000; i++) {
        const component = i % 50 === 0 ? "planner" : (["body", "actions", "reflexes", "sensors"][i % 4] ?? "body");
        db.run(insert, ["run-000001", i, `r${i}`, Math.floor(i / 10) * 0.1 * 10, `uav-${String(i % 50).padStart(3, "0")}`, component]);
      }
    });
    return db;
  }
  const planOf = (db: ReturnType<typeof openNodeSqlDriver>, sql: string, params: SqlValue[]) =>
    db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join(" | ");

  it.each([
    ["source:uav-002/* paged by seq", "uav-002/*", undefined, "trace_records_run_owner_seq"],
    ["source:*/planner paged by seq", "*/planner", undefined, "trace_records_run_component_seq"],
    ["t:120..300 source:uav-002/*", "uav-002/*", { from: 120, to: 300 }, "trace_records_run_owner_seq"],
  ] as const)("%s uses the source index, with no sort", (_, value, simTime, index) => {
    const db = seeded();
    const q = { runId: "run-000001", afterSeq: 100, limit: 100, source: { include: patterns(value) }, ...(simTime ? { simTime } : {}) };
    const range = simTime ? timeWindowToSeqRange(db, "run-000001", simTime) : undefined;
    if (simTime) expect(range).toEqual({ min: 1200, max: 3009 });
    const built = buildTraceQuery(q, range ?? undefined);
    const plan = planOf(db, built.sql, built.params);
    expect(plan).toContain(index);
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
    db.close();
  });

  it("maps time windows with the (run_id, sim_time) index", () => {
    const db = seeded();
    const plan = planOf(db, "SELECT min(sim_time) AS t FROM trace_records WHERE run_id = ? AND sim_time >= ?", ["run-000001", 120]);
    expect(plan).toContain("trace_records_run_time");
    db.close();
  });
});
