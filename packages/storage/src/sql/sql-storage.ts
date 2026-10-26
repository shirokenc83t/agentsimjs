import { err, isValid, ok, type Result } from "@agentsim/core";
import { firstNonMonotonicRecord, formatRunId, isValidTraceRecord, RunHeader, type DerivedRun, type RunStatus, type TraceRecord } from "@agentsim/trace";
import type {
  CachedResponse,
  DocumentSummary,
  ResponseCache,
  RunConfigStore,
  RunConfigSummary,
  RunSizes,
  RunStore,
  RunSummary,
  SizeEntry,
  ScenarioStore,
  ScenarioSummary,
  StoragePorts,
  StoredDocument,
  StoredRunConfig,
  StoredScenario,
  TraceQuery,
  TraceStore,
  UserDataStore,
} from "../ports.ts";
import { checkRunConfigPreset, checkScenarioEnvelope } from "../scenario-envelope.ts";
import { checkRunInputs, RUN_INPUT_LIMITS, type RunInputError, type StoredRunInput } from "../run-inputs.ts";
import { checkRunRecording } from "../recording.ts";
import { checkRunDerived, checkRunReferences } from "../run-references.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";
import { SqlBeliefFrameStore, SqlMetricStore, SqlSnapshotStore } from "./recording-stores.ts";
import { parseQueryFilter } from "./filter-sql.ts";
import { checkRecordFilter, compileSourceFilter } from "./source-filter.ts";
import { buildTraceQuery, timeWindowToSeqRange, type SeqRange } from "./trace-query.ts";

type TraceRow = {
  run_id: string; seq: number; id: string; parent_id: string | null; sim_time: number; wall_time: number;
  agent_id: string | null; group_id: string | null; kind: string; tier: string | null; detail: string | null;
  payload: string; belief_ref: string | null; world_ref: string | null; cause_ids: string | null;
  source_owner: string; source_component: string;
};
type RunRow = {
  run_id: string; schema_version: number; created_at_wall_ms: number; label: string;
  scenario: string | null; seed: number | null; status: string; record_count?: number;
  scenario_id: string | null; scenario_version: number | null; run_config: string | null;
  run_config_hash: string | null; effective_config_hash: string | null; simulator_version: string | null;
  ideal_agents: string | null; recording: string | null; recording_profile: string | null; recording_profile_hash: string | null; imported_from: string | null; derived: string | null;
};

const opt = <K extends string, V>(key: K, v: V | null | undefined): { [P in K]?: V } =>
  (v === null || v === undefined ? {} : { [key]: v }) as { [P in K]?: V };

function rowToRecord(r: TraceRow): TraceRecord {
  const rec = {
    id: r.id, runId: r.run_id, seq: r.seq, simTime: r.sim_time, wallTime: r.wall_time,
    source: `${r.source_owner}/${r.source_component}`, kind: r.kind, payload: JSON.parse(r.payload) as unknown,
    ...opt("parentId", r.parent_id), ...opt("agentId", r.agent_id), ...opt("groupId", r.group_id),
    ...opt("tier", r.tier), ...opt("detail", r.detail), ...opt("beliefRef", r.belief_ref), ...opt("worldRef", r.world_ref),
    ...opt("causeIds", r.cause_ids === null ? null : (JSON.parse(r.cause_ids) as string[])),
  };
  return rec as TraceRecord;
}

function rowToRun(r: RunRow): RunHeader {
  return {
    runId: r.run_id, schemaVersion: r.schema_version, createdAtWallMs: r.created_at_wall_ms, label: r.label,
    status: r.status as RunStatus, ...opt("scenario", r.scenario), ...opt("seed", r.seed),
    ...opt("scenarioId", r.scenario_id), ...opt("scenarioVersion", r.scenario_version),
    ...opt("runConfig", r.run_config === null ? null : (JSON.parse(r.run_config) as unknown)),
    ...opt("runConfigHash", r.run_config_hash), ...opt("effectiveConfigHash", r.effective_config_hash),
    ...opt("simulatorVersion", r.simulator_version),
    ...opt("idealAgents", r.ideal_agents === null ? null : (JSON.parse(r.ideal_agents) as string[])),
    ...opt("recording", r.recording as "stored" | "none" | null),
    ...opt("recordingProfile", r.recording_profile === null ? null : (JSON.parse(r.recording_profile) as unknown)),
    ...opt("recordingProfileHash", r.recording_profile_hash),
    ...opt("importedFrom", r.imported_from),
    ...opt("derived", r.derived === null ? null : (JSON.parse(r.derived) as DerivedRun)),
  };
}

