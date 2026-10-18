import type { SimLoadedMessage, SimStrategyTestMessage, SimStrategyTestResultMessage, SimToMain } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import type { ChunkQueue, GridSpec, PoseSource, RunViewMode } from "@agentsim/ui";
import type { SimClient } from "./sim-client.ts";
import type { ExecutedPath } from "./trail-store.ts";

/**
 * The run source (ADR-0016, ADR-0019 additions of 2026-10-17): the one interface the Scene, Explorer, Inspector and their
 * overlays read a run from. The live implementation wraps the `SimClient` (the run in the sim worker); the replay
 * implementation (F3a M3) reads a recorded run from storage and never touches the sim worker. Panels consume this, not the
 * client: what a panel shows does not depend on where the run comes from. Run control (play, pause, step, load) is not part
 * of it: it belongs to the live run only and stays on the client.
 */

/** Poses as the renderer samples them, plus what the HUD and the Inspector read of them. */
export interface RunPoses extends PoseSource {
  /** The latest whole state (not interpolated): view, valid until the next state. */
  latest(): Float32Array;
  /** Measured interval between received states in ms (NaN until known); replay has none. */
  readonly intervalEstimateMs: number;
  /** The HUD's "interpolation" switch. */
  setInterpolation(on: boolean): void;
}

/** What the panels show of the run at the cursor (live: the sim head), read at ≤ 10 Hz. */
export interface RunSnapshot {
  readonly mode: RunViewMode;
  readonly ready: boolean;
  /** The loaded run as the worker described it (live) or as its recording does (replay); undefined with no run. */
  readonly run: SimLoadedMessage | undefined;
  readonly runId: string | undefined;
  /** Entity IDs by pose index. */
  readonly entityIds: readonly string[];
  /** The tick shown: the sim head live, the cursor's tick in replay. */
  readonly tick: number;
  readonly simTimeS: number;
  /** Latest per-agent status block (`STATUS_STRIDE` floats per entity). */
  readonly agentStatus: Float32Array | undefined;
  readonly grid: GridSpec | undefined;
  readonly error: string | null;
  /** The newest tick the run has reached: the sim's own head live, the recording's last tick in replay. */
  readonly simHeadTick: number;
  /** The newest tick stored for this run (live: from the storage worker; undefined until it reported one or when the run is not recorded). */
  readonly persistedHeadTick: number | undefined;
  /** In replay: what the UI tells about the recording (how poses were sampled) and where it ends. */
  readonly replay?: {
    readonly poseRate: string;
    /** The end of what can be shown: the end of the recording, or the persisted head of a run that is still recording. */
    readonly headS: number;
    /** The live run being scrubbed (the sim is ahead of what is saved): the sim head in seconds; undefined for a recording that is only read. */
    readonly simHeadS?: number;
  };
}

/** Figures of the Performance HUD; the sim ones are the live run's and read 0 in replay. */
export interface RunStats {
  readonly simTickRateHz: number;
  readonly simTicksPerSecond: number;
  readonly simTickP95Ms: number;
  readonly stateLatencyP95Ms: number;
  readonly interpolationIntervalMs: number;
  readonly entities: number;
}

/** A page of the run's records: agent and kind filters, exclusive lower bound on `seq`, newest limit rule of the trace store. */
export interface RecordQuery {
  readonly afterSeq?: number;
  readonly limit: number;
  readonly agentId?: string;
  readonly kinds?: readonly string[];
}

/** Features of the live run that have no recorded source; a source says why one is off, or undefined when it is on. */
export type RunFeature = "commands" | "strategyTest" | "mindView" | "researcher" | "rays" | "topology";

/** The live view cell of the loaded grid (cell inspector): the layers as last received. */
export interface CellView {
  readonly occupancy: number;
  readonly terrainCost: number;
  readonly heightDm: number;
  readonly defaultObstacleHeightM: number | undefined;
}

