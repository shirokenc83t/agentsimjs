import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { appliedVersions, isKnownPrefix, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from "./migrations.ts";

describe("migrations", () => {
  it("applies all migrations once and is idempotent", () => {
    const db = openNodeSqlDriver();
    expect(appliedVersions(db)).toEqual([]);
    expect(migrate(db, () => 123).applied).toEqual([1, 2, 3, 4, 5, 6]);
    expect(migrate(db, () => 456).applied).toEqual([]);
    expect(appliedVersions(db)).toHaveLength(LATEST_SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(["response_cache", "run_configs", "run_inputs", "runs", "scenarios", "schema_migrations", "snapshots", "trace_causes", "trace_records", "user_data"]);
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
    expect(migrate(db, () => 1).applied).toEqual([2, 3, 4, 5, 6]);
    expect(db.get<{ label: string }>("SELECT label FROM runs WHERE run_id = 'run-000001'")?.label).toBe("old");
    // ADR-0031: existing records are backfilled as world/sim.
    expect(db.get("SELECT source_owner, source_component FROM trace_records WHERE id = 'r0'")).toEqual({ source_owner: "world", source_component: "sim" });
    db.run("INSERT INTO scenarios (id, version, name, document, content_hash, created_at_wall_ms, updated_at_wall_ms) VALUES ('a', 1, 'A', '{}', '00000000', 1, 1)");
    expect(() => db.run("INSERT INTO scenarios (id, version, name, document, content_hash, created_at_wall_ms, updated_at_wall_ms) VALUES ('a', 1, 'A', '{}', '00000000', 2, 2)")).toThrow();
    db.close();
  });

  it("refuses unknown schema histories", () => {
    expect(isKnownPrefix([1])).toBe(true);
    expect(isKnownPrefix([1, 2])).toBe(true);
    expect(isKnownPrefix([1, 2, 3])).toBe(true);
    expect(isKnownPrefix([2])).toBe(false);
    expect(isKnownPrefix([1, 99])).toBe(false);
    const db = openNodeSqlDriver();
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at_wall_ms INTEGER); INSERT INTO schema_migrations VALUES (7, 'x', 0);");
    expect(() => migrate(db, () => 0)).toThrow(/unknown schema history/);
    db.close();
  });
});
