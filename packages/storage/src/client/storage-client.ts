import { err, type CodedError, type Result } from "@agentsim/core";
import type { LiveBatch, LiveError } from "../live-subscriptions.ts";
import type { SqlError, SqlResult, SqlRunLimits, SqlSchema } from "../sql-console.ts";
import type { StoragePorts } from "../ports.ts";
import type { ReplayClient } from "../replay.ts";
import type { RunFileErrorCode } from "../run-bundle.ts";
import {
  STORAGE_PROTOCOL_VERSION,
  type LiveMessage,
  type StorageInfo,
  type StorageInit,
  type StorageOp,
  type StorageResponse,
  type StorageStatus,
} from "../worker/protocol.ts";
import type { PersistedHeadMessage, QuotaMessage, RecorderPortMessage } from "../worker/recorder-protocol.ts";
import type { ImportErrorCode } from "../worker/transfer.ts";

/** Errors surfaced by the client when the worker reports an infrastructure failure. */
export class StorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface StorageAdmin {
  info(): Promise<StorageInfo>;
  exportDb(): Promise<Uint8Array>;
  exportRun(runId: string): Promise<Result<Uint8Array, CodedError<"unknown_run">>>;
  importDb(bytes: Uint8Array): Promise<Result<void, CodedError<ImportErrorCode>>>;
  /** One run as a JSON-lines file: a versioned header line, then its records, snapshots, blobs and belief frames (ADR-0035 addition of 2026-10-17, item 11). */
  exportRunJsonl(runId: string): Promise<Result<Uint8Array, CodedError<"unknown_run" | "broken_recording">>>;
  /**
   * Adds the run of a file (JSON lines, or a per-run `.sqlite`) to the database as a new run, under a fresh run ID, keeping its original in `importedFrom`.
   * The files are validated like a database import is; nothing is replaced.
   */
  importRun(bytes: Uint8Array): Promise<Result<{ readonly runId: string; readonly importedFrom: string }, CodedError<ImportErrorCode | RunFileErrorCode>>>;
  /**
   * Gives the space deleted runs left behind back to the browser (VACUUM), unless a run is being recorded (it would hold the recorder's
   * writes for seconds): `skipped` says so. Also done when storage starts.
   */
  compact(): Promise<{ readonly freedBytes: number; readonly skipped: boolean }>;
  /** Requests persistent storage; must run on the main thread (StorageManager.persist is Window-only). */
  requestPersistence(): Promise<boolean>;
  /** Closes the database and releases the ownership lock. */
  close(): Promise<void>;
}

/**
 * Live subscriptions (ADR-0035 section 5): a filter of the log console's language and a view. The storage worker evaluates the filter on what it stores and pushes the
 * matches batched (at most 10 times a second, at most 2,000 items a batch; above that the display samples and the batch says how many matched). History is read
 * with `ports.trace.query({ filter })` or `ports.metrics.query({ filter })`; a subscription carries only what is stored after it is made.
 */
export interface LiveClient {
  /** Opens a subscription for a view on a run. `onBatch` is called for each pushed batch until `unsubscribe`. A bad filter is an error, and nothing is left open. */
  subscribe(viewId: string, runId: string, filter: string, onBatch: (b: LiveBatch) => void): Promise<Result<void, LiveError>>;
  /** Replaces the filter of an open view. */
  change(viewId: string, filter: string): Promise<Result<void, LiveError>>;
  /** Closes the view's subscription, in the worker and here: no batch is delivered after it. */
  unsubscribe(viewId: string): Promise<void>;
}

/**
 * The SQL console (UI-SPEC section 7): one read-only statement at a time, run in the storage worker beside the recorder's writes (sliced; see `sql-console.ts`). A statement that
 * writes, or is more than one, or reads `user_data`, comes back as an error and nothing changes.
 */
export interface SqlClient {
  /** Starts a statement: `result` settles with its rows or why it was refused or stopped; `cancel` stops it between slices. */
  run(sql: string, limits?: Partial<SqlRunLimits>): { readonly jobId: string; readonly result: Promise<Result<SqlResult, SqlError>>; cancel(): Promise<void> };
  /** The tables, their columns and the keys of the latest payloads, for completion. */
  schema(): Promise<SqlSchema>;
}

export interface StorageClient {
  readonly ports: StoragePorts;
  readonly live: LiveClient;
  readonly sql: SqlClient;
  /** Replay reads rebuilt in the storage worker: an agent's belief map at a tick, and the world a run was made in. */
  readonly replay: ReplayClient;
  readonly admin: StorageAdmin;
  /** Latest status; listeners are called on every change. */
  status(): StorageStatus;
  onStatus(listener: (s: StorageStatus) => void): () => void;
  /** Resolves when the database is open (after acquiring the ownership lock). */
  ready(): Promise<Extract<StorageStatus, { state: "ready" }>>;
  /** Test-only probe of the one-connection invariant. */
  probeSecondConnection(): Promise<string>;
  /**
   * Hands the storage worker its end of the recorder channel (the main thread created it with the sim worker's end: trace records never
   * travel through here). The port is transferred.
   */
  attachRecorderPort(port: MessagePort): void;
  /**
   * What the storage worker reports about recording: the persisted head after each flush (the status line, the timeline) and the quota state
   * (`paused` near the quota, `ok` once space is free again).
   */
  onRecording(listener: (m: PersistedHeadMessage | QuotaMessage) => void): () => void;
}