class SqlTraceStore implements TraceStore {
  constructor(private readonly db: SqlDriver) {}

  async append(records: readonly TraceRecord[]) {
    for (const r of records) {
      if (!isValidTraceRecord(r)) return err({ code: "invalid_record" as const, message: `invalid trace record ${String((r as { id?: unknown }).id)}` });
    }
    // One existence check per distinct run (not per record); duplicates are caught by PK/UNIQUE constraints.
    for (const runId of new Set(records.map((r) => r.runId))) {
      if (!this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId])) {
        return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
      }
      if (!this.keepsTimeOrder(runId, records.filter((r) => r.runId === runId))) {
        return err({ code: "non_monotonic_time" as const, message: `records of ${runId} would break seq/sim-time order` });
      }
    }
    try {
      this.db.transaction(() => {
        for (const r of records) {
          const slash = r.source.indexOf("/"); // validated: exactly one
          const p: SqlValue[] = [
            r.runId, r.seq, r.id, r.parentId ?? null, r.simTime, r.wallTime, r.agentId ?? null, r.groupId ?? null,
            r.kind, r.tier ?? null, r.detail ?? null, JSON.stringify(r.payload ?? null), r.beliefRef ?? null, r.worldRef ?? null,
            r.source.slice(0, slash), r.source.slice(slash + 1),
          ];
          this.db.run(
            `INSERT INTO trace_records (run_id, seq, id, parent_id, sim_time, wall_time, agent_id, group_id, kind, tier, detail, payload, belief_ref, world_ref,
                                        source_owner, source_component)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            p,
          );
          for (const c of r.causeIds ?? []) {
            this.db.run("INSERT OR IGNORE INTO trace_causes (run_id, record_id, cause_id) VALUES (?, ?, ?)", [r.runId, r.id, c]);
          }
        }
      });
    } catch (e) {
      // The whole batch was rolled back (transaction or savepoint).
      if (isUniqueViolation(e)) return err({ code: "duplicate_seq" as const, message: "duplicate record (run_id, seq) or (run_id, id)" });
      throw e;
    }
    return ok(undefined);
  }

  /**
   * Run invariant (ADR-0031 amendment): seq order is sim-time order. The usual append (every new seq above
   * the stored ones) costs one primary-key lookup; batches that land between stored seqs check both
   * neighbours of each record.
   */
  private keepsTimeOrder(runId: string, batch: readonly TraceRecord[]): boolean {
    const sorted = [...batch].sort((a, b) => a.seq - b.seq);
    if (firstNonMonotonicRecord(sorted)) return false;
    const first = sorted[0];
    if (!first) return true;
    const last = this.db.get<{ seq: number; sim_time: number }>("SELECT seq, sim_time FROM trace_records WHERE run_id = ? ORDER BY seq DESC LIMIT 1", [runId]);
    if (!last) return true;
    if (first.seq > last.seq) return first.simTime >= last.sim_time;
    for (const r of sorted) {
      const prev = this.db.get<{ t: number }>("SELECT sim_time AS t FROM trace_records WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1", [runId, r.seq]);
      const next = this.db.get<{ t: number }>("SELECT sim_time AS t FROM trace_records WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 1", [runId, r.seq]);
      if ((prev && r.simTime < prev.t) || (next && r.simTime > next.t)) return false;
    }
    return true;
  }

  async flush() {
    // Writes are synchronous transactions at this level; batching happens in the storage worker queue.
  }

  async query(q: TraceQuery) {
    let range: SeqRange | undefined;
    if (q.simTime) {
      const r = timeWindowToSeqRange(this.db, q.runId, q.simTime);
      if (!r) {
        compileSourceFilter(q.source); // still reject a malformed filter
        checkRecordFilter(q);
        if (q.filter !== undefined) parseQueryFilter(q.filter, "records");
        return [];
      }
      range = r;
    }
    const built = buildTraceQuery(q, range);
    const rows = this.db.all<TraceRow>(built.sql, built.params);
    return rows.map((r) => {
      const all = (r as TraceRow & { cause_ids_all: string }).cause_ids_all;
      return rowToRecord({ ...r, cause_ids: all === "[]" ? null : all });
    });
  }

  async count(runId: string) {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM trace_records WHERE run_id = ?", [runId])?.n ?? 0;
  }
}

/** Both node:sqlite and sqlite-wasm report constraint failures with this text. */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY constraint failed|SQLITE_CONSTRAINT/i.test(e.message);
}

class SqlRunStore implements RunStore {
  constructor(private readonly db: SqlDriver) {}

  async allocateRunId() {
    // Run IDs are `run-NNNNNN`; the next one follows the highest stored or deleted (never reused).
    const row = this.db.get<{ n: number | null }>(
      `SELECT max(n) AS n FROM (SELECT max(CAST(substr(run_id, 5) AS INTEGER)) AS n FROM runs
                                UNION ALL SELECT max(CAST(substr(run_id, 5) AS INTEGER)) FROM deleted_runs)`,
    );
    return formatRunId((row?.n ?? 0) + 1);
  }

  async create(header: RunHeader) {
    if (!isValid(RunHeader, header)) return err({ code: "invalid_header" as const, message: "invalid run header" });
    const refs = checkRunReferences(header);
    if (!refs.ok) return refs;
    const derived = checkRunDerived(header);
    if (!derived.ok) return derived;
    if (header.derived !== undefined && header.importedFrom === undefined && !this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [header.derived.parentRunId])) {
      return err({ code: "parent_run_not_found" as const, message: `parent run ${header.derived.parentRunId} not found` });
    }
    const recording = checkRunRecording(header);
    if (!recording.ok) return recording;
    if (this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [header.runId])) {
      return err({ code: "duplicate_run" as const, message: `run ${header.runId} exists` });
    }
    if (
      header.scenarioId !== undefined &&
      !this.db.get("SELECT 1 AS x FROM scenarios WHERE id = ? AND version = ? AND deleted_at_wall_ms IS NULL", [header.scenarioId, header.scenarioVersion ?? 0])
    ) {
      return err({ code: "scenario_version_not_found" as const, message: `scenario ${header.scenarioId} v${header.scenarioVersion ?? "?"} not found` });
    }
    this.db.run(
      `INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, scenario, seed, status,
                         scenario_id, scenario_version, run_config, run_config_hash, effective_config_hash, simulator_version, ideal_agents,
                         recording, recording_profile, recording_profile_hash, imported_from, derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        header.runId, header.schemaVersion, header.createdAtWallMs, header.label, header.scenario ?? null, header.seed ?? null, header.status,
        header.scenarioId ?? null, header.scenarioVersion ?? null, header.runConfig === undefined ? null : JSON.stringify(header.runConfig),
        header.runConfigHash ?? null, header.effectiveConfigHash ?? null, header.simulatorVersion ?? null,
        header.idealAgents === undefined ? null : JSON.stringify(header.idealAgents),
        header.recording ?? null, header.recordingProfile === undefined ? null : JSON.stringify(header.recordingProfile), header.recordingProfileHash ?? null,
        header.importedFrom ?? null, header.derived === undefined ? null : JSON.stringify(header.derived),
      ],
    );
    return ok(undefined);
  }

  async get(runId: string) {
    const r = this.db.get<RunRow>("SELECT * FROM runs WHERE run_id = ?", [runId]);
    return r ? rowToRun(r) : undefined;
  }

  async list(): Promise<RunSummary[]> {
    const rows = this.db.all<RunRow>(
      `SELECT r.*, (SELECT count(*) FROM trace_records t WHERE t.run_id = r.run_id) AS record_count
       FROM runs r ORDER BY r.run_id`,
    );
    return rows.map((r) => ({ ...rowToRun(r), recordCount: r.record_count ?? 0 }));
  }

  async setStatus(runId: string, status: RunStatus) {
    const { changes } = this.db.run("UPDATE runs SET status = ? WHERE run_id = ?", [status, runId]);
    return changes === 0 ? err({ code: "unknown_run" as const, message: `unknown run ${runId}` }) : ok(undefined);
  }

  async appendInputs(runId: string, inputs: readonly StoredRunInput[]): Promise<Result<void, RunInputError>> {
    if (!this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId])) return err({ code: "unknown_run", message: `unknown run ${runId}` });
    const last = this.db.get<{ input_id: string; tick: number }>("SELECT input_id, tick FROM run_inputs WHERE run_id = ? ORDER BY input_id DESC LIMIT 1", [runId]);
    const count = this.db.get<{ n: number }>("SELECT count(*) AS n FROM run_inputs WHERE run_id = ?", [runId])?.n ?? 0;
    const existing = last ? [{ inputId: last.input_id, tick: last.tick }] : [];
    // Only the last stored input matters for ordering; the count bounds the run's total.
    const checked = checkRunInputs(existing, inputs);
    if (!checked.ok) return checked;
    if (count + checked.value.length > RUN_INPUT_LIMITS.maxPerRun) return err({ code: "too_many_inputs", message: `a run holds at most ${RUN_INPUT_LIMITS.maxPerRun} inputs` });
    this.db.transaction(() => {
      for (const i of checked.value) {
        this.db.run("INSERT INTO run_inputs (run_id, input_id, tick, agent_id, name, params) VALUES (?, ?, ?, ?, ?, ?)", [
          runId, i.inputId, i.tick, i.agentId, i.name, JSON.stringify(i.params ?? null),
        ]);
      }
    });
    return ok(undefined);
  }

  async sizes(runId: string): Promise<RunSizes | undefined> {
    if (!this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId])) return undefined;
    const one = (sql: string): SizeEntry => {
      const r = this.db.get<{ n: number; b: number | null }>(sql, [runId]);
      return { count: r?.n ?? 0, bytes: r?.b ?? 0 };
    };
    return {
      records: one("SELECT count(*) AS n, sum(length(payload)) AS b FROM trace_records WHERE run_id = ?"),
      blobs: one("SELECT count(*) AS n, sum(length(data)) AS b FROM blobs WHERE run_id = ?"),
      snapshots: one("SELECT count(*) AS n, sum(length(data)) AS b FROM snapshots WHERE run_id = ?"),
      beliefFrames: one("SELECT count(*) AS n, sum(length(data)) AS b FROM belief_frames WHERE run_id = ?"),
      // A row has no heavy column: its bytes are the fixed width of a sample.
      metrics: one("SELECT count(*) AS n, count(*) * 40 AS b FROM metrics WHERE run_id = ?"),
    };
  }

  async delete(runId: string) {
    if (!this.db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId])) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
    this.db.transaction(() => {
      // Frames name blobs, so they go first; the run's row goes last, and its ID stays behind so it is never handed out again.
      for (const table of ["metrics", "belief_frames", "blobs", "snapshots", "trace_causes", "trace_records", "run_inputs"]) this.db.run(`DELETE FROM ${table} WHERE run_id = ?`, [runId]);
      this.db.run("DELETE FROM runs WHERE run_id = ?", [runId]);
      this.db.run("INSERT OR IGNORE INTO deleted_runs (run_id, deleted_at_wall_ms) VALUES (?, ?)", [runId, Date.now()]);
    });
    return ok(undefined);
  }

  async inputs(runId: string): Promise<StoredRunInput[]> {
    const rows = this.db.all<{ input_id: string; tick: number; agent_id: string; name: string; params: string }>(
      "SELECT input_id, tick, agent_id, name, params FROM run_inputs WHERE run_id = ? ORDER BY input_id",
      [runId],
    );
    return rows.map((r) => ({ inputId: r.input_id, tick: r.tick, agentId: r.agent_id, name: r.name, params: JSON.parse(r.params) as unknown }));
  }
}

