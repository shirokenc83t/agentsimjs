import { SIM_PROTOCOL_VERSION, type MainToSim, type PresetId, type SimInputMessage, type SimLoadedMessage, type SimLoadMessage, type SimStrategyTestMessage, type SimStrategyTestResultMessage, type SimToMain, type TimeMode } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import { ChunkQueue, RollingStats, StateInterpolator, type GridSpec } from "@agentsim/ui";
import { TrailStore, type ExecutedPath } from "./trail-store.ts";

/** A preset built by the worker: the document to store and load, and its content hash (as storage records it). */
export interface BuiltPreset {
  readonly document: unknown;
  readonly contentHash: string;
}

export interface SimSnapshot {
  readonly ready: boolean;
  readonly running: boolean;
  readonly tick: number;
  readonly simTimeS: number;
  readonly entityIds: readonly string[];
  readonly tickRateHz: number;
  readonly ticksPerSecond: number;
  readonly tickTimeP95Ms: number;
  readonly mode: TimeMode;
  /** Realtime tick skips since start (each one is traced in the worker, ADR-0013). */
  readonly degradations: number;
  readonly lastSkippedTicks: number;
  readonly error: string | null;
  /** The loaded scenario run (undefined while the F0 dummy world runs). */
  readonly run: SimLoadedMessage | undefined;
  /** State hash after `hashTick` (scenario runs; refreshed with stats, after steps and pauses). */
  readonly stateHash: string | undefined;
  readonly hashTick: number | undefined;
  /** Latest per-agent status block (`STATUS_STRIDE` floats per entity), at ≤ 10 Hz. */
  readonly agentStatus: Float32Array | undefined;
  /** The loaded run's grid for the atlas (its chunk queue is filled as chunks arrive). */
  readonly grid: GridSpec | undefined;
  /** Planning views being built before tick 0 (ADR-0024), while a load is in progress. */
  readonly preparing?: { readonly runId: string; readonly done: number; readonly total: number };
  /** The recording's latest state for the loaded run (ADR-0035 §6): `ok`, or why the run waits (the writer is behind, the storage quota is near). */
  readonly recording?: { readonly runId: string; readonly state: "ok" | "storage_backpressure" | "storage_quota"; readonly backlogRecords: number };
  /** What the last load prepared, and its wall time (never in the trace or a hash). */
  readonly prepared?: { readonly runId: string; readonly views: number; readonly graphs: number; readonly ms: number };
}

/** Trace records kept on the main thread for panels until the F3 recorder can be queried instead. */
const MAX_RECORDS = 50_000;

/**
 * Main-thread side of the sim worker. Feeds the interpolator and returns pose buffers to the worker;
 * never blocks the render loop. React reads `snapshot()` at ≤ 10 Hz.
 */
export class SimClient {
  readonly interpolator = new StateInterpolator();
  /** Worker → main delivery latency of state messages (ms). */
  readonly stateLatencyMs = new RollingStats(120);
  private snap: SimSnapshot = {
    ready: false, running: false, tick: 0, simTimeS: 0, entityIds: [], tickRateHz: 10, ticksPerSecond: 0, tickTimeP95Ms: 0, mode: "lockstep", degradations: 0, lastSkippedTicks: 0, error: null,
    run: undefined, stateHash: undefined, hashTick: undefined, agentStatus: undefined, grid: undefined,
  };
  private recordList: TraceRecord[] = [];
  /** Executed paths of the loaded run, as received from the worker (bounded, F2 M1b). */
  private trails = new TrailStore(0);
  /** Agent index (entity order) by ID, for the loaded run. */
  private trailIndex = new Map<string, number>();
  private trailListeners = new Set<() => void>();
  private inputListeners = new Set<(m: SimInputMessage) => void>();
  /** Received chunks by index (views into the transferred buffers, no copy): cell inspection. */
  private chunkViews = new Map<number, Uint8Array>();
  private recordListeners = new Set<() => void>();
  private loadWaiters: { runId: string; resolve: (m: SimLoadedMessage) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly worker: Worker, tickRateHz: number) {
    worker.addEventListener("message", (ev: MessageEvent<SimToMain>) => this.onMessage(ev.data));
    worker.addEventListener("error", (ev) => (this.snap = { ...this.snap, error: ev.message || "sim worker error" }));
    this.post({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz });
  }

