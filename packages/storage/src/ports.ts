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
  /** Records about this agent (`agent_id`; the subject, not the emitter). */
  readonly agentId?: string;
  /** Records of any of these kinds (1 to 32; an empty list matches nothing). */
  readonly kinds?: readonly string[];
  /** Records whose payload `op` is this one (a post-filter on top of the others: pose samples are `observation` + `pose`). */
  readonly op?: string;
  /**
   * A filter of the log console's language (UI-SPEC section 5.2), as typed: the store parses it (a bad one is a bad request), compiles it to parameterized SQL, and
   * ANDs it with the other fields. A filter with a `metric:` term selects samples, not records: it goes to the metrics query.
   */
  readonly filter?: string;
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
  /**
   * A header naming a scenario must name a stored, not deleted, version of it (ADR-0028). A derived run names a parent that is stored (it may be deleted later: the
   * link then stays as what the run says it was made from); a derived run that was imported names a run of the database it came from, which is not here.
   */
  create(header: RunHeader): Promise<Result<void, CodedError<"duplicate_run" | "invalid_header" | "scenario_version_not_found" | "parent_run_not_found">>>;
  get(runId: string): Promise<RunHeader | undefined>;
  list(): Promise<RunSummary[]>;
  setStatus(runId: string, status: RunStatus): Promise<Result<void, CodedError<"unknown_run">>>;
  /** Sets the header's `notReproducibleFromTick` (a replay-then-live run made a call the cache did not hold, from this tick) unless it is already set: the first miss stays. */
  markNotReproducible(runId: string, fromTick: number): Promise<Result<void, CodedError<"unknown_run">>>;
  /**
   * Appends run inputs (researcher commands, ADR-0015 clarification): part of what the run ran, replayed to
   * reproduce it. Append-only; rejects the whole batch if one input is invalid, already stored, or out of order.
   */
  appendInputs(runId: string, inputs: readonly StoredRunInput[]): Promise<Result<void, RunInputError>>;
  /** The run's inputs in input-ID order (empty for an unknown run). */
  inputs(runId: string): Promise<StoredRunInput[]>;
  /** What the run holds, for the Storage browser; undefined for an unknown run. */
  sizes(runId: string): Promise<RunSizes | undefined>;
  /**
   * Deletes the run and everything it owns: its header, trace records and causes, run inputs, snapshots, blobs and belief frames (the way
   * to free space, ADR-0035 addition of 2026-10-17, item 7). Its ID is never handed out again. Whether the run is the one being recorded is
   * the caller's to check (the storage worker refuses it).
   */
  delete(runId: string): Promise<Result<void, CodedError<"unknown_run">>>;
}

/** Count and stored bytes of one kind of data of a run (the heavy column: payload text, blob or frame bytes, snapshot container). */
export interface SizeEntry {
  readonly count: number;
  readonly bytes: number;
}

export interface RunSizes {
  readonly records: SizeEntry;
  /** Metric samples (the count; the bytes are the fixed width of a row). */
  readonly metrics: SizeEntry;
  readonly blobs: SizeEntry;
  readonly snapshots: SizeEntry;
  readonly beliefFrames: SizeEntry;
}

/** How a model call ended (schema v14): an answer, an answer that failed validation, no answer in time, or a server or network error. */
export type CacheOutcome = "ok" | "invalid" | "timeout" | "error";

export interface CachedResponse {
  readonly model: string;
  readonly value: unknown;
  readonly createdAtWallMs: number;
  /** Schema v14: what the call was and how it went. Absent on an entry written before v14. */
  readonly providerKind?: string;
  readonly toolsHash?: string;
  readonly outcome?: CacheOutcome;
  readonly usage?: unknown;
  readonly latencyMs?: number;
  /** Schema v16: the run the entry was recorded in (a replay reads its own run's entries first). Absent on an entry written before v16. */
  readonly runId?: string;
}