class SqlResponseCache implements ResponseCache {
  constructor(private readonly db: SqlDriver) {}

  async get(key: string): Promise<CachedResponse | undefined> {
    const r = this.db.get<{ model: string; value: string; created_at_wall_ms: number }>(
      "SELECT model, value, created_at_wall_ms FROM response_cache WHERE key = ?", [key],
    );
    return r ? { model: r.model, value: JSON.parse(r.value) as unknown, createdAtWallMs: r.created_at_wall_ms } : undefined;
  }

  async put(key: string, entry: CachedResponse) {
    this.db.run(
      "INSERT OR REPLACE INTO response_cache (key, model, value, created_at_wall_ms) VALUES (?, ?, ?, ?)",
      [key, entry.model, JSON.stringify(entry.value ?? null), entry.createdAtWallMs],
    );
  }
}

class SqlUserDataStore implements UserDataStore {
  constructor(private readonly db: SqlDriver, private readonly nowWallMs: () => number) {}

  async get(namespace: string, key: string) {
    const r = this.db.get<{ value: string }>("SELECT value FROM user_data WHERE namespace = ? AND key = ?", [namespace, key]);
    return r ? (JSON.parse(r.value) as unknown) : undefined;
  }

  async set(namespace: string, key: string, value: unknown) {
    this.db.run(
      "INSERT OR REPLACE INTO user_data (namespace, key, value, updated_at_wall_ms) VALUES (?, ?, ?, ?)",
      [namespace, key, JSON.stringify(value ?? null), this.nowWallMs()],
    );
  }

