import init0001 from "../../schema/0001_init.sql?raw";
import scenarios0002 from "../../schema/0002_scenarios.sql?raw";
import runConfigs0003 from "../../schema/0003_run_configs.sql?raw";
import traceSource0004 from "../../schema/0004_trace_source.sql?raw";
import runInputs0005 from "../../schema/0005_run_inputs.sql?raw";
import idealAgents0006 from "../../schema/0006_ideal_agents.sql?raw";
import recording0007 from "../../schema/0007_recording.sql?raw";
import deletedRuns0008 from "../../schema/0008_deleted_runs.sql?raw";
import traceAgentKindSeq0009 from "../../schema/0009_trace_agent_kind_seq.sql?raw";
import importedFrom0010 from "../../schema/0010_imported_from.sql?raw";
import type { SqlDriver } from "./driver.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered list; append only. The SQL files are the source of truth (shared with the backend). */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "0001_init", sql: init0001 },
  { version: 2, name: "0002_scenarios", sql: scenarios0002 },
  { version: 3, name: "0003_run_configs", sql: runConfigs0003 },
  { version: 4, name: "0004_trace_source", sql: traceSource0004 },
  { version: 5, name: "0005_run_inputs", sql: runInputs0005 },
  { version: 6, name: "0006_ideal_agents", sql: idealAgents0006 },
  { version: 7, name: "0007_recording", sql: recording0007 },
  { version: 8, name: "0008_deleted_runs", sql: deletedRuns0008 },
  { version: 9, name: "0009_trace_agent_kind_seq", sql: traceAgentKindSeq0009 },
  { version: 10, name: "0010_imported_from", sql: importedFrom0010 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** Versions recorded in `schema_migrations`, or [] for an empty database. */
export function appliedVersions(db: SqlDriver): number[] {
  const exists = db.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'");
  if (!exists) return [];
  return db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
}

/** True if `versions` is a prefix of our known migration sequence (1, 2, …). */
export function isKnownPrefix(versions: readonly number[]): boolean {
  return versions.length <= MIGRATIONS.length && versions.every((v, i) => v === MIGRATIONS[i]?.version);
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * `nowWallMs` is injected so tests are reproducible.
 */
export function migrate(db: SqlDriver, nowWallMs: () => number): { applied: number[] } {
  const done = appliedVersions(db);
  if (!isKnownPrefix(done)) throw new Error(`unknown schema history: ${done.join(",")}`);
  const applied: number[] = [];
  for (const m of MIGRATIONS.slice(done.length)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at_wall_ms) VALUES (?, ?, ?)", [m.version, m.name, nowWallMs()]);
    });
    applied.push(m.version);
  }
  return { applied };
}
