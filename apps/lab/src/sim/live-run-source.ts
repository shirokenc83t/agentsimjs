import type { SimStrategyTestMessage, SimStrategyTestResultMessage, SimToMain } from "@agentsim/core";
import type { PersistedHeadMessage, QuotaMessage } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import type { ChunkQueue } from "@agentsim/ui";
import { filterRecords, latestPlans, type CellView, type PanelWatch, type PlannedPath, type RecordQuery, type RunFeature, type RunPoses, type RunSnapshot, type RunSource, type RunStats } from "./run-source.ts";
import type { SimClient, SimSnapshot } from "./sim-client.ts";
import type { ExecutedPath } from "./trail-store.ts";

/** Where the live source hears the storage worker's persisted head (the storage client's recording feed). */
export interface PersistedHeadFeed {
  onRecording(listener: (m: PersistedHeadMessage | QuotaMessage) => void): () => void;
}

/**
 * The run source of the run in the sim worker: a thin wrapper over the `SimClient` with no behaviour of its own, so every panel
 * that reads it shows what it showed when it read the client. Adds the persisted head from the storage worker next to the sim head.
 */
export class LiveRunSource implements RunSource {
  readonly mode = "live" as const;
  readonly poses: RunPoses;
  private persisted: { readonly runId: string; readonly tick: number } | undefined;
  private readonly headListeners = new Set<() => void>();
  private cached: { readonly sim: SimSnapshot; readonly persistedTick: number | undefined; readonly view: RunSnapshot } | undefined;
  /** Counts record batches and loads, so the planned paths are derived once per change. */
  private recordsVersion = 0;
  private plans: { readonly version: number; readonly value: Map<string, PlannedPath> } | undefined;
  private readonly offHead: () => void;
  private readonly offRecords: () => void;

  constructor(
    private readonly sim: SimClient,
    feed?: PersistedHeadFeed,
  ) {
    const i = sim.interpolator;
    this.poses = {
      sample: (nowMs) => i.sample(nowMs),
      get entityCount() {
        return i.entityCount;
      },
      latest: () => i.latest(),
      get intervalEstimateMs() {
        return i.intervalEstimateMs;
      },
      setInterpolation: (on) => i.setEnabled(on),
    };
    this.offRecords = sim.onRecords(() => this.recordsVersion++);
    this.offHead =
      feed?.onRecording((m) => {
        if (m.type !== "persisted") return;
        this.persisted = { runId: m.head.runId, tick: m.head.tick };
        for (const l of this.headListeners) l();
      }) ?? (() => {});
  }

  snapshot(): RunSnapshot {
    const s = this.sim.snapshot();
    const runId = s.run?.runId;
    const persistedTick = this.persisted && this.persisted.runId === runId ? this.persisted.tick : undefined;
    // The same object while nothing changed: panels poll this at 10 Hz and re-render only on a new one.
    if (this.cached && this.cached.sim === s && this.cached.persistedTick === persistedTick) return this.cached.view;
    const view: RunSnapshot = {
      mode: "live",
      ready: s.ready,
      run: s.run,
      runId,
      entityIds: s.entityIds,
      tick: s.tick,
      simTimeS: s.simTimeS,
      agentStatus: s.agentStatus,
      grid: s.grid,
      error: s.error,
      simHeadTick: s.tick,
      persistedHeadTick: persistedTick,
    };
    this.cached = { sim: s, persistedTick, view };
    return view;
  }

  stats(): RunStats {
    const s = this.sim.snapshot();
    return {
      simTickRateHz: s.tickRateHz,
      simTicksPerSecond: s.ticksPerSecond,
      simTickP95Ms: s.tickTimeP95Ms,
      stateLatencyP95Ms: this.sim.stateLatencyMs.percentile(0.95),
      interpolationIntervalMs: this.sim.interpolator.intervalEstimateMs,
      entities: this.sim.interpolator.entityCount,
    };
  }

  unavailable(_feature: RunFeature): string | undefined {
    return undefined;
  }

  cellAt(i: number, j: number): CellView | undefined {
    return this.sim.cellAt(i, j);
  }

  pose(index: number): { x: number; y: number; z: number; headingRad: number } | undefined {
    return this.sim.pose(index);
  }

  records(): readonly TraceRecord[] {
    return this.sim.records();
  }

  onRecords(l: () => void): () => void {
    return this.sim.onRecords(l);
  }

  queryRecords(q: RecordQuery): Promise<readonly TraceRecord[]> {
    return Promise.resolve(filterRecords(this.sim.records(), q));
  }

  plannedPaths(): ReadonlyMap<string, PlannedPath> {
    // Recomputed only when records arrived or a run was loaded.
    if (this.plans && this.plans.version === this.recordsVersion) return this.plans.value;
    const value = latestPlans(this.sim.records());
    this.plans = { version: this.recordsVersion, value };
    return value;
  }

  executedPath(agentId: string): ExecutedPath {
    return this.sim.executedPath(agentId);
  }

  onTrail(l: () => void): () => void {
    return this.sim.onTrail(l);
  }

  watchBelief(runId: string, agentId: string, queue: ChunkQueue): () => void {
    const stop = this.sim.subscribe("beliefChunks", (m) => {
      if (m.runId === runId && m.agentId === agentId) queue.push(m.coords, m.data);
    });
    this.sim.send({ type: "beliefWatch", agentId });
    return () => {
      stop();
      this.sim.send({ type: "beliefWatch", agentId: null });
    };
  }

  subscribe<T extends SimToMain["type"]>(type: T, l: (m: Extract<SimToMain, { type: T }>) => void): () => void {
    return this.sim.subscribe(type, l);
  }

  send(m: PanelWatch): void {
    this.sim.send(m);
  }

  command(agentId: string, op: string, params?: Record<string, number | string | boolean>): void {
    this.sim.command(agentId, op, params);
  }

  strategyTest(req: Omit<SimStrategyTestMessage, "type" | "requestId">): Promise<SimStrategyTestResultMessage> {
    return this.sim.strategyTest(req);
  }

  onHead(l: () => void): () => void {
    this.headListeners.add(l);
    return () => this.headListeners.delete(l);
  }

  dispose(): void {
    this.offHead();
    this.offRecords();
    this.headListeners.clear();
  }
}
