import type { RunHeader, RunStatus, TraceRecord } from "@agentsim/trace";
import type { Database, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { openWasmSqlDriver, SecondConnectionError } from "../drivers/wasm-sql-driver.ts";
import type { CachedResponse, StoragePorts, StoredRunInput } from "../ports.ts";
import type { SqlDriver } from "../sql/driver.ts";
import { LATEST_SCHEMA_VERSION, migrate } from "../sql/migrations.ts";
import { createSqlPorts } from "../sql/sql-storage.ts";
import { loadSqlite } from "./load-sqlite.ts";
import type { StorageMessageChecks } from "./message-checks.ts";
import {
  type StorageInit,
  type StorageRequest,
  type StorageInfo,
  type StorageMode,
  type StorageResponse,
  type StorageStatus,
} from "./protocol.ts";
import { deserializeToMemory, exportRun, validateImport } from "./transfer.ts";

/** The subset of a DedicatedWorkerGlobalScope the storage worker needs (keeps it testable). */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
}

/** Files the pool must hold: the database and its rollback journal (temp_store = MEMORY). */
const POOL_FILES_NEEDED = 2;
/** Trace appends are coalesced and committed per batch (ADR-0010). */
const FLUSH_RECORDS = 500;
const FLUSH_DELAY_MS = 16;

const now = () => Date.now();

class Engine {
  private driver!: SqlDriver;
  private ports!: StoragePorts;
  private raw!: Database;
  private pool: SAHPoolUtil | undefined;
  mode: StorageMode = "memory-fallback";
  warning: string | null = null;

  constructor(private readonly sqlite3: Sqlite3Static, private readonly init: StorageInit) {}

  async open(): Promise<void> {
    const reason = await this.opfsUnavailableReason();
    if (reason === null) {
      try {
        this.pool = await this.sqlite3.installOpfsSAHPoolVfs({
          name: this.init.poolName,
          initialCapacity: POOL_FILES_NEEDED,
          clearOnInit: this.init.resetOnOpen === true,
        });
        await this.pool.reserveMinimumCapacity(POOL_FILES_NEEDED);
        this.mode = "opfs-sahpool";
      } catch (e) {
        this.pool = undefined;
        this.warning = `OPFS unavailable (${e instanceof Error ? e.message : String(e)})`;
      }
    } else {
      this.warning = reason;
    }
    this.openConnection();
  }

  private async opfsUnavailableReason(): Promise<string | null> {
    if (this.init.simulateNoOpfs) return "OPFS unavailable (simulated)";
    if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return "OPFS unavailable";
    try {
      const { quota } = await navigator.storage.estimate();
      if (quota !== undefined && quota < this.init.quotaThresholdBytes) {
        return `storage quota ${Math.round(quota / 1e6)} MB is below the ${Math.round(this.init.quotaThresholdBytes / 1e6)} MB threshold`;
      }
    } catch {
      // estimate() unsupported: proceed and let the VFS decide.
    }
    return null;
  }

  private openConnection(bytes?: Uint8Array): void {
    if (this.pool) {
      const Db = this.pool.OpfsSAHPoolDb;
      this.driver = openWasmSqlDriver(this.init.dbFile, () => (this.raw = new Db(this.init.dbFile)));
    } else if (bytes) {
      const mem = deserializeToMemory(this.sqlite3, bytes);
      this.driver = mem.driver;
      this.raw = mem.raw;
    } else {
      this.driver = openWasmSqlDriver(null, () => (this.raw = new this.sqlite3.oo1.DB(":memory:", "c")));
    }
    this.driver.exec("PRAGMA temp_store = MEMORY");
    migrate(this.driver, now);
    this.ports = createSqlPorts(this.driver, now);
  }

  get storage(): StoragePorts {
    return this.ports;
  }

  /** Executes `fn` in one transaction (batched appends; each append is its own savepoint). */
  batch<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }

  async info(): Promise<StorageInfo> {
    let usage: number | null = null;
    let quota: number | null = null;
    let persisted: boolean | null = null;
    try {
      const e = await navigator.storage.estimate();
      usage = e.usage ?? null;
      quota = e.quota ?? null;
      persisted = await navigator.storage.persisted();
    } catch {
      // Not available in this context.
    }
    const size = this.driver.get<{ n: number }>("SELECT p.page_count * s.page_size AS n FROM pragma_page_count() p, pragma_page_size() s");
    return {
      mode: this.mode,
      sqliteVersion: this.sqlite3.version.libVersion,
      schemaVersion: LATEST_SCHEMA_VERSION,
      dbFileBytes: size?.n ?? 0,
      usageBytes: usage,
      quotaBytes: quota,
      persisted,
      quotaThresholdBytes: this.init.quotaThresholdBytes,
      warning: this.warning,
    };
  }

  exportDb(): Uint8Array {
    return this.pool ? this.pool.exportFile(this.init.dbFile) : this.sqlite3.capi.sqlite3_js_db_export(this.raw);
  }

  exportRun(runId: string) {
    return exportRun(this.sqlite3, this.driver, runId);
  }

  async importDb(bytes: Uint8Array) {
    const v = validateImport(this.sqlite3, bytes);
    if (!v.ok) return v;
    this.driver.close();
    if (this.pool) {
      await this.pool.importDb(this.init.dbFile, bytes);
      this.openConnection();
    } else {
      this.openConnection(bytes);
    }
    return v;
  }

  /** Test hook proving the one-connection invariant (ADR-0020). */
  openSecondConnection(): string {
    if (!this.pool) return "no-pool";
    const Db = this.pool.OpfsSAHPoolDb;
    try {
      openWasmSqlDriver(this.init.dbFile, () => new Db(this.init.dbFile)).close();
      return "opened";
    } catch (e) {
      return e instanceof SecondConnectionError ? e.code : "other-error";
    }
  }

  close(): void {
    this.driver.close();
    this.pool?.pauseVfs();
  }
}