  async delete(namespace: string, key: string) {
    this.db.run("DELETE FROM user_data WHERE namespace = ? AND key = ?", [namespace, key]);
  }

  async keys(namespace: string) {
    return this.db.all<{ key: string }>("SELECT key FROM user_data WHERE namespace = ? ORDER BY key", [namespace]).map((r) => r.key);
  }
}

type DocumentRow = { id: string; version: number; name: string; document: string; content_hash: string; created_at_wall_ms: number };

/**
 * Versioned documents with tombstones (scenarios, run configuration presets): live versions only are
 * visible; deleted versions keep their row (number and content hash) so numbers are never reused.
 * `table` is one of two constants, never user input.
 */
class SqlVersionedDocs {
  constructor(
    private readonly db: SqlDriver,
    private readonly table: "scenarios" | "run_configs",
    private readonly nowWallMs: () => number,
  ) {}

  list(): DocumentSummary[] {
    const t = this.table;
    return this.db
      .all<{ id: string; name: string; version: number; n: number; created_at_wall_ms: number }>(
        `SELECT s.id, s.name, s.version, s.created_at_wall_ms,
                (SELECT count(*) FROM ${t} c WHERE c.id = s.id AND c.deleted_at_wall_ms IS NULL) AS n
         FROM ${t} s
         WHERE s.deleted_at_wall_ms IS NULL
           AND s.version = (SELECT max(version) FROM ${t} m WHERE m.id = s.id AND m.deleted_at_wall_ms IS NULL)
         ORDER BY s.id`,
      )
      .map((r) => ({ id: r.id, name: r.name, latestVersion: r.version, versionCount: r.n, updatedAtWallMs: r.created_at_wall_ms }));
  }

