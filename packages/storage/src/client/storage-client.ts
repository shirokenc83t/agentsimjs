import type { CodedError, Result } from "@agentsim/core";
import type { StoragePorts } from "../ports.ts";
import {
  STORAGE_PROTOCOL_VERSION,
  type StorageInfo,
  type StorageInit,
  type StorageOp,
  type StorageResponse,
  type StorageStatus,
} from "../worker/protocol.ts";
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
  /** Requests persistent storage; must run on the main thread (StorageManager.persist is Window-only). */
  requestPersistence(): Promise<boolean>;
  /** Closes the database and releases the ownership lock. */
  close(): Promise<void>;
}

export interface StorageClient {
  readonly ports: StoragePorts;
  readonly admin: StorageAdmin;
  /** Latest status; listeners are called on every change. */
  status(): StorageStatus;
  onStatus(listener: (s: StorageStatus) => void): () => void;
  /** Resolves when the database is open (after acquiring the ownership lock). */
  ready(): Promise<Extract<StorageStatus, { state: "ready" }>>;
  /** Test-only probe of the one-connection invariant. */
  probeSecondConnection(): Promise<string>;
}

export interface StorageClientOptions {
  readonly quotaThresholdBytes: number;
  readonly dbFile?: string;
  readonly lockName?: string;
  readonly poolName?: string;
  readonly simulateNoOpfs?: boolean;
  readonly resetOnOpen?: boolean;
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

  worker.addEventListener("message", (ev: MessageEvent<StorageResponse | StorageStatus>) => {
    const m = ev.data;
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
  };
  worker.postMessage(init);

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
      appendInputs: (id, inputs) => call("runs.appendInputs", [id, inputs]),
      inputs: (id) => call("runs.inputs", [id]),
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
    snapshots: {
      putBlobs: (runId, blobs) => call("snapshots.putBlobs", [runId, blobs]),
      getBlob: (runId, id) => call("snapshots.getBlob", [runId, id]),
      write: (runId, s) => call("snapshots.write", [runId, s]),
      list: (runId) => call("snapshots.list", [runId]),
      read: (runId, id) => call("snapshots.read", [runId, id]),
    },
    beliefFrames: {
      append: (runId, frames) => call("beliefFrames.append", [runId, frames]),
      query: (q) => call("beliefFrames.query", [q]),
      keyframeAtOrBefore: (runId, agentId, tick) => call("beliefFrames.keyframeAtOrBefore", [runId, agentId, tick]),
    },
  };

  const admin: StorageAdmin = {
    info: () => call("admin.info"),
    exportDb: () => call("admin.exportDb"),
    exportRun: (runId) => call("admin.exportRun", [runId]),
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
  };
}