  private post(m: MainToSim, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: SimToMain): void {
    // Trusted internal channel: validated in tests, not per tick (ADR-0018 consequence).
    switch (m.type) {
      case "state": {
        const now = performance.now();
        if (m.sentAtEpochMs !== undefined) this.stateLatencyMs.add(performance.timeOrigin + now - m.sentAtEpochMs);
        this.interpolator.push(m.poses, now);
        this.snap = {
          ...this.snap,
          tick: m.tick,
          simTimeS: m.simTimeS,
          ...(m.entityIds ? { entityIds: m.entityIds } : {}),
          ...(m.agentStatus ? { agentStatus: m.agentStatus } : {}),
        };
        // The interpolator copied the poses: hand the buffer back for reuse.
        this.post({ type: "return-buffer", buffer: m.poses.buffer as ArrayBuffer }, [m.poses.buffer as ArrayBuffer]);
        break;
      }
      case "stats":
        this.snap = {
          ...this.snap,
          running: m.running,
          mode: m.mode,
          degradations: m.degradations,
          tickRateHz: m.tickRateHz,
          ticksPerSecond: m.ticksPerSecond,
          tickTimeP95Ms: m.tickTimeP95Ms,
          ...(m.stateHash === undefined ? {} : { stateHash: m.stateHash, hashTick: m.tick }),
        };
        break;
      case "loaded": {
        this.recordList = [];
        this.trails = new TrailStore(m.agents.length);
        this.trailIndex = new Map(m.agents.map((a, i) => [a.id, i]));
        for (const l of this.trailListeners) l();
        this.snap = { ...this.snap, run: m, stateHash: undefined, hashTick: undefined, agentStatus: undefined, grid: undefined, running: false, error: null };
        this.interpolator.resetEstimate();
        this.interpolator.snapToNext();
        for (const l of this.recordListeners) l();
        const waiters = this.loadWaiters.filter((w) => w.runId === m.runId);
        this.loadWaiters = this.loadWaiters.filter((w) => w.runId !== m.runId);
        for (const w of waiters) w.resolve(m);
        break;
      }
      case "grid": {
        if (m.runId !== this.snap.run?.runId) break;
        const dims = { sizeX: m.sizeX, sizeY: m.sizeY, chunkSize: m.chunkSize, resolutionM: m.resolutionM };
        this.chunkViews = new Map();
        this.defaultObstacleHeightM = m.defaultObstacleHeightM;
        this.snap = { ...this.snap, grid: { dims, zones: m.zones, queue: new ChunkQueue(Math.ceil(m.sizeX / m.chunkSize)) } };
        break;
      }
      case "chunks":
        // Chunks of another run (a load raced a batch) are dropped; the renderer drains the queue per frame.
        if (m.runId === this.snap.run?.runId && this.snap.grid) {
          this.snap.grid.queue.push(m.coords, m.data);
          const n = m.coords.length / 2;
          const bytes = m.data.length / n;
          const chunksX = Math.ceil(this.snap.grid.dims.sizeX / this.snap.grid.dims.chunkSize);
          for (let k = 0; k < n; k++) {
            this.chunkViews.set((m.coords[k * 2 + 1] ?? 0) * chunksX + (m.coords[k * 2] ?? 0), m.data.subarray(k * bytes, (k + 1) * bytes));
          }
        }
        break;
      case "input":
        for (const l of this.inputListeners) l(m);
        break;
      case "strategyTestResult": {
        const w = this.strategyWaiters.get(m.requestId);
        this.strategyWaiters.delete(m.requestId);
        w?.(m);
        break;
      }
      case "preset": {
        const w = this.presetWaiters.get(m.requestId);
        this.presetWaiters.delete(m.requestId);
        w?.resolve({ document: m.document, contentHash: m.contentHash });
        break;
      }
      case "trail":
        if (m.runId !== this.snap.run?.runId) break;
        this.trails.apply(m);
        for (const l of this.trailListeners) l();
        break;
      case "events":
        if (m.runId !== this.snap.run?.runId) break;
        this.recordList.push(...(m.records as TraceRecord[]));
        if (this.recordList.length > MAX_RECORDS) this.recordList = this.recordList.slice(-MAX_RECORDS);
        for (const l of this.recordListeners) l();
        break;
      case "degradation":
        this.snap = { ...this.snap, degradations: this.snap.degradations + 1, lastSkippedTicks: m.skippedTicks };
        break;
      case "recording":
        this.snap = { ...this.snap, recording: { runId: m.runId, state: m.state, backlogRecords: m.backlogRecords } };
        break;
      case "preparing":
        this.snap = { ...this.snap, preparing: { runId: m.runId, done: m.done, total: m.total } };
        break;
      case "prepared": {
        const { preparing: _, ...rest } = this.snap;
        this.snap = { ...rest, prepared: { runId: m.runId, views: m.views, graphs: m.graphs, ms: m.ms } };
        break;
      }
      case "ready":
        this.snap = { ...this.snap, ready: true, tickRateHz: m.tickRateHz };
        break;
      case "error": {
        const { preparing: _, ...rest } = this.snap;
        this.snap = { ...rest, error: `${m.code}: ${m.message}` };
        // A failed load is reported as an error; it rejects the pending load, if any.
        const waiters = this.loadWaiters;
        this.loadWaiters = [];
        for (const w of waiters) w.reject(new Error(`${m.code}: ${m.message}`));
        break;
      }
      default: {
        const listeners = this.streams.get(m.type);
        if (listeners) for (const l of listeners) (l as (x: typeof m) => void)(m);
      }
    }
  }

