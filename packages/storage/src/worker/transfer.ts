import type { CodedError, Result } from "@agentsim/core";
import { PROVIDER_KEYS_NAMESPACE } from "../provider-keys.ts";
import { err, ok } from "@agentsim/core";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { SqlDriver, SqlValue } from "../sql/driver.ts";
import { appliedVersions, isKnownPrefix, migrate } from "../sql/migrations.ts";
import { firstRecordingProblem } from "../sql/recording-integrity.ts";
import { openWasmSqlDriver } from "../drivers/wasm-sql-driver.ts";

export type ImportErrorCode =
  | "not_sqlite"
  | "too_large"
  | "corrupt"
  | "integrity_failed"
  | "unexpected_objects"
  | "unknown_tables"
  | "unknown_schema_version"
  | "non_monotonic_trace"
  | "broken_recording";

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const SQLITE_HEADER = "SQLite format 3\u0000";

/** Opens an in-memory database (not a pool file, ADR-0020). */
function openMemory(sqlite3: Sqlite3Static): { driver: SqlDriver; raw: Database } {
  let raw: Database | undefined;
  const driver = openWasmSqlDriver(null, () => (raw = new sqlite3.oo1.DB(":memory:", "c")));
  if (!raw) throw new Error("unreachable: database not opened");
  return { driver, raw };
}

/** Loads `bytes` into a fresh in-memory database with sqlite3_deserialize. */
/**
 * A copy of a database file without the provider keys remembered on this device (ADR-0044 §3: a key is never exported). The rows are deleted from an in-memory copy and the copy is vacuumed, so that no page
 * of the file still holds a key; a file with none is returned as it is.
 */
export function withoutProviderKeys(sqlite3: Sqlite3Static, bytes: Uint8Array): Uint8Array {
  const mem = deserializeToMemory(sqlite3, bytes);
  try {
    const has = mem.driver.get<{ n: number }>("SELECT count(*) AS n FROM user_data WHERE namespace = ?", [PROVIDER_KEYS_NAMESPACE])?.n ?? 0;
    if (has === 0) return bytes;
    mem.driver.run("DELETE FROM user_data WHERE namespace = ?", [PROVIDER_KEYS_NAMESPACE]);
    mem.driver.exec("VACUUM");
    return sqlite3.capi.sqlite3_js_db_export(mem.raw);
  } finally {
    mem.driver.close();
  }
}

export function deserializeToMemory(sqlite3: Sqlite3Static, bytes: Uint8Array): { driver: SqlDriver; raw: Database } {
  const mem = openMemory(sqlite3);
  const capi = sqlite3.capi;
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const rc = capi.sqlite3_deserialize(mem.raw, "main", p, bytes.byteLength, bytes.byteLength, flags);
  if (rc !== 0) {
    mem.driver.close();
    throw new Error(`sqlite3_deserialize failed: ${rc}`);
  }
  return mem;
}

/** Names of the tables our current schema defines (derived, so it never drifts from migrations). */
function knownTables(sqlite3: Sqlite3Static): Set<string> {
  const mem = openMemory(sqlite3);
  try {
    migrate(mem.driver, () => 0);
    return new Set(mem.driver.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name));
  } finally {
    mem.driver.close();
  }
}

/**
 * Validates an untrusted `.sqlite` file entirely in memory (ADR-0020): header, deserialize,
 * integrity_check, no triggers/views, only known tables, known schema history.
 * No temporary OPFS files are created.
 */
export function validateImport(sqlite3: Sqlite3Static, bytes: Uint8Array): Result<void, CodedError<ImportErrorCode>> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) return err({ code: "too_large", message: `file exceeds ${MAX_IMPORT_BYTES} bytes` });
  if (bytes.byteLength < 100 || new TextDecoder().decode(bytes.subarray(0, 16)) !== SQLITE_HEADER) {
    return err({ code: "not_sqlite", message: "not an SQLite database file" });
  }
  const allowed = knownTables(sqlite3);
  let mem: { driver: SqlDriver } | undefined;
  try {
    mem = deserializeToMemory(sqlite3, bytes);
    const db = mem.driver;
    const ic = db.all<{ integrity_check: string }>("PRAGMA integrity_check").map((r) => r.integrity_check);
    if (ic.length !== 1 || ic[0] !== "ok") return err({ code: "integrity_failed", message: "integrity check failed", details: ic.slice(0, 10) });
    const objects = db.all<{ type: string; name: string }>("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view')");
    if (objects.length > 0) return err({ code: "unexpected_objects", message: "triggers and views are not allowed", details: objects });
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name);
    const unknown = tables.filter((t) => !allowed.has(t)).sort();
    if (unknown.length > 0) return err({ code: "unknown_tables", message: `unknown tables: ${unknown.join(", ")}`, details: unknown });
    if (!isKnownPrefix(appliedVersions(db))) return err({ code: "unknown_schema_version", message: "schema history not recognized" });
    // Run invariant (ADR-0031 amendment): within a run, seq order is sim-time order.
    const backwards = db.get<{ run_id: string; seq: number }>(
      `SELECT run_id, seq FROM (SELECT run_id, seq, sim_time, lag(sim_time) OVER (PARTITION BY run_id ORDER BY seq) AS prev FROM trace_records)
       WHERE sim_time < prev LIMIT 1`,
    );
    if (backwards) return err({ code: "non_monotonic_trace", message: `run ${backwards.run_id}: sim time goes backwards at seq ${backwards.seq}`, details: backwards });
    // Recording (ADR-0035 addition of 2026-10-17): blobs, snapshots and belief frames agree with each other and with the run header.
    const broken = firstRecordingProblem(db);
    if (broken) return err({ code: "broken_recording", message: broken });
    return ok(undefined);
  } catch (e) {
    return err({ code: "corrupt", message: e instanceof Error ? e.message : String(e) });
  } finally {
    mem?.driver.close();
  }
}

// Everything a run owns: its header, trace and snapshots, and its run inputs (researcher commands, replayed to reproduce it).
// Blobs come before the rows that refer to them (foreign keys).
const RUN_TABLES = ["runs", "run_inputs", "trace_records", "trace_causes", "blobs", "snapshots", "belief_frames", "metrics"] as const;

/** Copies one run into an in-memory database with the same DDL and serializes it (ADR-0020). */
export function exportRun(sqlite3: Sqlite3Static, source: SqlDriver, runId: string): Result<Uint8Array, CodedError<"unknown_run">> {
  if (!source.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId])) return err({ code: "unknown_run", message: `unknown run ${runId}` });
  const mem = openMemory(sqlite3);
  try {
    migrate(mem.driver, () => 0);
    const copy = (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      mem.driver.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c] as SqlValue));
    };
    mem.driver.transaction(() => {
      // The scenario version the run used travels with it (ADR-0028: a run is reproducible from it).
      const ref = source.get<{ scenario_id: string | null; scenario_version: number | null }>("SELECT scenario_id, scenario_version FROM runs WHERE run_id = ?", [runId]);
      if (ref?.scenario_id) {
        for (const row of source.all("SELECT * FROM scenarios WHERE id = ? AND version = ?", [ref.scenario_id, ref.scenario_version])) copy("scenarios", row);
      }
      for (const table of RUN_TABLES) {
        for (const row of source.all(`SELECT * FROM ${table} WHERE run_id = ?`, [runId])) copy(table, row);
      }
    });
    return ok(sqlite3.capi.sqlite3_js_db_export(mem.raw));
  } finally {
    mem.driver.close();
  }
}
