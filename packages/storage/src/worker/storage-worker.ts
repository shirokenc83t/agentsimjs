import { err, type CodedError, type Result } from "@agentsim/core";
import type { MetricSample, RecorderItem, RunHeader, RunStatus, TraceRecord } from "@agentsim/trace";
import type { Database, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { openWasmSqlDriver, SecondConnectionError } from "../drivers/wasm-sql-driver.ts";
import { LiveSubscriptions } from "../live-subscriptions.ts";
import { SqlConsole, type SqlJobSignal, type SqlRunLimits } from "../sql-console.ts";
import type { BeliefFrame, BeliefFrameQuery, CachedResponse, MetricQuery, SnapshotWrite, StoragePorts, StoredBlob, StoredMetricSample, StoredRunInput } from "../ports.ts";
import type { ReplayHandlers, ReplayView, StorageExtensions } from "../replay.ts";
import type { SqlDriver } from "../sql/driver.ts";
import { LATEST_SCHEMA_VERSION, migrate } from "../sql/migrations.ts";
import { exportRunJsonl, importRunJsonl, readRunBundle, writeRunBundle, type RunFileErrorCode } from "../run-bundle.ts";
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
import { QuotaGuard, MEMORY_FALLBACK_LIMIT_BYTES, type QuotaMeasure } from "./quota.ts";
import { recorderAppend, recorderSide, reportCommit, type RecorderAppend, type RecorderSide } from "./recorder-ingest.ts";
import type { QuotaMessage, RecorderPortLike, RecorderPortMessage, RecorderToStorage } from "./recorder-protocol.ts";
import { deserializeToMemory, exportRun, validateImport, withoutProviderKeys, type ImportErrorCode } from "./transfer.ts";

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
/** Free pages worth a VACUUM (at start, or when the Storage browser asks while nothing records). */
const MIN_COMPACT_BYTES = 1024 * 1024;
/** A snapshot or a set of belief frames counts as this many records toward the flush mark. */
const ITEM_WEIGHT = 20;
/** A run is being recorded while its batches arrive: a compaction waits until none has for this long. */
const RECORDING_QUIET_MS = 5000;

class Engine {
  private driver!: SqlDriver;
  private ports!: StoragePorts;
  private raw!: Database;
  private pool: SAHPoolUtil | undefined;
  mode: StorageMode = "memory-fallback";
  warning: string | null = null;
  /** Test-only: a quota against the database's own size (`simulateQuotaBytes`, or set by a test). */
  simulatedQuotaBytes: number | undefined;

  constructor(private readonly sqlite3: Sqlite3Static, private readonly init: StorageInit) {
    this.simulatedQuotaBytes = init.simulateQuotaBytes;
  }

  private dbBytes(): number {
    // Pages the database uses, not the free ones a deletion leaves in the file.
    return this.driver.get<{ n: number }>("SELECT (p.page_count - f.freelist_count) * s.page_size AS n FROM pragma_page_count() p, pragma_freelist_count() f, pragma_page_size() s")?.n ?? 0;
  }

  /** Bytes of free pages the file still holds (what deleted rows left behind). */
  freeBytes(): number {
    return this.driver.get<{ n: number }>("SELECT f.freelist_count * s.page_size AS n FROM pragma_freelist_count() f, pragma_page_size() s")?.n ?? 0;
  }

  /**
   * Gives the space of deleted rows back to the file (VACUUM), when there is enough of it to be worth the time; returns the bytes freed. A VACUUM
   * takes seconds on a large database and the worker serves one request at a time, so it is not done inside a delete: at start, and when
   * nothing is recording (ADR-0020 addition of 2026-10-18).
   */
  compactIfWorth(minFreeBytes = MIN_COMPACT_BYTES): number {
    const free = this.freeBytes();
    if (free < minFreeBytes) return 0;
    this.driver.exec("VACUUM");
    return free;
  }

  /**
   * Usage and quota for the run's pause rule (ADR-0020 addition of 2026-10-17): the browser's own figures for OPFS, the database's size
   * against a limit in the in-memory fallback, or against the simulated quota in tests.
   */
  async measureQuota(): Promise<QuotaMeasure> {
    if (this.simulatedQuotaBytes !== undefined) return { usageBytes: this.dbBytes(), quotaBytes: this.simulatedQuotaBytes };
    if (this.mode === "opfs-sahpool") {
      try {
        const e = await navigator.storage.estimate();
        if (e.quota !== undefined && e.quota > 0) return { usageBytes: e.usage ?? 0, quotaBytes: e.quota };
      } catch {
        // estimate() unavailable: fall through to the database's own size.
      }
    }
    return { usageBytes: this.dbBytes(), quotaBytes: MEMORY_FALLBACK_LIMIT_BYTES };
  }

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
    this.compactIfWorth(); // what deleted runs left behind in an earlier session
    if (this.simulatedQuotaBytes === undefined && this.init.simulateQuotaHeadroomBytes !== undefined) this.simulatedQuotaBytes = this.dbBytes() + this.init.simulateQuotaHeadroomBytes;
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
    this.console = undefined;
    this.driver.exec("PRAGMA temp_store = MEMORY");
    migrate(this.driver, now);
    this.ports = createSqlPorts(this.driver, now);
  }

  get storage(): StoragePorts {
    return this.ports;
  }

  private console: SqlConsole | undefined;
  /** The SQL console's executor for the current connection (one per connection: a replaced connection gets its own). */
  get sqlConsole(): SqlConsole {
    return (this.console ??= new SqlConsole({ sqlite3: this.sqlite3, db: this.raw }));
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
    const bytes = this.pool ? this.pool.exportFile(this.init.dbFile) : this.sqlite3.capi.sqlite3_js_db_export(this.raw);
    // A key remembered on this device never leaves it (ADR-0044 §3): the export is made without it.
    return withoutProviderKeys(this.sqlite3, bytes);
  }

  exportRun(runId: string) {
    return exportRun(this.sqlite3, this.driver, runId);
  }

  /** A run as a JSON-lines file (ADR-0035 addition of 2026-10-17, item 11). */
  exportRunJsonl(runId: string) {
    return exportRunJsonl(this.ports, runId);
  }

  /**
   * Adds the run of a file to the database as a new run: a JSON-lines run file, or a per-run SQLite file (validated as a database import is, then read
   * through the ports of an in-memory copy). Written in one transaction on the worker's queue: the recorder's batches wait for it.
   */
  async importRun(bytes: Uint8Array): Promise<Result<{ readonly runId: string; readonly importedFrom: string }, CodedError<ImportErrorCode | RunFileErrorCode>>> {
    if (bytes.byteLength >= 16 && new TextDecoder().decode(bytes.subarray(0, 16)) === "SQLite format 3\u0000") {
      const v = validateImport(this.sqlite3, bytes);
      if (!v.ok) return v;
      const mem = deserializeToMemory(this.sqlite3, bytes);
      try {
        const source = createSqlPorts(mem.driver, now);
        const runs = await source.runs.list();
        if (runs.length !== 1) return err({ code: "not_run_file", message: `the file holds ${runs.length} runs: a run file holds one (a whole database is imported with "Import .sqlite")` });
        const bundle = await readRunBundle(source, (runs[0] as { runId: string }).runId);
        if (!bundle.ok) return bundle;
        return await this.batch(() => writeRunBundle(this.ports, bundle.value));
      } finally {
        mem.driver.close();
      }
    }
    return await this.batch(() => importRunJsonl(this.ports, bytes));
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
export function runStorageWorker(scope: WorkerScope, checks?: StorageMessageChecks, extensions?: StorageExtensions): void {
  /** The replay module, once the first replay read asked for it. */
  let replayModule: Promise<ReplayHandlers> | undefined;
  let engine: Engine | undefined;
  let release: (() => void) | undefined;
  const queue: (StorageRequest | RecorderAppend | RecorderSide)[] = [];
  /** The direct channel to the sim worker's recorder (ADR-0019 addition of 2026-10-17): batches in, header and persisted head out. */
  let recorderPort: RecorderPortLike | undefined;
  /** Quota (ADR-0035 §6): while paused, the run's batches are held (kept, in order, unsaved) and the recorder is told. */
  const quota = new QuotaGuard();
  let heldBatches: (RecorderAppend | RecorderSide)[] = [];
  let quotaTimer: ReturnType<typeof setInterval> | undefined;
  let measuring = false;
  /** The run whose recorder writes to this worker: it cannot be deleted. */
  let recordedRunId: string | undefined;
  /** When the latest recorder batch arrived (wall clock; a policy input, never part of a run). */
  let lastBatchAt = 0;
  let slowWriterMs = 0;
  let pendingAppendRecords = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushDue = false;
  let draining = false;
  /** The live subscriptions (ADR-0035 section 5): offered everything this worker stores, after it is stored; they push matches to the UI at most 10 times a second. */
  const live = new LiveSubscriptions({
    emit: (batch) => scope.postMessage({ type: "live", batch }),
    now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  /** Set once storage can no longer serve requests (closed or failed to open); never cleared. */
  let terminal: { code: "closed" | "open_failed"; message: string } | undefined;

  /** The SQL console's statement that is running, if any: it runs beside the queue (the recorder's batches are stored between its slices), never inside it. */
  let sqlJob: { readonly jobId: string; readonly signal: SqlJobSignal; readonly done: Promise<void> } | undefined;
  /** Stops the statement that is running and waits until it has let go of the connection (before anything that replaces or closes it). */
  async function stopSqlJob(): Promise<void> {
    const job = sqlJob;
    if (!job) return;
    job.signal.cancelled = true;
    await job.done;
  }

  const status = (s: StorageStatus) => scope.postMessage(s);
  const respond = (r: StorageResponse, transfer?: Transferable[]) => scope.postMessage(r, transfer);
  // Id 0 is a recorder batch: nobody is waiting for a response to it (the recorder is told through its port).
  const fail = (id: number, code: string, message: string) => (id === 0 ? undefined : respond({ type: "response", id, ok: false, error: { code, message } }));

  /** Rejects every queued request: nothing may hang or be dropped silently (ADR-0004). */
  function failQueued(): void {
    if (!terminal) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const req of queue.splice(0)) {
      fail(req.id, terminal.code, terminal.message);
      if ("recorder" in req) recorderPort?.postMessage({ type: "rejected", runId: req.recorder.runId, code: terminal.code, message: terminal.message });
      else if ("recorderItem" in req) recorderPort?.postMessage({ type: "rejected", runId: req.recorderItem.runId, code: terminal.code, message: terminal.message });
    }
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
        slowWriterMs = init.simulateSlowWriterMs ?? 0;
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

  /** A snapshot or belief frames of the run, stored in order with the batches around them; a refusal is reported to the recorder. */
  async function storeRecorderItem(item: RecorderItem, stored?: { runId: string; samples: MetricSample[] }[]): Promise<void> {
    const e = engine;
    if (!e) return;
    const refuse = (code: string, message: string) => recorderPort?.postMessage({ type: "rejected", runId: item.runId, code, message });
    try {
      if (item.type === "snapshot") {
        const r = await e.storage.snapshots.write(item.runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
        // The same state twice (a pause where nothing ran since the last snapshot) is the same snapshot: nothing to refuse.
        if (!r.ok && r.error.code !== "duplicate_snapshot") refuse(r.error.code, r.error.message);
      } else if (item.type === "metrics") {
        const r = await e.storage.metrics.append(item.runId, item.samples);
        if (!r.ok) refuse(r.error.code, r.error.message);
        else stored?.push({ runId: item.runId, samples: [...item.samples] });
      } else {
        const stored = await e.storage.snapshots.putBlobs(item.runId, item.blobs);
        if (!stored.ok) return refuse(stored.error.code, stored.error.message);
        const r = await e.storage.beliefFrames.append(item.runId, item.frames);
        if (!r.ok) refuse(r.error.code, r.error.message);
      }
    } catch (err) {
      refuse("storage_error", err instanceof Error ? err.message : String(err));
    }
  }

  function announceQuota(state: QuotaMessage["state"], m: QuotaMeasure): void {
    const msg: QuotaMessage = { type: "quota", state, usageBytes: m.usageBytes, quotaBytes: m.quotaBytes };
    recorderPort?.postMessage(msg);
    scope.postMessage(msg);
  }

  /**
   * Measures usage against the quota (after commits, and while paused every half second: space may have been freed). Near the quota the
   * run's batches are held and the recorder told; when usage is clearly lower the held batches are stored, in order, and it is told again.
   */
  async function checkQuota(): Promise<void> {
    const e = engine;
    if (!e || measuring) return;
    measuring = true;
    try {
      const m = await e.measureQuota();
      const change = quota.update(m);
      if (change === "paused") {
        announceQuota("paused", m);
        quotaTimer ??= setInterval(() => void checkQuota(), 500);
      } else if (change === "ok") {
        clearInterval(quotaTimer);
        quotaTimer = undefined;
        queue.unshift(...heldBatches);
        heldBatches = [];
        announceQuota("ok", m);
        void drain();
      }
    } finally {
      measuring = false;
    }
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
        // While the quota is near, the run's batches and items are held, in order, not committed.
        if ((("recorderItem" in head) || ("recorder" in head)) && quota.paused) {
          heldBatches.push(head);
          queue.shift();
          pendingAppendRecords = queue.reduce((acc, r) => acc + appendSize(r), 0);
          continue;
        }
        if (coalescable(head)) {
          const onlyThese = queue.every(coalescable);
          if (onlyThese && pendingAppendRecords < FLUSH_RECORDS && !flushDue) {
            scheduleFlush();
            return;
          }
          let n = 0;
          while (queue[n] && coalescable(queue[n] as StorageRequest | RecorderAppend | RecorderSide)) n++;
          // Appends of the main thread and what the recorder handed over (records, snapshots, belief frames) that are waiting go in one
          // transaction, in order: one commit for a poll's worth instead of one per item (the commit is what an OPFS write costs).
          const run = queue.splice(0, n);
          pendingAppendRecords = queue.reduce((acc, r) => acc + appendSize(r), 0);
          flushDue = false;
          // Test-only slow writer (ADR-0035 §6): the commit of recorder batches takes its time, so the backlog builds up.
          if (slowWriterMs > 0 && run.some((r) => "recorder" in r)) await new Promise<void>((resolve) => setTimeout(resolve, slowWriterMs));
          await commitRun(run);
          void checkQuota();
          continue;
        }
        queue.shift();
        await handle(head as StorageRequest); // appends and recorder items were committed above
      }
    } finally {
      draining = false;
    }
  }

  /** What waits in the queue to be committed with its neighbours: trace appends and the recorder's items. */
  const coalescable = (r: StorageRequest | RecorderAppend | RecorderSide): boolean => r.op === "trace.append" || r.op === "recorder.item";

  /** How much a queued entry counts toward the flush mark: its records, or a fixed weight for a snapshot or a set of belief frames. */
  function appendSize(r: StorageRequest | RecorderAppend | RecorderSide): number {
    if (r.op === "recorder.item") return ITEM_WEIGHT;
    return r.op === "trace.append" && Array.isArray(r.args[0]) ? r.args[0].length : 0;
  }

  async function commitRun(run: (StorageRequest | RecorderAppend | RecorderSide)[]): Promise<void> {
    const e = engine;
    if (!e) return;
    const answers: { id: number; value: unknown }[] = [];
    const recorded: { batch: RecorderAppend["recorder"]; result: Result<void, CodedError> }[] = [];
    // What the transaction stored, to offer to the live subscriptions once it has committed.
    const storedRecords: TraceRecord[] = [];
    const storedSamples: { runId: string; samples: MetricSample[] }[] = [];
    try {
      await e.batch(async () => {
        for (const req of run) {
          if (req.op === "recorder.item") {
            await storeRecorderItem((req as RecorderSide).recorderItem, storedSamples);
            continue;
          }
          const result = await e.storage.trace.append(req.args[0] as TraceRecord[]);
          if (result.ok) storedRecords.push(...(req.args[0] as TraceRecord[]));
          if ("recorder" in req) recorded.push({ batch: (req as RecorderAppend).recorder, result });
          else answers.push({ id: req.id, value: result });
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const req of run) {
        fail(req.id, "storage_error", message);
        if ("recorder" in req) recorderPort?.postMessage({ type: "rejected", runId: req.recorder.runId, code: "storage_error", message });
        else if ("recorderItem" in req) recorderPort?.postMessage({ type: "rejected", runId: req.recorderItem.runId, code: "storage_error", message });
      }
      return;
    }
    for (const a of answers) respond({ type: "response", id: a.id, ok: true, value: a.value });
    // The transaction committed: what it stored goes to the subscriptions (the recording is never sampled; only the display is).
    live.offerRecords(storedRecords);
    for (const s of storedSamples) live.offerSamples(s.runId, s.samples);
    // The transaction committed: the head moves as far as the batches before the first refusal.
    if (recorded.length > 0) reportCommit(recorded, recorderPort, (m) => scope.postMessage(m));
  }

  async function handle(req: StorageRequest | RecorderAppend): Promise<void> {
    const e = engine;
    if (!e) return fail(req.id, "not_ready", "storage not ready");
    const [a, b] = req.args;
    const s = e.storage;
    try {
      let value: unknown;
      let transfer: Transferable[] | undefined;
      switch (req.op) {
        case "sql.run": {
          // Not answered here: the statement is sliced and yields to the queue, so it must not be awaited by it.
          const jobId = String(a);
          const signal: SqlJobSignal = { cancelled: false };
          const limits = (req.args[2] ?? undefined) as Partial<SqlRunLimits> | undefined;
          const wasBusy = e.sqlConsole.busy; // another statement is running: this one is refused as busy, and is not the job
          const done = e.sqlConsole
            .run(String(b), limits, signal)
            .then((result) => respond({ type: "response", id: req.id, ok: true, value: result }))
            .catch((err: unknown) => fail(req.id, "storage_error", err instanceof Error ? err.message : String(err)))
            .finally(() => {
              if (sqlJob?.jobId === jobId) sqlJob = undefined;
            });
          if (wasBusy || !e.sqlConsole.busy) return void (await done); // refused before it started (busy, a write, a bad limit): answered already
          sqlJob = { jobId, signal, done };
          return;
        }
        case "sql.cancel": {
          const job = sqlJob;
          if (job !== undefined && job.jobId === String(a)) job.signal.cancelled = true;
          value = job !== undefined && job.jobId === String(a);
          break;
        }
        case "sql.schema": value = e.sqlConsole.schema(); break;
        case "live.subscribe": value = live.subscribe(String(a), String(b), String(req.args[2] ?? "")); break;
        case "live.change": value = live.change(String(a), String(b ?? "")); break;
        case "live.unsubscribe": value = live.unsubscribe(String(a)); break;
        case "trace.flush": value = await s.trace.flush(); break;
        case "trace.query": value = await s.trace.query(a as { runId: string; limit: number }); break;
        case "trace.count": value = await s.trace.count(String(a)); break;
        case "runs.allocateRunId": value = await s.runs.allocateRunId(); break;
        case "runs.create": {
          const header = a as RunHeader;
          const created = await s.runs.create(header);
          value = created;
          if (created.ok) recordedRunId = header.recording === "stored" ? header.runId : undefined; // a new run supersedes the one before
          // Header first: the recorder of a recorded run waits for this before it sends its first batch.
          if (created.ok && header.recording === "stored") recorderPort?.postMessage({ type: "header", runId: header.runId });
          break;
        }
        case "runs.get": value = await s.runs.get(String(a)); break;
        case "runs.list": value = await s.runs.list(); break;
        case "runs.setStatus": value = await s.runs.setStatus(String(a), b as RunStatus); break;
        case "runs.markNotReproducible": value = await s.runs.markNotReproducible(String(a), Number(b)); break;
        case "runs.appendInputs": value = await s.runs.appendInputs(String(a), Array.isArray(b) ? (b as StoredRunInput[]) : []); break;
        case "runs.inputs": value = await s.runs.inputs(String(a)); break;
        case "runs.sizes": value = await s.runs.sizes(String(a)); break;
        case "admin.compact": {
          // Only when nothing is recording: a VACUUM stalls the queue the recorder writes through.
          // A VACUUM cannot run while a statement of the SQL console holds a read either.
          const recording = (recordedRunId !== undefined && now() - lastBatchAt < RECORDING_QUIET_MS) || e.sqlConsole.busy;
          value = { freedBytes: recording ? 0 : e.compactIfWorth(), skipped: recording };
          break;
        }
        case "runs.delete": {
          // The run being recorded is not deleted from under its recorder (the Storage browser also disables it).
          if (String(a) === recordedRunId) value = { ok: false, error: { code: "run_recording", message: `${String(a)} is being recorded: stop it or start another run first` } };
          else {
            // No VACUUM here: it would hold the recorder's batches for seconds, and the quota already counts pages in use.
            value = await s.runs.delete(String(a));
            void checkQuota(); // freeing space may let a run that paused for it go on
          }
          break;
        }
        case "cache.get": value = await s.cache.get(String(a), b === undefined ? undefined : String(b)); break;
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
        case "mindProfiles.list": value = await s.mindProfiles.list(); break;
        case "mindProfiles.get": value = await s.mindProfiles.get(String(a), typeof b === "number" ? b : undefined); break;
        case "mindProfiles.saveVersion": value = await s.mindProfiles.saveVersion(a as { id: string; name: string; document: unknown }); break;
        case "mindProfiles.delete": value = await s.mindProfiles.delete(String(a)); break;
        case "promptTemplates.list": value = await s.promptTemplates.list(); break;
        case "promptTemplates.get": value = await s.promptTemplates.get(String(a), typeof b === "number" ? b : undefined); break;
        case "promptTemplates.saveVersion": value = await s.promptTemplates.saveVersion(a as { id: string; name: string; document: unknown }); break;
        case "promptTemplates.delete": value = await s.promptTemplates.delete(String(a)); break;
        case "snapshots.putBlobs": value = await s.snapshots.putBlobs(String(a), Array.isArray(b) ? (b as StoredBlob[]) : []); break;
        case "snapshots.getBlob": value = await s.snapshots.getBlob(String(a), String(b)); break;
        case "snapshots.write": value = await s.snapshots.write(String(a), b as SnapshotWrite); break;
        case "snapshots.list": value = await s.snapshots.list(String(a)); break;
        case "snapshots.read": value = await s.snapshots.read(String(a), String(b)); break;
        case "beliefFrames.append": value = await s.beliefFrames.append(String(a), Array.isArray(b) ? (b as BeliefFrame[]) : []); break;
        case "beliefFrames.query": value = await s.beliefFrames.query(a as BeliefFrameQuery); break;
        case "metrics.append": value = await s.metrics.append(String(a), Array.isArray(b) ? (b as StoredMetricSample[]) : []); break;
        case "metrics.query": value = await s.metrics.query(a as MetricQuery); break;
        case "beliefFrames.keyframeAtOrBefore": value = await s.beliefFrames.keyframeAtOrBefore(String(a), String(b), Number(req.args[2])); break;
        case "replay.beliefAt":
        case "replay.world": {
          // Rebuilt here, in the worker, from the stored frames and scenario; the module is loaded on the first read.
          if (!extensions?.replay) return fail(req.id, "unsupported", "this storage worker has no replay module");
          replayModule ??= extensions.replay();
          const mod = await replayModule;
          const r = req.op === "replay.world" ? await mod.world(s, String(a)) : await mod.beliefAt(s, String(a), String(b), Number(req.args[2]), req.args[3] as ReplayView | undefined);
          value = r;
          if (r.ok) transfer = [r.value.coords.buffer as ArrayBuffer, r.value.data.buffer as ArrayBuffer];
          break;
        }
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
        case "admin.exportRunJsonl": {
          const r = await e.exportRunJsonl(String(a));
          value = r;
          if (r.ok) transfer = [r.value.buffer as ArrayBuffer];
          break;
        }
        case "admin.importRun": {
          if (!(a instanceof Uint8Array)) return fail(req.id, "invalid_args", "expected Uint8Array");
          value = await e.importRun(a);
          break;
        }
        case "admin.importDb": {
          if (!(a instanceof Uint8Array)) return fail(req.id, "invalid_args", "expected Uint8Array");
          await stopSqlJob(); // the connection is replaced: no statement may hold the old one
          value = await e.importDb(a);
          break;
        }
        case "admin.close": {
          live.dispose();
          await stopSqlJob();
          e.close();
          release?.();
          respond({ type: "response", id: req.id, ok: true, value: undefined });
          status({ type: "status", state: "closed" });
          // Anything queued behind the close is rejected, not left hanging.
          enterTerminal("closed", "storage is closed");
          return;
        }
        case "test.openSecondConnection": value = e.openSecondConnection(); break;
        case "test.setSimulatedQuota": {
          e.simulatedQuotaBytes = typeof a === "number" ? a : undefined;
          void checkQuota();
          break;
        }
        case "trace.append": throw new Error("unreachable: appends are batched");
      }
      respond({ type: "response", id: req.id, ok: true, value }, transfer);
    } catch (err) {
      fail(req.id, "storage_error", err instanceof Error ? err.message : String(err));
    }
  }

  function attachRecorder(m: RecorderPortMessage): void {
    const port = m.port as unknown as RecorderPortLike;
    recorderPort = port;
    port.addEventListener("message", (ev) => {
      const msg = ev.data as RecorderToStorage | undefined;
      if (terminal) return;
      if (msg?.type === "batch") {
        lastBatchAt = now();
        queue.push(recorderAppend(msg.batch));
        pendingAppendRecords += msg.batch.records.length;
        void drain();
      } else if (msg?.type === "snapshot" || msg?.type === "frames" || msg?.type === "metrics") {
        lastBatchAt = now();
        queue.push(recorderSide(msg));
        pendingAppendRecords += ITEM_WEIGHT;
        void drain();
      }
    });
    port.start?.();
  }

  scope.addEventListener("message", (ev) => {
    const msg = ev.data as { type?: unknown };
    if (msg?.type === "recorderPort") return attachRecorder(msg as RecorderPortMessage);
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