  snapshot(): SimSnapshot {
    return this.snap;
  }

  play(): void {
    this.post({ type: "control", op: "play" });
    this.snap = { ...this.snap, running: true };
  }

  pause(): void {
    this.post({ type: "control", op: "pause" });
    this.snap = { ...this.snap, running: false };
  }

  /** Runs `count` ticks at once in the worker (lockstep), then stays paused. */
  step(count = 1): void {
    this.post(count === 1 ? { type: "control", op: "step" } : { type: "control", op: "step", count });
    this.snap = { ...this.snap, running: false };
  }

  private presetWaiters = new Map<number, { resolve: (p: BuiltPreset) => void }>();
  private presetRequests = 0;

  /**
   * Builds a preset scenario document in the worker (F1 f1). The main thread receives the document only to pass it
   * on (storage, then `load`); it never parses or validates it.
   */
  buildPreset(preset: PresetId): Promise<BuiltPreset> {
    const requestId = ++this.presetRequests;
    return new Promise((resolve) => {
      this.presetWaiters.set(requestId, { resolve });
      this.post({ type: "buildPreset", requestId, preset });
    });
  }

  private strategyWaiters = new Map<number, (m: SimStrategyTestResultMessage) => void>();
  private strategyRequests = 0;

  /**
   * The researcher's "test on map" (ADR-0037 item 16): one request, one answer, matched by its own id. Not a run input and
   * not a panel stream: the worker plans apart from the run and answers with a path, or a refusal with its stable code.
   */
  strategyTest(req: Omit<SimStrategyTestMessage, "type" | "requestId">): Promise<SimStrategyTestResultMessage> {
    const requestId = ++this.strategyRequests;
    return new Promise((resolve) => {
      this.strategyWaiters.set(requestId, resolve);
      this.post({ type: "strategyTest", requestId, ...req });
    });
  }

  /** Loads a scenario run in the worker; resolves with what was loaded, rejects with the worker's error code. */
  /** True once the sim worker has its end of the recorder channel (a recorded run needs it). */
  recorderAttached = false;

  /** Hands the sim worker its end of the recorder channel; the other end goes to the storage worker. The port is transferred. */
  attachRecorderPort(port: MessagePort): void {
    this.post({ type: "recorderPort", port }, [port]);
    this.recorderAttached = true;
  }

  load(m: Omit<SimLoadMessage, "type">): Promise<SimLoadedMessage> {
    return new Promise((resolve, reject) => {
      this.loadWaiters.push({ runId: m.runId, resolve, reject });
      this.post({ type: "load", ...m });
    });
  }

  private defaultObstacleHeightM: number | undefined;

