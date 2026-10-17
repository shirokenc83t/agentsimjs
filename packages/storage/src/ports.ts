import type { CodedError, Result } from "@agentsim/core";
import type { RunHeader, RunStatus, SourcePattern, TraceRecord } from "@agentsim/trace";
import type { RunInputError, StoredRunInput } from "./run-inputs.ts";

export type { StoredRunInput, RunInputError } from "./run-inputs.ts";

/**
 * Storage ports (ADR-0001, ADR-0010). The only way any component reaches persisted data.
 * Domain failures are typed results; infrastructure failures reject with a `StorageError`.
 */

export interface TraceQuery {
  readonly runId: string;
  /** Exclusive lower bound on `seq` (for paging). */
  readonly afterSeq?: number;
  readonly limit: number;
  /**
   * Emitter filter (ADR-0031), from `parseSourceFilter`: records matching any `include` pattern and none
   * of the `exclude` patterns. Patterns are re-validated by the store and compiled to parameterized SQL.
   */
  readonly source?: { readonly include?: readonly SourcePattern[]; readonly exclude?: readonly SourcePattern[] };
  /** Inclusive sim-time window (seconds), mapped to a `seq` range (seq order = sim-time order in a run). */
  readonly simTime?: { readonly from?: number; readonly to?: number };
}

export interface TraceStore {
  /** Appends records; implementations batch writes in transactions. */
  /**
   * Rejects the whole batch if a record is invalid, its run unknown, its seq taken, or if it would break
   * the run invariant that seq order is sim-time order (`non_monotonic_time`, ADR-0031 amendment).
   */
  append(records: readonly TraceRecord[]): Promise<Result<void, CodedError<"invalid_record" | "unknown_run" | "duplicate_seq" | "non_monotonic_time">>>;
  /** Makes all previously appended records durable and visible. */
  flush(): Promise<void>;
  query(q: TraceQuery): Promise<TraceRecord[]>;
  count(runId: string): Promise<number>;
}

export interface RunSummary extends RunHeader {
  readonly recordCount: number;
}

export interface RunStore {
  /** Next unused run ID (`run-NNNNNN`), derived from stored runs; never reused. */
  allocateRunId(): Promise<string>;
  /** A header naming a scenario must name a stored, not deleted, version of it (ADR-0028). */
  create(header: RunHeader): Promise<Result<void, CodedError<"duplicate_run" | "invalid_header" | "scenario_version_not_found">>>;
  get(runId: string): Promise<RunHeader | undefined>;
  list(): Promise<RunSummary[]>;
  setStatus(runId: string, status: RunStatus): Promise<Result<void, CodedError<"unknown_run">>>;
  /**
   * Appends run inputs (researcher commands, ADR-0015 clarification): part of what the run ran, replayed to
   * reproduce it. Append-only; rejects the whole batch if one input is invalid, already stored, or out of order.
   */
  appendInputs(runId: string, inputs: readonly StoredRunInput[]): Promise<Result<void, RunInputError>>;
  /** The run's inputs in input-ID order (empty for an unknown run). */
  inputs(runId: string): Promise<StoredRunInput[]>;
}

export interface CachedResponse {
  readonly model: string;
  readonly value: unknown;
  readonly createdAtWallMs: number;
}

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | undefined>;
  put(key: string, entry: CachedResponse): Promise<void>;
}

export interface UserDataStore {
  get(namespace: string, key: string): Promise<unknown>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
}

/** One saved version of a versioned document (scenario, ADR-0025; run configuration preset, ADR-0028). */
export interface StoredDocument {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  /**
   * The document as saved. Storage checks only its envelope; callers validate it fully with
   * `@agentsim/scenarios` before use, since a database may have been imported from a file.
   */
  readonly document: unknown;
  /** xxHash32 (8 hex digits) of the stored JSON text; kept after deletion in the tombstone. */
  readonly contentHash: string;
  readonly createdAtWallMs: number;
}

export interface DocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly latestVersion: number;
  /** Versions not deleted. */
  readonly versionCount: number;
  readonly updatedAtWallMs: number;
}

export type StoredScenario = StoredDocument;
export type ScenarioSummary = DocumentSummary;
export type StoredRunConfig = StoredDocument;
export type RunConfigSummary = DocumentSummary;

export type ScenarioSaveError = CodedError<"invalid_document" | "too_large">;

export interface ScenarioStore {
  /** Latest version of every scenario, sorted by id. */
  list(): Promise<ScenarioSummary[]>;
  /** A given version, or the latest when `version` is omitted. */
  get(id: string, version?: number): Promise<StoredScenario | undefined>;
  /**
   * Saves the document as the next version of its `id`. Versions start at 1 and are never reused, not
   * even after deletion: an exported file or a copied database may still carry an old (id, version).
   */
  saveVersion(document: unknown): Promise<Result<{ readonly id: string; readonly version: number }, ScenarioSaveError>>;
  /**
   * Deletes every live version of a scenario. Each version leaves a tombstone (id, version, content hash,
   * deletion time) so its number is never handed out again. Fails with `scenario_in_use` if a stored run
   * references any of its versions.
   */
  delete(id: string): Promise<Result<void, CodedError<"unknown_scenario" | "scenario_in_use">>>;
}

/** Library of named run configuration presets (ADR-0028); same versioning rules as scenarios. */
export interface RunConfigStore {
  list(): Promise<RunConfigSummary[]>;
  get(id: string, version?: number): Promise<StoredRunConfig | undefined>;
  saveVersion(preset: { readonly id: string; readonly name: string; readonly document: unknown }): Promise<
    Result<{ readonly id: string; readonly version: number }, CodedError<"invalid_document" | "too_large">>
  >;
  delete(id: string): Promise<Result<void, CodedError<"unknown_run_config">>>;
}

export interface StoragePorts {
  readonly trace: TraceStore;
  readonly runs: RunStore;
  readonly cache: ResponseCache;
  readonly userData: UserDataStore;
  readonly scenarios: ScenarioStore;
  readonly runConfigs: RunConfigStore;
}
