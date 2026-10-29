import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { buildTraceQuery } from "./trace-query.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlDriver } from "./driver.ts";

// F3c M3, T-100: the children (`parent:#N`) and the effects (`cause:#N`) of a record are read by index. Before schema v13 the parent filter scanned every record of the run and the cause filter
// probed the causes of every record; the numbers of that are printed here (a synthetic run of the shape of a real one: every record has a parent, about a dozen children per parent, and a cause).

const RUN = "run-000001";
const N = 150_000;
const FAN = 12;

function fill(db: SqlDriver): void {
  db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES (?, 0, 1, 'big', 'completed')", [RUN]);
  db.exec("BEGIN");
  for (let seq = 0; seq < N; seq++) {
    const parent = seq === 0 ? null : `${RUN}#${Math.floor((seq - 1) / FAN)}`;
    db.run("INSERT INTO trace_records (run_id, seq, id, parent_id, sim_time, wall_time, agent_id, kind, payload) VALUES (?, ?, ?, ?, ?, 0, ?, 'action', '{}')", [RUN, seq, `${RUN}#${seq}`, parent, seq * 0.01, `uav-${String(seq % 20).padStart(3, "0")}`]);
    if (seq > 2) db.run("INSERT INTO trace_causes (run_id, record_id, cause_id) VALUES (?, ?, ?)", [RUN, `${RUN}#${seq}`, `${RUN}#${Math.floor(seq / 3)}`]);
  }
  db.exec("COMMIT");
}

const dbWith = (versions: number): SqlDriver => {
  const db = openNodeSqlDriver(":memory:");
  for (const m of MIGRATIONS.slice(0, versions)) {
    db.exec(m.sql);
    db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
  }
  fill(db);
  return db;
};

function time(f: () => unknown, reps = 15): number {
  const t: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    f();
    t.push(performance.now() - t0);
  }
  return t.sort((a, b) => a - b)[Math.floor(reps / 2)] as number;
}

describe("the parent and cause indexes (schema v13)", () => {
  it("the new queries use the indexes, return what the old queries returned, and are faster by far (numbers printed)", () => {
    const before = dbWith(12);
    const after = dbWith(13);
    const target = 4000; // a record with about a dozen children and its effects
    const oldParent = () => before.all<{ seq: number }>("SELECT t.seq FROM trace_records t WHERE t.run_id = ? AND t.seq > -1 AND COALESCE(t.parent_id IN (?), 0) ORDER BY t.seq", [RUN, `${RUN}#${target}`]);
    const oldCause = () => before.all<{ seq: number }>("SELECT t.seq FROM trace_records t WHERE t.run_id = ? AND t.seq > -1 AND EXISTS (SELECT 1 FROM trace_causes c WHERE c.run_id = t.run_id AND c.record_id = t.id AND c.cause_id IN (?)) ORDER BY t.seq", [RUN, `${RUN}#${target}`]);
    const newOf = (filter: string) => buildTraceQuery({ runId: RUN, filter, limit: 10_000 }, undefined);
    const np = newOf(`parent:#${target}`);
    const nc = newOf(`cause:#${target}`);
    const newParent = () => after.all<{ seq: number }>(np.sql, np.params).map((r) => ({ seq: r.seq }));
    const newCause = () => after.all<{ seq: number }>(nc.sql, nc.params).map((r) => ({ seq: r.seq }));
    expect(newParent()).toEqual(oldParent());
    expect(newCause()).toEqual(oldCause());
    expect(newParent().length).toBeGreaterThan(5);
    expect(newCause().length).toBeGreaterThan(2);
    // The plans start from the indexes.
    expect(after.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${np.sql}`, np.params).map((r) => r.detail).join(" | ")).toContain("trace_records_run_parent_seq");
    expect(after.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${nc.sql}`, nc.params).map((r) => r.detail).join(" | ")).toContain("trace_causes_run_cause");
    const t = { parentBefore: time(oldParent), parentAfter: time(newParent), causeBefore: time(oldCause), causeAfter: time(newCause) };
    console.log(`MEASURE ${N} records: parent: ${t.parentBefore.toFixed(2)} ms -> ${t.parentAfter.toFixed(3)} ms; cause: ${t.causeBefore.toFixed(2)} ms -> ${t.causeAfter.toFixed(3)} ms`);
    expect(t.parentAfter).toBeLessThan(t.parentBefore / 5);
    expect(t.causeAfter).toBeLessThan(t.causeBefore / 5);
    // A negation keeps the records with no parent (the root has none): false, not unknown.
    const neg = newOf(`-parent:#${target}`);
    const kept = after.all<{ seq: number }>(neg.sql.replace("LIMIT ?", "LIMIT 200000").replace(/(\s*)$/, ""), neg.params.slice(0, -1));
    expect(kept.find((r) => r.seq === 0)).toBeDefined();
    expect(kept).toHaveLength(N - newParent().length);
    before.close();
    after.close();
  });

});

describe("the cost of the two indexes at append (numbers printed)", () => {
  it("appending 20,000 records with a parent and a cause each costs a few tens of percent more, not a multiple", () => {
    const run = (versions: number): number => {
      const db = openNodeSqlDriver(":memory:");
      for (const m of MIGRATIONS.slice(0, versions)) {
        db.exec(m.sql);
        db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
      }
      db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES (?, 0, 1, 'x', 'running')", [RUN]);
      const t0 = performance.now();
      db.exec("BEGIN");
      for (let seq = 0; seq < 20_000; seq++) {
        db.run("INSERT INTO trace_records (run_id, seq, id, parent_id, sim_time, wall_time, agent_id, kind, payload) VALUES (?, ?, ?, ?, ?, 0, 'a', 'action', '{}')", [RUN, seq, `${RUN}#${seq}`, seq === 0 ? null : `${RUN}#${Math.floor((seq - 1) / FAN)}`, seq * 0.01]);
        if (seq > 2) db.run("INSERT INTO trace_causes (run_id, record_id, cause_id) VALUES (?, ?, ?)", [RUN, `${RUN}#${seq}`, `${RUN}#${Math.floor(seq / 3)}`]);
      }
      db.exec("COMMIT");
      const ms = performance.now() - t0;
      db.close();
      return ms;
    };
    const before = Math.min(run(12), run(12), run(12));
    const after = Math.min(run(13), run(13), run(13));
    console.log(`APPEND 20000 records with causes: ${before.toFixed(0)} ms -> ${after.toFixed(0)} ms (${(((after - before) / before) * 100).toFixed(0)} %)`);
    expect(after).toBeLessThan(before * 2);
  });
});