export interface ResponseCache {
  /** The entry for the key: the one of `preferRunId` when it has one, else the latest of any run. */
  get(key: string, preferRunId?: string): Promise<CachedResponse | undefined>;
  /** Stored under the key and the run in the entry (`runId`, empty when absent): an entry of another run for the same key is kept. */
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

/** The library of mind profiles or of prompt templates (ADR-0036, schema v14): the same versioning rules as scenarios; callers validate the document with `@agentsim/minds`. */
export interface LibraryStore {
  list(): Promise<DocumentSummary[]>;
  get(id: string, version?: number): Promise<StoredDocument | undefined>;
  saveVersion(doc: { readonly id: string; readonly name: string; readonly document: unknown }): Promise<Result<{ readonly id: string; readonly version: number }, CodedError<"invalid_document" | "too_large">>>;
  delete(id: string): Promise<Result<void, CodedError<"unknown_document">>>;
}

/** A blob of a run: a snapshot section or a belief keyframe, named by the 128-bit content hash of its bytes (ADR-0004 addition of 2026-10-18). */
export interface StoredBlob {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** A snapshot to store: its container (large sections outside it) and the blobs those sections are, when not stored yet. */
export interface SnapshotWrite {
  /** Seq of the run's `snapshot` trace record. */
  readonly seq: number;
  readonly simTime: number;
  readonly tick: number;
  /** The container (`ASNP`); its sections may be inline or refer to blobs of the run. */
  readonly bytes: Uint8Array;
  /** Blobs to store with it (those already stored may be left out). Every section outside the container must be stored. */
  readonly blobs?: readonly StoredBlob[];
}

export interface SnapshotInfo {
  /** The snapshot's content hash (`snapshotHash`): the same whether sections are inline or stored as blobs. */
  readonly id: string;
  readonly seq: number;
  readonly simTime: number;
  readonly tick: number;
  readonly bytes: number;
}

export interface LoadedSnapshot extends SnapshotInfo {
  readonly container: Uint8Array;
  /** The blobs the container refers to. */
  readonly blobs: readonly StoredBlob[];
}

export type BlobWriteError = CodedError<"unknown_run" | "invalid_blob">;
export type SnapshotWriteError = CodedError<"unknown_run" | "invalid_snapshot" | "invalid_blob" | "missing_blob" | "duplicate_snapshot">;

/** Snapshots and the blobs they and the belief keyframes share (ADR-0035 addition of 2026-10-17, items 8 and 9). */
export interface SnapshotStore {
  /** Stores blobs once per run (a blob already stored is left as it is); each must match its id. All or nothing. */
  putBlobs(runId: string, blobs: readonly StoredBlob[]): Promise<Result<void, BlobWriteError>>;
  /** A blob by id, verified against its id; undefined if the run has none. */
  getBlob(runId: string, id: string): Promise<StoredBlob | undefined>;
  /** Stores a snapshot with its blobs in one step; the container must open and every section outside it must be stored. */
  write(runId: string, snapshot: SnapshotWrite): Promise<Result<{ readonly id: string }, SnapshotWriteError>>;
  /** The run's snapshots in tick order (without their bytes). */
  list(runId: string): Promise<SnapshotInfo[]>;
  /** A snapshot with the blobs it refers to, or undefined. */
  read(runId: string, id: string): Promise<LoadedSnapshot | undefined>;
}

/** One belief-map frame of an agent: a keyframe (every materialized chunk, as a blob) or a delta (the chunks changed at a sync point). */
export interface BeliefFrame {
  readonly agentId: string;
  /** The agent's frame counter, from 0. Seq order is tick order. */
  readonly seq: number;
  readonly tick: number;
  readonly simTime: number;
  readonly kind: "keyframe" | "delta";
  /** The chunk indices the frame covers, ascending. */
  readonly chunks: readonly number[];
  /** Exactly one of these: the blob that holds the frame's bytes, or the bytes themselves. */
  readonly blobId?: string;
  readonly data?: Uint8Array;
}

export interface BeliefFrameQuery {
  readonly runId: string;
  readonly agentId?: string;
  /** Inclusive tick window. */
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly kind?: "keyframe" | "delta";
  readonly limit: number;
}

export type BeliefFrameError = CodedError<"unknown_run" | "invalid_frame" | "duplicate_frame" | "non_monotonic_frame" | "missing_blob">;

export interface BeliefFrameStore {
  /** Appends frames; all or nothing. A frame that names a blob needs that blob stored. */
  append(runId: string, frames: readonly BeliefFrame[]): Promise<Result<void, BeliefFrameError>>;
  /** Frames in (agent, seq) order, filtered by agent, tick window and kind. */
  query(q: BeliefFrameQuery): Promise<BeliefFrame[]>;
  /** The latest keyframe of the agent at or before `tick`: where a rebuild at that tick starts. */
  keyframeAtOrBefore(runId: string, agentId: string, tick: number): Promise<BeliefFrame | undefined>;
}

/** One point of a metric series (ADR-0035 section 4): `name` is in the trusted registry and `source` is the one the registry gives that series. */
export interface StoredMetricSample {
  readonly source: string;
  readonly name: string;
  /** The tick the sample was taken after. Unique per series, and the series' order. */
  readonly tick: number;
  readonly simTime: number;
  readonly value: number;
}

export interface MetricQuery {
  readonly runId: string;
  /** Exactly this source (a `source:` filter with `*` is the filter language's). */
  readonly source?: string;
  readonly name?: string;
  /** Inclusive sim-time window. */
  readonly fromS?: number;
  readonly toS?: number;
  /** Continues after this sample, in (source, name, tick) order: the cursor of a paged read. */
  readonly after?: { readonly source: string; readonly name: string; readonly tick: number };
  /** A filter with a `metric:` term (the log console's language), ANDed with the other fields. */
  readonly filter?: string;
  readonly limit: number;
}

export type MetricError = CodedError<"unknown_run" | "invalid_metric" | "duplicate_metric" | "non_monotonic_metric">;

export interface MetricStore {
  /** Appends samples; all or nothing. Each series (source, name) keeps tick order, and a tick holds one sample of it. */
  append(runId: string, samples: readonly StoredMetricSample[]): Promise<Result<void, MetricError>>;
  /** Samples in (source, name, tick) order, filtered. */
  query(q: MetricQuery): Promise<StoredMetricSample[]>;
}

export interface StoragePorts {
  readonly trace: TraceStore;
  readonly runs: RunStore;
  readonly cache: ResponseCache;
  readonly userData: UserDataStore;
  readonly scenarios: ScenarioStore;
  readonly runConfigs: RunConfigStore;
  readonly mindProfiles: LibraryStore;
  readonly promptTemplates: LibraryStore;
  readonly snapshots: SnapshotStore;
  readonly beliefFrames: BeliefFrameStore;
  readonly metrics: MetricStore;
}