  /**
   * A cell of the loaded grid as last received (cell inspector), or undefined outside the grid or before its
   * chunk arrived. Height 0 on an occupied cell means "unknown height" (ADR-0012/0025).
   */
  cellAt(i: number, j: number): { occupancy: number; terrainCost: number; heightDm: number; defaultObstacleHeightM: number | undefined } | undefined {
    const g = this.snap.grid?.dims;
    if (!g || i < 0 || j < 0 || i >= g.sizeX || j >= g.sizeY) return undefined;
    const n = g.chunkSize;
    const ci = Math.floor(i / n);
    const cj = Math.floor(j / n);
    const view = this.chunkViews.get(cj * Math.ceil(g.sizeX / n) + ci);
    if (!view) return undefined;
    const k = ((j - cj * n) * n + (i - ci * n)) * 4;
    return {
      occupancy: view[k] ?? 0,
      terrainCost: view[k + 1] ?? 0,
      heightDm: (view[k + 2] ?? 0) | ((view[k + 3] ?? 0) << 8),
      defaultObstacleHeightM: this.defaultObstacleHeightM,
    };
  }

  /** Latest tick pose of an entity (x, y, z, heading), not interpolated. */
  pose(index: number): { x: number; y: number; z: number; headingRad: number } | undefined {
    const p = this.interpolator.latest();
    const o = index * 4;
    if (o + 3 >= p.length) return undefined;
    return { x: p[o] ?? 0, y: p[o + 1] ?? 0, z: p[o + 2] ?? 0, headingRad: p[o + 3] ?? 0 };
  }

  /**
   * Executed path of an agent from the worker's tick states: a view of its points (x, y, z each), their count,
   * and a version that changes when the worker replaced the whole trail. Valid until the next `trail` message.
   */
  executedPath(agentId: string): ExecutedPath {
    return this.trails.path(this.trailIndex.get(agentId) ?? -1);
  }

  /** Called for every run input the worker records (live commands and the inputs of a re-simulation), in order. */
  onInput(l: (m: SimInputMessage) => void): () => void {
    this.inputListeners.add(l);
    return () => this.inputListeners.delete(l);
  }

  /** Called when executed-path points arrive or a new run is loaded (≤ 10 Hz). */
  onTrail(l: () => void): () => void {
    this.trailListeners.add(l);
    return () => this.trailListeners.delete(l);
  }

  /**
   * Researcher command (world scope, ADR-0015 addition of 2026-10-12): one of goTo, takeoff, land, explore, hold, with
   * that action's parameters. The worker refuses names outside the closed set; preconditions are checked when the
   * action starts, and a refusal arrives as an `injected` trace record carrying its code.
   */
  command(agentId: string, op: string, params?: Record<string, number | string | boolean>): void {
    this.post({ type: "command", op, agentId, ...(params ? { params } : {}) });
  }

  private readonly streams = new Map<string, Set<(m: never) => void>>();

  /**
   * Panel streams (the viewed agent's decision request, researcher data, overlays): the lazily loaded panels that
   * use them subscribe to the message kinds the shell itself does not handle, and ask the worker for them with `send`,
   * so none of that code is in the initial chunk (ADR-0019 addition of 2026-10-12).
   */
  subscribe<T extends SimToMain["type"]>(type: T, l: (m: Extract<SimToMain, { type: T }>) => void): () => void {
    const set = this.streams.get(type) ?? new Set();
    this.streams.set(type, set);
    set.add(l as (m: never) => void);
    return () => set.delete(l as (m: never) => void);
  }

  /** Sends a message to the worker on behalf of a panel stream (never a run input: those go through `command`). */
  send(m: Extract<MainToSim, { type: "view" | "researcherWatch" | "beliefWatch" | "overlayWatch" }>): void {
    this.post(m);
  }

  /** Trace records of the loaded run received so far (bounded). */
  records(): readonly TraceRecord[] {
    return this.recordList;
  }

  /** Called when records arrive or a new run is loaded (≤ 10 Hz). */
  onRecords(l: () => void): () => void {
    this.recordListeners.add(l);
    return () => this.recordListeners.delete(l);
  }

  setTickRate(tickRateHz: number): void {
    this.post({ type: "control", op: "setTickRate", tickRateHz });
    this.interpolator.resetEstimate();
    this.snap = { ...this.snap, tickRateHz };
  }

  setMode(mode: TimeMode): void {
    this.post({ type: "control", op: "setMode", mode });
    this.interpolator.resetEstimate();
    this.snap = { ...this.snap, mode };
  }

  dispose(): void {
    this.worker.terminate();
  }
}