export interface StorageClientOptions {
  readonly quotaThresholdBytes: number;
  readonly dbFile?: string;
  readonly lockName?: string;
  readonly poolName?: string;
  readonly simulateNoOpfs?: boolean;
  readonly resetOnOpen?: boolean;
  /** Test-only: a quota of this many bytes against the database's own size (ADR-0035 §6). */
  readonly simulateQuotaBytes?: number;
  /** Test-only: a quota of what the database holds when it opens plus this many bytes. */
  readonly simulateQuotaHeadroomBytes?: number;
  /** Test-only: every commit of recorder batches takes this long first. */
  readonly simulateSlowWriterMs?: number;
}

export const DEFAULT_QUOTA_THRESHOLD_BYTES = 256 * 1024 * 1024;

/**
 * Main-thread client of the storage worker. Implements the storage ports by message passing;
 * nothing here blocks the render loop (ADR-0013).
 */
export function createStorageClient(worker: Worker, options: StorageClientOptions): StorageClient {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let current: StorageStatus = { type: "status", state: "loading" };
  const listeners = new Set<(s: StorageStatus) => void>();
  const recordingListeners = new Set<(m: PersistedHeadMessage | QuotaMessage) => void>();

  const liveViews = new Map<string, (b: LiveBatch) => void>();

  worker.addEventListener("message", (ev: MessageEvent<StorageResponse | StorageStatus | PersistedHeadMessage | QuotaMessage | LiveMessage>) => {
    const m = ev.data;
    if (m.type === "live") {
      liveViews.get(m.batch.viewId)?.(m.batch);
      return;
    }
    if (m.type === "quota" || m.type === "persisted") {
      for (const l of recordingListeners) l(m);
      return;
    }
    if (m.type === "status") {
      current = m;
      for (const l of listeners) l(m);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new StorageError(m.error.code, m.error.message));
  });
  worker.addEventListener("error", (ev) => {
    current = { type: "status", state: "failed", error: ev.message || "storage worker error" };
    for (const l of listeners) l(current);
  });

  function call<T>(op: StorageOp, args: unknown[] = [], transfer: Transferable[] = []): Promise<T> {
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type: "request", id, op, args }, transfer);
    });
  }

  const init: StorageInit = {
    type: "init",
    protocolVersion: STORAGE_PROTOCOL_VERSION,
    quotaThresholdBytes: options.quotaThresholdBytes,
    dbFile: options.dbFile ?? "/agentsim.sqlite3",
    lockName: options.lockName ?? "agentsim-db",
    poolName: options.poolName ?? "agentsim-pool",
    ...(options.simulateNoOpfs ? { simulateNoOpfs: true } : {}),
    ...(options.resetOnOpen ? { resetOnOpen: true } : {}),
    ...(options.simulateQuotaBytes === undefined ? {} : { simulateQuotaBytes: options.simulateQuotaBytes }),
    ...(options.simulateQuotaHeadroomBytes === undefined ? {} : { simulateQuotaHeadroomBytes: options.simulateQuotaHeadroomBytes }),
    ...(options.simulateSlowWriterMs === undefined ? {} : { simulateSlowWriterMs: options.simulateSlowWriterMs }),
  };
  worker.postMessage(init);

  const rpc = (group: string, names: readonly string[]) => Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => call(`${group}.${n}` as StorageOp, args)]));

  const ports: StoragePorts = {
    trace: {
      append: (records) => call("trace.append", [records]),
      flush: () => call("trace.flush"),
      query: (q) => call("trace.query", [q]),
      count: (runId) => call("trace.count", [runId]),
    },
    runs: {
      allocateRunId: () => call("runs.allocateRunId"),
      create: (h) => call("runs.create", [h]),
      get: (id) => call("runs.get", [id]),
      list: () => call("runs.list"),
      setStatus: (id, s) => call("runs.setStatus", [id, s]),
      markNotReproducible: (id, tick) => call("runs.markNotReproducible", [id, tick]),
      appendInputs: (id, inputs) => call("runs.appendInputs", [id, inputs]),
      inputs: (id) => call("runs.inputs", [id]),
      sizes: (id) => call("runs.sizes", [id]),
      delete: (id) => call("runs.delete", [id]),
    },
    cache: {
      get: (k) => call("cache.get", [k]),
      put: (k, v) => call("cache.put", [k, v]),
    },
    userData: {
      get: (ns, k) => call("userData.get", [ns, k]),
      set: (ns, k, v) => call("userData.set", [ns, k, v]),
      delete: (ns, k) => call("userData.delete", [ns, k]),
      keys: (ns) => call("userData.keys", [ns]),
    },
    scenarios: {
      list: () => call("scenarios.list"),
      get: (id, version) => call("scenarios.get", version === undefined ? [id] : [id, version]),
      saveVersion: (doc) => call("scenarios.saveVersion", [doc]),
      delete: (id) => call("scenarios.delete", [id]),
    },
    runConfigs: {
      list: () => call("runConfigs.list"),
      get: (id, version) => call("runConfigs.get", version === undefined ? [id] : [id, version]),
      saveVersion: (preset) => call("runConfigs.saveVersion", [preset]),
      delete: (id) => call("runConfigs.delete", [id]),
    },
    mindProfiles: rpc("mindProfiles", ["list", "get", "saveVersion", "delete"]) as unknown as StoragePorts["mindProfiles"],
    promptTemplates: rpc("promptTemplates", ["list", "get", "saveVersion", "delete"]) as unknown as StoragePorts["promptTemplates"],
    // The recording ports forward every call as it is (same arguments, in order): one table instead of a lambda each, to keep the initial chunk small.
    snapshots: rpc("snapshots", ["putBlobs", "getBlob", "write", "list", "read"]) as unknown as StoragePorts["snapshots"],
    beliefFrames: rpc("beliefFrames", ["append", "query", "keyframeAtOrBefore"]) as unknown as StoragePorts["beliefFrames"],
    metrics: rpc("metrics", ["append", "query"]) as unknown as StoragePorts["metrics"],
  };

  const live: LiveClient = {
    async subscribe(viewId, runId, filter, onBatch) {
      // A view has one subscription: a second is refused here, and must not disturb the first one's listener.
      if (liveViews.has(viewId)) return err({ code: "duplicate_view" as const, message: `view ${viewId} already has a subscription` });
      // Listening first: a batch cannot arrive before the listener is there.
      liveViews.set(viewId, onBatch);
      const r = await call<Result<void, LiveError>>("live.subscribe", [viewId, runId, filter]);
      if (!r.ok) liveViews.delete(viewId);
      return r;
    },
    change: (viewId, filter) => call("live.change", [viewId, filter]),
    async unsubscribe(viewId) {
      liveViews.delete(viewId);
      await call("live.unsubscribe", [viewId]);
    },
  };

  let sqlJobs = 0;
  const sql: SqlClient = {
    run(statement, limits) {
      const jobId = `q${++sqlJobs}`;
      return { jobId, result: call("sql.run", [jobId, statement, limits ?? null]), cancel: () => call<boolean>("sql.cancel", [jobId]).then(() => undefined) };
    },
    schema: () => call("sql.schema"),
  };

  const admin: StorageAdmin = {
    info: () => call("admin.info"),
    exportDb: () => call("admin.exportDb"),
    exportRun: (runId) => call("admin.exportRun", [runId]),
    exportRunJsonl: (runId) => call("admin.exportRunJsonl", [runId]),
    importRun: (bytes) => {
      const copy = bytes.slice();
      return call("admin.importRun", [copy], [copy.buffer]);
    },
    compact: () => call("admin.compact"),
    importDb: (bytes) => {
      // Copy so the caller keeps its buffer; the copy is transferred (no structured clone).
      const copy = bytes.slice();
      return call("admin.importDb", [copy], [copy.buffer]);
    },
    async requestPersistence() {
      try {
        // Window-only API; typed structurally so this module also compiles for worker realms.
        const sm = navigator.storage as { persist?: () => Promise<boolean> } | undefined;
        return (await sm?.persist?.()) ?? false;
      } catch {
        return false;
      }
    },
    close: () => call("admin.close"),
  };

  return {
    ports,
    live,
    sql,
    replay: rpc("replay", ["beliefAt", "world"]) as unknown as ReplayClient,
    admin,
    status: () => current,
    onStatus(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ready() {
      return new Promise((resolve, reject) => {
        const check = (s: StorageStatus) => {
          if (s.state === "ready") {
            off();
            resolve(s);
          } else if (s.state === "failed" || s.state === "closed") {
            off();
            reject(new StorageError(s.state === "failed" ? "open_failed" : "closed", s.state === "failed" ? s.error : "storage is closed"));
          }
        };
        const off = this.onStatus(check);
        check(current);
      });
    },
    probeSecondConnection: () => call("test.openSecondConnection"),
    attachRecorderPort(port) {
      const m: RecorderPortMessage = { type: "recorderPort", port };
      worker.postMessage(m, [port]);
    },
    onRecording(l) {
      recordingListeners.add(l);
      return () => recordingListeners.delete(l);
    },
  };
}