  get(id: string, version?: number): StoredDocument | undefined {
    const t = this.table;
    const r =
      version === undefined
        ? this.db.get<DocumentRow>(`SELECT * FROM ${t} WHERE id = ? AND deleted_at_wall_ms IS NULL ORDER BY version DESC LIMIT 1`, [id])
        : this.db.get<DocumentRow>(`SELECT * FROM ${t} WHERE id = ? AND version = ? AND deleted_at_wall_ms IS NULL`, [id, version]);
    return r
      ? { id: r.id, version: r.version, name: r.name, document: JSON.parse(r.document) as unknown, contentHash: r.content_hash, createdAtWallMs: r.created_at_wall_ms }
      : undefined;
  }

  /** Inserts the next version: the highest ever used (tombstones included) + 1. */
  insert(id: string, name: string, json: string, contentHash: string): number {
    const t = this.table;
    const now = this.nowWallMs();
    let version = 0;
    this.db.transaction(() => {
      version = (this.db.get<{ v: number | null }>(`SELECT max(version) AS v FROM ${t} WHERE id = ?`, [id])?.v ?? 0) + 1;
      this.db.run(
        `INSERT INTO ${t} (id, version, name, document, content_hash, created_at_wall_ms, updated_at_wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, version, name, json, contentHash, now, now],
      );
    });
    return version;
  }

  /** Tombstones every live version; returns how many there were. */
  tombstone(id: string): number {
    return this.db.run(`UPDATE ${this.table} SET document = NULL, deleted_at_wall_ms = ? WHERE id = ? AND deleted_at_wall_ms IS NULL`, [this.nowWallMs(), id]).changes;
  }
}

class SqlScenarioStore implements ScenarioStore {
  private readonly docs: SqlVersionedDocs;

  constructor(private readonly db: SqlDriver, nowWallMs: () => number) {
    this.docs = new SqlVersionedDocs(db, "scenarios", nowWallMs);
  }

  async list(): Promise<ScenarioSummary[]> {
    return this.docs.list();
  }

  async get(id: string, version?: number): Promise<StoredScenario | undefined> {
    return this.docs.get(id, version);
  }

  async saveVersion(document: unknown) {
    const env = checkScenarioEnvelope(document);
    if (!env.ok) return env;
    const { id, name, json, contentHash } = env.value;
    return ok({ id, version: this.docs.insert(id, name, json, contentHash) });
  }

  async delete(id: string) {
    if (this.db.get("SELECT 1 AS x FROM runs WHERE scenario_id = ? LIMIT 1", [id])) {
      return err({ code: "scenario_in_use" as const, message: `scenario ${id} is referenced by stored runs` });
    }
    return this.docs.tombstone(id) === 0 ? err({ code: "unknown_scenario" as const, message: `unknown scenario ${id}` }) : ok(undefined);
  }
}

class SqlRunConfigStore implements RunConfigStore {
  private readonly docs: SqlVersionedDocs;

  constructor(db: SqlDriver, nowWallMs: () => number) {
    this.docs = new SqlVersionedDocs(db, "run_configs", nowWallMs);
  }

  async list(): Promise<RunConfigSummary[]> {
    return this.docs.list();
  }

  async get(id: string, version?: number): Promise<StoredRunConfig | undefined> {
    return this.docs.get(id, version);
  }

  async saveVersion(preset: unknown) {
    const env = checkRunConfigPreset(preset);
    if (!env.ok) return env;
    const { id, name, json, contentHash } = env.value;
    return ok({ id, version: this.docs.insert(id, name, json, contentHash) });
  }

  async delete(id: string) {
    return this.docs.tombstone(id) === 0 ? err({ code: "unknown_run_config" as const, message: `unknown run configuration ${id}` }) : ok(undefined);
  }
}

/** Builds the storage ports over a migrated SQL connection. */
export function createSqlPorts(db: SqlDriver, nowWallMs: () => number): StoragePorts {
  return {
    trace: new SqlTraceStore(db),
    runs: new SqlRunStore(db),
    cache: new SqlResponseCache(db),
    userData: new SqlUserDataStore(db, nowWallMs),
    scenarios: new SqlScenarioStore(db, nowWallMs),
    runConfigs: new SqlRunConfigStore(db, nowWallMs),
    snapshots: new SqlSnapshotStore(db),
    beliefFrames: new SqlBeliefFrameStore(db),
    metrics: new SqlMetricStore(db),
  };
}