/** Runs the storage worker on `scope` (the module worker's global scope in production). */
export function runStorageWorker(scope: WorkerScope, checks?: StorageMessageChecks): void {
  let engine: Engine | undefined;
  let release: (() => void) | undefined;
  const queue: StorageRequest[] = [];
  let pendingAppendRecords = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushDue = false;
  let draining = false;

  /** Set once storage can no longer serve requests (closed or failed to open); never cleared. */
  let terminal: { code: "closed" | "open_failed"; message: string } | undefined;

  const status = (s: StorageStatus) => scope.postMessage(s);
  const respond = (r: StorageResponse, transfer?: Transferable[]) => scope.postMessage(r, transfer);
  const fail = (id: number, code: string, message: string) => respond({ type: "response", id, ok: false, error: { code, message } });

  /** Rejects every queued request: nothing may hang or be dropped silently (ADR-0004). */
  function failQueued(): void {
    if (!terminal) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const req of queue.splice(0)) fail(req.id, terminal.code, terminal.message);
    pendingAppendRecords = 0;
  }

  function enterTerminal(code: "closed" | "open_failed", message: string): void {
    terminal ??= { code, message };
    engine = undefined;
    failQueued();
  }

  async function start(init: StorageInit): Promise<void> {
    status({ type: "status", state: "loading" });
    const sqlite3 = await loadSqlite();
    status({ type: "status", state: "waiting-lock" });
    // Single-tab ownership (ADR-0020): a second tab queues here until the owner goes away.
    // Requests sent before the database is open wait in the queue; they are served once ready.
    void navigator.locks.request(init.lockName, { mode: "exclusive" }, async () => {
      try {
        const e = new Engine(sqlite3, init);
        await e.open();
        engine = e;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status({ type: "status", state: "failed", error: message });
        enterTerminal("open_failed", `storage failed to open: ${message}`);
        return; // releases the lock
      }
      status({ type: "status", state: "ready", mode: engine.mode, ...(engine.warning ? { warning: engine.warning } : {}) });
      void drain();
      await new Promise<void>((resolve) => (release = resolve));
    });
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushDue = true;
      void drain();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Processes the queue strictly in order, one request at a time (the single connection is never
   * used concurrently). Consecutive trace appends are held briefly and committed in one transaction;
   * any other request flushes them first (read-your-writes).
   */
  async function drain(): Promise<void> {
    if (!engine || draining) return;
    draining = true;
    try {
      while (queue.length > 0 && engine) {
        const head = queue[0];
        if (!head) break;
        if (head.op === "trace.append") {
          const onlyAppends = queue.every((r) => r.op === "trace.append");
          if (onlyAppends && pendingAppendRecords < FLUSH_RECORDS && !flushDue) {
            scheduleFlush();
            return;
          }
          let n = 0;
          while (queue[n]?.op === "trace.append") n++;
          const batch = queue.splice(0, n);
          pendingAppendRecords = queue.reduce((acc, r) => acc + appendSize(r), 0);
          flushDue = false;
          commitAppends(batch);
          continue;
        }
        queue.shift();
        await handle(head);
      }
    } finally {
      draining = false;
    }
  }

  function appendSize(r: StorageRequest): number {
    return r.op === "trace.append" && Array.isArray(r.args[0]) ? r.args[0].length : 0;
  }

  function commitAppends(batch: StorageRequest[]): void {
    const e = engine;
    if (!e) return;
    const results: { id: number; out: Promise<unknown> }[] = [];
    try {
      e.batch(() => {
        for (const req of batch) results.push({ id: req.id, out: e.storage.trace.append(req.args[0] as TraceRecord[]) });
      });
    } catch (err) {
      for (const req of batch) fail(req.id, "storage_error", err instanceof Error ? err.message : String(err));
      return;
    }
    for (const r of results) void r.out.then((value) => respond({ type: "response", id: r.id, ok: true, value }));
  }

  async function handle(req: StorageRequest): Promise<void> {
    const e = engine;
    if (!e) return fail(req.id, "not_ready", "storage not ready");
    const [a, b] = req.args;
    const s = e.storage;
    try {
      let value: unknown;
      let transfer: Transferable[] | undefined;
      switch (req.op) {
        case "trace.flush": value = await s.trace.flush(); break;
        case "trace.query": value = await s.trace.query(a as { runId: string; limit: number }); break;
        case "trace.count": value = await s.trace.count(String(a)); break;
        case "runs.allocateRunId": value = await s.runs.allocateRunId(); break;
        case "runs.create": value = await s.runs.create(a as RunHeader); break;
        case "runs.get": value = await s.runs.get(String(a)); break;
        case "runs.list": value = await s.runs.list(); break;
        case "runs.setStatus": value = await s.runs.setStatus(String(a), b as RunStatus); break;
        case "runs.appendInputs": value = await s.runs.appendInputs(String(a), Array.isArray(b) ? (b as StoredRunInput[]) : []); break;
        case "runs.inputs": value = await s.runs.inputs(String(a)); break;
        case "cache.get": value = await s.cache.get(String(a)); break;
        case "cache.put": value = await s.cache.put(String(a), b as CachedResponse); break;
        case "userData.get": value = await s.userData.get(String(a), String(b)); break;
        case "userData.set": value = await s.userData.set(String(a), String(b), req.args[2]); break;
        case "userData.delete": value = await s.userData.delete(String(a), String(b)); break;
        case "userData.keys": value = await s.userData.keys(String(a)); break;
        case "scenarios.list": value = await s.scenarios.list(); break;
        case "scenarios.get": value = await s.scenarios.get(String(a), typeof b === "number" ? b : undefined); break;
        case "scenarios.saveVersion": value = await s.scenarios.saveVersion(a); break;
        case "scenarios.delete": value = await s.scenarios.delete(String(a)); break;
        case "runConfigs.list": value = await s.runConfigs.list(); break;
        case "runConfigs.get": value = await s.runConfigs.get(String(a), typeof b === "number" ? b : undefined); break;
        case "runConfigs.saveVersion": value = await s.runConfigs.saveVersion(a as { id: string; name: string; document: unknown }); break;
        case "runConfigs.delete": value = await s.runConfigs.delete(String(a)); break;
        case "admin.info": value = await e.info(); break;
        case "admin.exportDb": {
          const bytes = e.exportDb();
          value = bytes;
          transfer = [bytes.buffer];
          break;
        }
        case "admin.exportRun": {
          const r = e.exportRun(String(a));
          value = r;
          if (r.ok) transfer = [r.value.buffer];
          break;
        }
        case "admin.importDb": {
          if (!(a instanceof Uint8Array)) return fail(req.id, "invalid_args", "expected Uint8Array");
          value = await e.importDb(a);
          break;
        }
        case "admin.close": {
          e.close();
          release?.();
          respond({ type: "response", id: req.id, ok: true, value: undefined });
          status({ type: "status", state: "closed" });
          // Anything queued behind the close is rejected, not left hanging.
          enterTerminal("closed", "storage is closed");
          return;
        }
        case "test.openSecondConnection": value = e.openSecondConnection(); break;
        case "trace.append": throw new Error("unreachable: appends are batched");
      }
      respond({ type: "response", id: req.id, ok: true, value }, transfer);
    } catch (err) {
      fail(req.id, "storage_error", err instanceof Error ? err.message : String(err));
    }
  }

  scope.addEventListener("message", (ev) => {
    const msg = ev.data as { type?: unknown };
    if (msg?.type === "init") {
      const init = checks ? checks.init(msg) : ({ ok: true, value: msg as StorageInit } as const);
      if (!init.ok) return status({ type: "status", state: "failed", error: init.error.message });
      start(init.value).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        status({ type: "status", state: "failed", error: message });
        enterTerminal("open_failed", `storage failed to open: ${message}`);
      });
      return;
    }
    const req = checks ? checks.request(msg) : isRequest(msg) ? ({ ok: true, value: msg } as const) : ({ ok: false, error: { message: "malformed request" } } as const);
    if (!req.ok) {
      const id = (msg as { id?: unknown }).id;
      if (typeof id === "number") fail(id, "invalid_request", req.error.message);
      return;
    }
    if (terminal) return fail(req.value.id, terminal.code, terminal.message);
    queue.push(req.value);
    pendingAppendRecords += appendSize(req.value);
    void drain();
  });
}

/** Minimal envelope guard used when full (dev-only) checks are off. */
function isRequest(m: unknown): m is StorageRequest {
  const r = m as Partial<StorageRequest> | null;
  return !!r && r.type === "request" && typeof r.id === "number" && typeof r.op === "string" && Array.isArray(r.args);
}
