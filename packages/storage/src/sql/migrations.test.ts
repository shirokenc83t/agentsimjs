import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { appliedVersions, isKnownPrefix, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from "./migrations.ts";

describe("migrations", () => {
  it("applies all migrations once and is idempotent", () => {
    const db = openNodeSqlDriver();
    expect(appliedVersions(db)).toEqual([]);
    expect(migrate(db, () => 123).applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(migrate(db, () => 456).applied).toEqual([]);
    expect(appliedVersions(db)).toHaveLength(LATEST_SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(["belief_frames", "blobs", "deleted_runs",
      "metrics", "response_cache", "run_configs", "run_inputs", "runs", "scenarios", "schema_migrations", "snapshots", "trace_causes", "trace_records", "user_data"]);
    db.close();
  });

  it("upgrades a v1 database in place, keeping its data", () => {
    const db = openNodeSqlDriver();
    const v1 = MIGRATIONS[0];
    if (!v1) throw new Error("missing migration 1");
    db.exec(v1.sql);
    db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (1, '0001_init', 0)");
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    db.run("INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, kind, payload) VALUES ('run-000001', 0, 'r0', 0, 0, 'event', '{}')");
    expect(migrate(db, () => 1).applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(db.get<{ label: string }>("SELECT label FROM runs WHERE run_id = 'run-000001'")?.label).toBe("old");
    // ADR-0031: existing records are backfilled as world/sim.
    expect(db.get("SELECT source_owner, source_component FROM trace_records WHERE id = 'r0'")).toEqual({ source_owner: "world", source_component: "sim" });
    db.run("INSERT INTO scenarios (id, version, name, document, content_hash, created_at_wall_ms, updated_at_wall_ms) VALUES ('a', 1, 'A', '{}', '00000000', 1, 1)");
    expect(() => db.run("INSERT INTO scenarios (id, version, name, document, content_hash, created_at_wall_ms, updated_at_wall_ms) VALUES ('a', 1, 'A', '{}', '00000000', 2, 2)")).toThrow();
    db.close();
  });

  it("v7 adds the recording columns, the blob table and the belief frames, and a v6 database keeps its runs", () => {
    const db = openNodeSqlDriver();
    for (const m of MIGRATIONS.slice(0, 6)) {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
    }
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    expect(migrate(db, () => 1).applied).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(db.get("SELECT recording, recording_profile, recording_profile_hash FROM runs WHERE run_id = 'run-000001'")).toEqual({ recording: null, recording_profile: null, recording_profile_hash: null });
    expect(() => db.run("UPDATE runs SET recording = 'maybe' WHERE run_id = 'run-000001'")).toThrow();
    db.run("INSERT INTO blobs (run_id, id, data) VALUES ('run-000001', 'a', x'01')");
    expect(() => db.run("INSERT INTO blobs (run_id, id, data) VALUES ('run-000001', 'a', x'02')")).toThrow(); // one row per id per run
    db.run("INSERT INTO belief_frames (run_id, agent_id, seq, tick, sim_time, kind, chunks, blob_id) VALUES ('run-000001', 'uav-001', 0, 0, 0, 'keyframe', '[]', 'a')");
    db.run("INSERT INTO belief_frames (run_id, agent_id, seq, tick, sim_time, kind, chunks, data) VALUES ('run-000001', 'uav-001', 1, 1, 0.1, 'delta', '[3]', x'05')");
    expect(() => db.run("INSERT INTO belief_frames (run_id, agent_id, seq, tick, sim_time, kind, chunks) VALUES ('run-000001', 'uav-001', 2, 2, 0.2, 'delta', '[]')")).toThrow(); // bytes or blob, one of them
    expect(() => db.run("INSERT INTO belief_frames (run_id, agent_id, seq, tick, sim_time, kind, chunks, blob_id, data) VALUES ('run-000001', 'uav-001', 3, 3, 0.3, 'delta', '[]', 'a', x'05')")).toThrow();
    db.close();
  });

  it("v9 swaps the agent and kind indexes for ones that end in seq, and a v8 database keeps its records", () => {
    const db = openNodeSqlDriver();
    for (const m of MIGRATIONS.slice(0, 8)) {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
    }
    const names = () => db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'trace_records' AND name LIKE 'trace_records_run_%'").map((r) => r.name).sort();
    expect(names()).toEqual(expect.arrayContaining(["trace_records_run_agent_time", "trace_records_run_kind"]));
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    db.run("INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, agent_id, kind, payload) VALUES ('run-000001', 0, 'r0', 0, 0, 'uav-001', 'action', '{}')");
    expect(migrate(db, () => 1).applied).toEqual([9, 10, 11, 12, 13]);
    expect(names()).toEqual(expect.arrayContaining(["trace_records_run_agent_seq", "trace_records_run_kind_seq"]));
    expect(names()).not.toContain("trace_records_run_agent_time");
    expect(names()).not.toContain("trace_records_run_kind");
    expect(db.get("SELECT count(*) AS n FROM trace_records WHERE run_id = 'run-000001' AND agent_id = 'uav-001'")).toEqual({ n: 1 });
    db.close();
  });

  it("refuses unknown schema histories", () => {
    expect(isKnownPrefix([1])).toBe(true);
    expect(isKnownPrefix([1, 2])).toBe(true);
    expect(isKnownPrefix([1, 2, 3])).toBe(true);
    expect(isKnownPrefix([2])).toBe(false);
    expect(isKnownPrefix([1, 99])).toBe(false);
    const db = openNodeSqlDriver();
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at_wall_ms INTEGER); INSERT INTO schema_migrations VALUES (9, 'x', 0);");
    expect(() => migrate(db, () => 0)).toThrow(/unknown schema history/);
    db.close();
  });

  it("v11 adds the derived column, and a v10 database keeps its runs without one", () => {
    const db = openNodeSqlDriver();
    for (const m of MIGRATIONS.slice(0, 10)) {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
    }
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    expect(migrate(db, () => 1).applied).toEqual([11, 12, 13]);
    expect(db.get("SELECT derived FROM runs WHERE run_id = 'run-000001'")).toEqual({ derived: null });
    db.close();
  });

  it("v12 adds the metrics table, empty, and a v11 database keeps its runs", () => {
    const db = openNodeSqlDriver();
    for (const m of MIGRATIONS.slice(0, 11)) {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
    }
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    expect(migrate(db, () => 1).applied).toEqual([12, 13]);
    expect(db.get("SELECT count(*) AS n FROM metrics")).toEqual({ n: 0 });
    expect(db.get("SELECT label FROM runs WHERE run_id = 'run-000001'")).toEqual({ label: "old" });
    db.close();
  });

  it("v13 adds the parent and cause indexes, the queries' results are the same with and without them, and a v12 database keeps its records", () => {
    const db = openNodeSqlDriver();
    for (const m of MIGRATIONS.slice(0, 12)) {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, 0)", [m.version, m.name]);
    }
    db.run("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'old', 'completed')");
    db.run("INSERT INTO trace_records (run_id, seq, id, parent_id, sim_time, wall_time, kind, payload) VALUES ('run-000001', 0, 'run-000001#0', NULL, 0, 0, 'event', '{}'), ('run-000001', 1, 'run-000001#1', 'run-000001#0', 0, 0, 'event', '{}')");
    db.run("INSERT INTO trace_causes (run_id, record_id, cause_id) VALUES ('run-000001', 'run-000001#1', 'run-000001#0')");
    expect(migrate(db, () => 1).applied).toEqual([13]);
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
    expect(names).toContain("trace_records_run_parent_seq");
    expect(names).toContain("trace_causes_run_cause");
    expect(db.get("SELECT count(*) AS n FROM trace_records")).toEqual({ n: 2 });
    db.close();
  });
});