/** A found plan per agent, from the run's `compute` records. */
export interface PlannedPath {
  readonly seq: number;
  readonly waypoints: [number, number][];
}

/** What a panel stream is asked for with (the request only, never the data that comes back): the client's `send` parameter. */
export type PanelWatch = Parameters<SimClient["send"]>[0];

export interface RunSource {
  readonly mode: RunViewMode;
  readonly poses: RunPoses;
  snapshot(): RunSnapshot;
  stats(): RunStats;
  /** The reason `feature` is off in this source (shown in the UI), or undefined when it is available. */
  unavailable(feature: RunFeature): string | undefined;

  /** The cell of the grid as last received, or undefined outside the grid or before its chunk arrived. */
  cellAt(i: number, j: number): CellView | undefined;
  /** The latest pose of an entity, not interpolated. */
  pose(index: number): { x: number; y: number; z: number; headingRad: number } | undefined;

  /** Records of the run received so far (live: bounded window; replay: the window around the cursor). */
  records(): readonly TraceRecord[];
  onRecords(l: () => void): () => void;
  /** A page of records by filter, in `seq` order; resolves with what the source holds for it. */
  queryRecords(q: RecordQuery): Promise<readonly TraceRecord[]>;
  /** The latest found plan per agent (planned paths); changes are announced by `onRecords`. */
  plannedPaths(): ReadonlyMap<string, PlannedPath>;

  /** Executed path of an agent up to the shown moment; a view valid until the next trail change. */
  executedPath(agentId: string): ExecutedPath;
  onTrail(l: () => void): () => void;

  /**
   * Feeds the agent's belief chunks (dirty ones, one agent at a time) into `queue` until the returned function is called, which
   * releases everything the source held for it (live: the worker stops the stream).
   */
  watchBelief(runId: string, agentId: string, queue: ChunkQueue): () => void;

  /** Panel streams that only the live worker has (mind view, researcher data, rays, topology, budget). */
  subscribe<T extends SimToMain["type"]>(type: T, l: (m: Extract<SimToMain, { type: T }>) => void): () => void;
  send(m: PanelWatch): void;

  /** Researcher command on one agent (world scope); live only, `unavailable("commands")` says why not otherwise. */
  command(agentId: string, op: string, params?: Record<string, number | string | boolean>): void;
  /** The researcher's "test on map"; live only. */
  strategyTest(req: Omit<SimStrategyTestMessage, "type" | "requestId">): Promise<SimStrategyTestResultMessage>;

  /** Called when the persisted or sim head changes (live) or the recording grows (replay); ≤ 10 Hz is the reader's business. */
  onHead(l: () => void): () => void;
}

/** A record filter as the trace store's agent and kind indexes apply it, over an in-memory list: pure, in `seq` order. */
export function filterRecords(list: readonly TraceRecord[], q: RecordQuery): TraceRecord[] {
  const kinds = q.kinds === undefined ? undefined : new Set(q.kinds);
  const out: TraceRecord[] = [];
  for (const r of list) {
    if (q.afterSeq !== undefined && r.seq <= q.afterSeq) continue;
    if (q.agentId !== undefined && r.agentId !== q.agentId) continue;
    if (kinds && !kinds.has(r.kind)) continue;
    out.push(r);
    if (out.length >= q.limit) break;
  }
  return out;
}

/** The latest found plan per agent from `compute` records (ADR-0004: every planning query is traced). */
export function latestPlans(records: readonly TraceRecord[]): Map<string, PlannedPath> {
  const out = new Map<string, PlannedPath>();
  for (const r of records) {
    if (r.kind !== "compute" || r.agentId === undefined) continue;
    const p = r.payload as { op?: unknown; status?: unknown; waypoints?: unknown };
    if (p.op !== "plan" || p.status !== "found" || !Array.isArray(p.waypoints)) continue;
    out.set(r.agentId, { seq: r.seq, waypoints: p.waypoints as [number, number][] });
  }
  return out;
}
