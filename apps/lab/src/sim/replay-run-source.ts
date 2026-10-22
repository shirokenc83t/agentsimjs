import { TRAIL_MAX_POINTS, TRAIL_STRIDE, STATUS_STRIDE, err, ok, type CodedError, type Result, type SimLoadedMessage, type SimStrategyTestMessage, type SimStrategyTestResultMessage, type SimToMain } from "@agentsim/core";
import { poseWindowQuery, type ReplayClient, type StoragePorts } from "@agentsim/storage";
import type { RecordingProfile, TraceRecord } from "@agentsim/trace";
import { ChunkQueue, type GridSpec } from "@agentsim/ui";
import { filterRecords, latestPlans, type CellView, type PanelWatch, type PlannedPath, type RecordQuery, type RunFeature, type RunPoses, type RunSnapshot, type RunSource, type RunStats } from "./run-source.ts";
import type { ExecutedPath } from "./trail-store.ts";

// The run source of a recorded run (ADR-0016, ADR-0019 and ADR-0035 additions of 2026-10-17, item 9): everything a panel shows comes from storage, at the time
// cursor, and nothing goes to the sim worker (this class holds no sim client: there is nothing to send to). Poses are samples, interpolated between them;
// records are read forward as the cursor moves and cut back when it goes back; belief maps are rebuilt in the storage worker. Nothing on the render path
// waits for a query: the renderer asks `poses.sample` each frame, which reads what is loaded, and a jump brings its window in the background.

/** Where the cursor is (sim seconds) and how to hear that it moved. The UI context in the app; a stand-in in tests. */
export interface CursorPort {
  get(): number;
  subscribe(l: () => void): () => void;
}

export interface ReplayDeps {
  readonly runId: string;
  readonly ports: Pick<StoragePorts, "runs" | "trace">;
  readonly replay: ReplayClient;
  readonly cursor: CursorPort;
  /** Panel refresh rate bound in ms (the cursor can move at frame rate; panels see it at ≤ 10 Hz). */
  readonly refreshMs?: number;
  /**
   * For a run that is still recording and being scrubbed: the persisted head in sim seconds (it grows as the storage worker flushes) and how to hear it grow,
   * and the sim's own head (tick). Without them the end of the recording is what is stored when the run is opened.
   */
  readonly head?: { get(): number; subscribe(l: () => void): () => void };
  readonly simHeadTick?: () => number;
}

export type ReplayOpenError = CodedError<"unknown_run" | "not_recorded" | "no_scenario" | "world_failed" | "no_agents">;

/** One pose sample as stored: where an agent was and what its body reported. */
interface Sample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly speed: number;
  readonly soc: number;
  readonly odometerM: number;
  readonly airborne: boolean;
}

/** Sim times are sums of ticks, a cursor is a tick times the tick period: a sample or a record at the cursor's tick is at the cursor, up to float noise. */
const TIME_EPS = 1e-6;
const PAGE = 10_000;
/** Poses are kept for this window of sim time around the cursor: behind it for the executed path, ahead of it for interpolation. */
const POSE_BEHIND_S = 120;
const POSE_AHEAD_S = 30;
/** When the cursor comes within this of the end of what is loaded ahead, the next stretch is read. */
const POSE_REFILL_S = 8;
/** Records kept on the main thread, like the live source's window. */
const MAX_RECORDS = 50_000;
/** The first read of a belief map brings this many of the groups nearest the middle, the second the rest. */
const FIRST_GROUPS = 4;

const BODY_ONLY = { exclude: [{ owner: null, component: "body" }] } as const;

/** A step is a jump (a teleport, a restart of a body) when the agent moved farther than it could have in the time between the samples. */
export function isJump(a: Sample, b: Sample): boolean {
  const dt = b.t - a.t;
  const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const reach = Math.max(a.speed, b.speed) * dt * 3 + 2;
  return dist > reach;
}

const wrapAngle = (d: number) => d - Math.round(d / (2 * Math.PI)) * 2 * Math.PI;

/** The pose rate the recording profile says, for the UI: poses are samples, not every tick. */
export function describePoseRate(profile: unknown): string {
  const poses = (profile as Partial<RecordingProfile> | undefined)?.channels?.poses as { rateHz?: number; perKindRateHz?: Record<string, number> } | undefined;
  if (!poses || poses.rateHz === undefined) return "pose samples at the rate of the recording profile";
  const kinds = poses.perKindRateHz ? Object.entries(poses.perKindRateHz).map(([k, v]) => `${k} ${v} Hz`).join(", ") : "";
  return `poses are samples at ${poses.rateHz} Hz${kinds ? ` (${kinds})` : ""} and where an action starts or ends, interpolated between them`;
}

class ReplayPoses implements RunPoses {
  private out = new Float32Array(0);
  interpolate = true;

  constructor(private readonly source: ReplayRunSource) {}

  get entityCount(): number {
    return this.source.entityIds.length;
  }

  readonly intervalEstimateMs = Number.NaN;

  sample(_nowMs: number): Float32Array {
    // Read at frame rate from what is loaded; the cursor is read imperatively (no React in between).
    const n = this.source.entityIds.length;
    if (this.out.length !== n * 4) this.out = new Float32Array(n * 4);
    this.source.writePoses(this.out, this.source.cursorNow(), this.interpolate);
    return this.out;
  }

  latest(): Float32Array {
    const n = this.source.entityIds.length;
    const out = new Float32Array(n * 4);
    this.source.writePoses(out, this.source.cursorNow(), false);
    return out;
  }

  setInterpolation(on: boolean): void {
    this.interpolate = on;
  }
}

export class ReplayRunSource implements RunSource {
  readonly mode = "replay" as const;
  readonly poses: RunPoses;
  readonly entityIds: readonly string[];
  /** What the UI says about the pose rate of this recording. */
  readonly poseRate: string;
  private readonly samples = new Map<string, Sample[]>();
  /** Sim-time range of the poses loaded for every agent: [from, to]. */
  private loadedFrom = Number.NaN;
  private loadedTo = Number.NaN;
  private recordList: TraceRecord[] = [];
  private recordsThroughSeq = -1;
  private recordsLoadedTo = 0;
  private recordsAtEnd = false;
  private headS = 0;
  private version = 0;
  private cached: { readonly key: string; readonly view: RunSnapshot } | undefined;
  private plans: { readonly version: number; readonly value: Map<string, PlannedPath> } | undefined;
  private recordsVersion = 0;
  private readonly recordListeners = new Set<() => void>();
  private readonly trailListeners = new Set<() => void>();
  private readonly headListeners = new Set<() => void>();
  private readonly trailIndex: Map<string, number>;
  private readonly trails = new Map<string, { points: Float32Array; count: number; version: number; at: number }>();
  private status = new Float32Array(0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRun = 0;
  private generation = 0;
  private running = 0;
  private disposed = false;
  private readonly offCursor: () => void;
  private readonly offHead: () => void;
  private readonly watchers = new Set<() => void>();
  private chunkViews = new Map<number, Uint8Array>();
  private defaultObstacleHeightM: number | undefined;

  constructor(
    private readonly deps: ReplayDeps,
    readonly run: SimLoadedMessage,
    readonly grid: GridSpec,
    truth: { coords: Uint16Array; data: Uint8Array; defaultObstacleHeightM: number | undefined },
    poseRate: string,
    headS: number,
  ) {
    this.entityIds = run.agents.map((a) => a.id);
    this.trailIndex = new Map(this.entityIds.map((id, i) => [id, i]));
    this.poseRate = poseRate;
    this.headS = headS;
    this.defaultObstacleHeightM = truth.defaultObstacleHeightM;
    for (const id of this.entityIds) this.samples.set(id, []);
    this.status = new Float32Array(this.entityIds.length * STATUS_STRIDE);
    this.poses = new ReplayPoses(this);
    // The truth chunks, once: the atlas queue and the cell view.
    const bytes = truth.data.length / Math.max(1, truth.coords.length / 2);
    const chunksX = Math.ceil(grid.dims.sizeX / grid.dims.chunkSize);
    for (let k = 0; k < truth.coords.length / 2; k++) this.chunkViews.set((truth.coords[k * 2 + 1] ?? 0) * chunksX + (truth.coords[k * 2] ?? 0), truth.data.subarray(k * bytes, (k + 1) * bytes));
    grid.queue.push(truth.coords, truth.data);
    this.offCursor = deps.cursor.subscribe(() => this.schedule());
    // A run that is still recording: its end moves as the storage worker saves more.
    if (deps.head) this.headS = Math.max(this.headS, deps.head.get());
    this.offHead = deps.head
      ? deps.head.subscribe(() => {
          const h = deps.head?.get() ?? 0;
          if (h <= this.headS) return;
          this.headS = h;
          this.version++;
          for (const l of this.headListeners) l();
          this.schedule();
        })
      : () => {};
    this.schedule(true);
  }

  cursorNow(): number {
    return Math.max(0, Math.min(this.headS, this.deps.cursor.get()));
  }

  /** The last sim time the recording has, in seconds. */
  get headSeconds(): number {
    return this.headS;
  }

  /** Resolves once the cursor's last move has been read in (tests; the UI never waits for it). */
  async settled(): Promise<void> {
    while (this.timer !== undefined || this.running > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // ---- loading, off the render path -----------------------------------------------------------------------------------------------------

  private schedule(now = false): void {
    if (this.disposed) return;
    const wait = this.deps.refreshMs ?? 100;
    const since = performance.now() - this.lastRun;
    if (now || since >= wait) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.refresh();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.refresh();
      }, wait - since);
    }
  }

  /** Brings what the panels read up to the cursor: records, the pose window, the trails and the status block; then tells the listeners. */
  private async refresh(): Promise<void> {
    const mine = ++this.generation;
    this.lastRun = performance.now();
    const t = this.cursorNow();
    this.running++;
    try {
      await this.loadRecordsTo(t, mine);
      await this.loadPosesAround(t, mine);
    } catch {
      return; // a failed read leaves what was loaded; the next move tries again
    } finally {
      this.running--;
    }
    if (this.disposed || mine !== this.generation) return;
    this.rebuild(t);
    this.version++;
    this.recordsVersion++;
    for (const l of this.recordListeners) l();
    for (const l of this.trailListeners) l();
    for (const w of this.watchers) w();
  }

  private async loadRecordsTo(t: number, mine: number): Promise<void> {
    // Going back: records after the cursor are cut (they are in seq order, so in sim-time order).
    if (t < this.recordsLoadedTo) {
      let keep = this.recordList.length;
      while (keep > 0 && (this.recordList[keep - 1] as TraceRecord).simTime > t + TIME_EPS) keep--;
      this.recordList.length = keep;
      this.recordsThroughSeq = keep > 0 ? (this.recordList[keep - 1] as TraceRecord).seq : -1;
      this.recordsLoadedTo = t;
      this.recordsAtEnd = false;
      if (keep === 0) this.recordsThroughSeq = -1;
    }
    for (;;) {
      const page = await this.deps.ports.trace.query({ runId: this.deps.runId, afterSeq: this.recordsThroughSeq, limit: PAGE, simTime: { to: t + TIME_EPS }, source: BODY_ONLY });
      if (this.disposed || mine !== this.generation) return;
      for (const r of page) this.recordList.push(r);
      if (page.length > 0) this.recordsThroughSeq = (page[page.length - 1] as TraceRecord).seq;
      if (page.length < PAGE) break;
    }
    this.recordsLoadedTo = t;
    if (this.recordList.length > MAX_RECORDS) this.recordList = this.recordList.slice(-MAX_RECORDS);
  }

  private async loadPosesAround(t: number, mine: number): Promise<void> {
    const wantFrom = Math.max(0, t - POSE_BEHIND_S);
    // Never past the end of what is stored (the persisted head, for a run that is still recording): nothing is asked for a moment that is not there.
    const wantTo = Math.min(t + POSE_AHEAD_S, this.headS);
    const inside = !Number.isNaN(this.loadedFrom) && t >= this.loadedFrom && t <= this.loadedTo;
    if (inside && (this.loadedTo - t >= POSE_REFILL_S || wantTo <= this.loadedTo)) return;
    // Outside the window (a jump): a fresh window around the cursor. Near its end: the next stretch is added to it.
    const fresh = !inside;
    const from = fresh ? wantFrom : this.loadedTo;
    const loaded = new Map<string, Sample[]>();
    for (const id of this.entityIds) loaded.set(id, []);
    let after: number | undefined;
    for (;;) {
      const q = poseWindowQuery({ runId: this.deps.runId, from, to: wantTo, limit: PAGE, ...(after === undefined ? {} : { afterSeq: after }) });
      const page = await this.deps.ports.trace.query(q);
      if (this.disposed || mine !== this.generation) return;
      for (const r of page) {
        const list = loaded.get(r.agentId ?? "");
        if (!list) continue;
        const p = r.payload as { x: number; y: number; z: number; heading: number; speedMps: number; soc: number; odometerM: number; airborne: boolean };
        list.push({ t: r.simTime, x: p.x, y: p.y, z: p.z, heading: p.heading, speed: p.speedMps, soc: p.soc, odometerM: p.odometerM, airborne: p.airborne });
      }
      if (page.length < PAGE) break;
      after = (page[page.length - 1] as TraceRecord).seq;
    }
    if (fresh) {
      for (const [id, list] of loaded) this.samples.set(id, list);
      this.loadedFrom = from;
    } else {
      for (const [id, list] of loaded) {
        const have = this.samples.get(id) ?? [];
        const last = have[have.length - 1]?.t ?? Number.NEGATIVE_INFINITY;
        for (const s of list) if (s.t > last) have.push(s);
        // The window behind the cursor is bounded too.
        const cut = have.findIndex((s) => s.t >= t - POSE_BEHIND_S);
        this.samples.set(id, cut > 0 ? have.slice(cut) : have);
      }
      this.loadedFrom = Math.max(this.loadedFrom, t - POSE_BEHIND_S);
    }
    this.loadedTo = wantTo;
  }

  /** The trails, the status block: from the samples at or before the cursor. */
  private rebuild(t: number): void {
    this.entityIds.forEach((id, i) => {
      const list = this.samples.get(id) ?? [];
      const at = lastAtOrBefore(list, t);
      const s = list[at];
      if (s) {
        this.status[i * STATUS_STRIDE] = s.soc;
        this.status[i * STATUS_STRIDE + 1] = s.speed;
        this.status[i * STATUS_STRIDE + 2] = s.odometerM;
        this.status[i * STATUS_STRIDE + 3] = s.airborne ? 1 : 0;
      }
      const old = this.trails.get(id);
      if (old && old.at === at) return;
      const from = Math.max(0, at + 1 - TRAIL_MAX_POINTS);
      const count = Math.max(0, at + 1 - from);
      const points = old && old.points.length >= count * TRAIL_STRIDE ? old.points : new Float32Array(TRAIL_MAX_POINTS * TRAIL_STRIDE);
      for (let k = 0; k < count; k++) {
        const p = list[from + k] as Sample;
        points[k * TRAIL_STRIDE] = p.x;
        points[k * TRAIL_STRIDE + 1] = p.y;
        points[k * TRAIL_STRIDE + 2] = p.z;
      }
      this.trails.set(id, { points, count, version: (old?.version ?? 0) + 1, at });
    });
  }

  /** Poses at `t`: exact at a sample, blended between two samples, held across a jump (no smoothing across it); before the first sample, the first. */
  writePoses(out: Float32Array, t: number, interpolate: boolean): void {
    this.entityIds.forEach((id, i) => {
      const list = this.samples.get(id) ?? [];
      const o = i * 4;
      if (list.length === 0) return;
      const k = lastAtOrBefore(list, t);
      const a = list[Math.max(0, k)] as Sample;
      const b = list[k + 1];
      let x = a.x;
      let y = a.y;
      let z = a.z;
      let h = a.heading;
      if (interpolate && k >= 0 && b && b.t > a.t && t > a.t && !isJump(a, b)) {
        const f = (t - a.t) / (b.t - a.t);
        x = a.x + (b.x - a.x) * f;
        y = a.y + (b.y - a.y) * f;
        z = a.z + (b.z - a.z) * f;
        h = a.heading + wrapAngle(b.heading - a.heading) * f;
      }
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      out[o + 3] = h;
    });
  }

  // ---- RunSource -------------------------------------------------------------------------------------------------------------------------

  snapshot(): RunSnapshot {
    const t = this.cursorNow();
    const simHead = this.deps.simHeadTick?.();
    const key = `${this.version}/${t}/${simHead ?? ""}`;
    if (this.cached?.key === key) return this.cached.view;
    const dt = this.run.dtS;
    const view: RunSnapshot = {
      mode: "replay",
      ready: true,
      run: this.run,
      runId: this.deps.runId,
      entityIds: this.entityIds,
      tick: Math.round(t / dt),
      simTimeS: t,
      agentStatus: this.status.slice(),
      grid: this.grid,
      error: null,
      simHeadTick: Math.max(Math.round(this.headS / dt), simHead ?? 0),
      persistedHeadTick: Math.round(this.headS / dt),
      replay: { poseRate: this.poseRate, headS: this.headS, ...(simHead === undefined ? {} : { simHeadS: Math.max(this.headS, simHead * dt) }) },
    };
    this.cached = { key, view };
    return view;
  }

  stats(): RunStats {
    return { simTickRateHz: 0, simTicksPerSecond: 0, simTickP95Ms: 0, stateLatencyP95Ms: 0, interpolationIntervalMs: Number.NaN, entities: this.entityIds.length };
  }

  unavailable(feature: RunFeature): string | undefined {
    switch (feature) {
      case "commands":
        return "a recording cannot be commanded";
      case "strategyTest":
        return "the Strategy test plans on the live map of a running world";
      case "mindView":
        return "the decision request of a mind is not part of a recording";
      case "researcher":
        return "beliefs versus truth is computed from the live run";
      case "cellBeliefs":
        return "what every agent believes of a cell is read from the live run's maps, which a recording does not hold";
      case "rays":
        return "lidar rays are not recorded";
      case "topology":
        return "regions and frontier groups are not recorded";
    }
  }

  cellAt(i: number, j: number): CellView | undefined {
    const g = this.grid.dims;
    if (i < 0 || j < 0 || i >= g.sizeX || j >= g.sizeY) return undefined;
    const n = g.chunkSize;
    const ci = Math.floor(i / n);
    const cj = Math.floor(j / n);
    const view = this.chunkViews.get(cj * Math.ceil(g.sizeX / n) + ci);
    if (!view) return undefined;
    const k = ((j - cj * n) * n + (i - ci * n)) * 4;
    return { occupancy: view[k] ?? 0, terrainCost: view[k + 1] ?? 0, heightDm: (view[k + 2] ?? 0) | ((view[k + 3] ?? 0) << 8), defaultObstacleHeightM: this.defaultObstacleHeightM };
  }

  pose(index: number): { x: number; y: number; z: number; headingRad: number } | undefined {
    if (index < 0 || index >= this.entityIds.length) return undefined;
    const out = new Float32Array(this.entityIds.length * 4);
    this.writePoses(out, this.cursorNow(), (this.poses as ReplayPoses).interpolate);
    const o = index * 4;
    return { x: out[o] ?? 0, y: out[o + 1] ?? 0, z: out[o + 2] ?? 0, headingRad: out[o + 3] ?? 0 };
  }

  records(): readonly TraceRecord[] {
    return this.recordList;
  }

  onRecords(l: () => void): () => void {
    this.recordListeners.add(l);
    return () => this.recordListeners.delete(l);
  }

  queryRecords(q: RecordQuery): Promise<readonly TraceRecord[]> {
    return Promise.resolve(filterRecords(this.recordList, q));
  }

  plannedPaths(): ReadonlyMap<string, PlannedPath> {
    if (this.plans && this.plans.version === this.recordsVersion) return this.plans.value;
    const value = latestPlans(this.recordList);
    this.plans = { version: this.recordsVersion, value };
    return value;
  }

  executedPath(agentId: string): ExecutedPath {
    const tr = this.trails.get(agentId);
    if (!tr || !this.trailIndex.has(agentId)) return { points: new Float32Array(0), count: 0, version: 0 };
    return { points: tr.points.subarray(0, tr.count * TRAIL_STRIDE), count: tr.count, version: tr.version };
  }

  onTrail(l: () => void): () => void {
    this.trailListeners.add(l);
    return () => this.trailListeners.delete(l);
  }

  /** The agent's belief map at the cursor's tick, from storage: the nearest groups first, then the rest; chunks that are no longer known are blanked. */
  watchBelief(runId: string, agentId: string, queue: ChunkQueue): () => void {
    if (runId !== this.deps.runId) return () => {};
    let delivered = -1;
    let shown = new Set<number>();
    let mine = 0;
    const chunksX = Math.ceil(this.grid.dims.sizeX / this.grid.dims.chunkSize);
    const bytes = this.grid.dims.chunkSize ** 2;
    const push = (coords: Uint16Array, data: Uint8Array, seen: Set<number>) => {
      queue.push(coords, data);
      for (let i = 0; i < coords.length / 2; i++) seen.add((coords[i * 2 + 1] ?? 0) * chunksX + (coords[i * 2] ?? 0));
    };
    const request = async () => {
      const tick = Math.round(this.cursorNow() / this.run.dtS);
      if (tick === delivered) return;
      const id = ++mine;
      const seen = new Set<number>();
      // The nearest keyframe overlay at once (no deltas to apply: the cheapest read), then the same groups as they are at the tick, then the rest.
      const coarse = await this.deps.replay.beliefAt(runId, agentId, tick, { limit: FIRST_GROUPS, keyframeOnly: true });
      if (id !== mine) return;
      if (coarse.ok) push(coarse.value.coords, coarse.value.data, seen);
      const first = await this.deps.replay.beliefAt(runId, agentId, tick, { limit: FIRST_GROUPS });
      if (id !== mine || !first.ok) return;
      push(first.value.coords, first.value.data, seen);
      if (first.value.groups.to < first.value.groups.total) {
        const rest = await this.deps.replay.beliefAt(runId, agentId, tick, { skip: first.value.groups.to });
        if (id !== mine || !rest.ok) return;
        push(rest.value.coords, rest.value.data, seen);
      }
      // Chunks the map had at the previous tick and has not now (the cursor went back before they were observed) go back to unknown.
      const gone = [...shown].filter((k) => !seen.has(k));
      if (gone.length > 0) {
        const coords = new Uint16Array(gone.length * 2);
        gone.forEach((k, i) => {
          coords[i * 2] = k % chunksX;
          coords[i * 2 + 1] = Math.floor(k / chunksX);
        });
        queue.push(coords, new Uint8Array(gone.length * bytes));
      }
      shown = seen;
      delivered = tick;
    };
    const w = () => void request();
    this.watchers.add(w);
    void request();
    return () => {
      mine++;
      this.watchers.delete(w);
    };
  }

  subscribe<T extends SimToMain["type"]>(_type: T, _l: (m: Extract<SimToMain, { type: T }>) => void): () => void {
    return () => {};
  }

  send(_m: PanelWatch): void {}

  command(): void {}

  strategyTest(_req: Omit<SimStrategyTestMessage, "type" | "requestId">): Promise<SimStrategyTestResultMessage> {
    return Promise.reject(new Error(this.unavailable("strategyTest")));
  }

  onHead(l: () => void): () => void {
    this.headListeners.add(l);
    return () => this.headListeners.delete(l);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.offCursor();
    this.offHead();
    this.recordListeners.clear();
    this.trailListeners.clear();
    this.headListeners.clear();
    this.watchers.clear();
  }
}

/** Index of the last sample at or before `t` (−1 before the first), by binary search. */
function lastAtOrBefore(list: readonly Sample[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Sample).t <= t + TIME_EPS) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The sim time of a run's last record: the end of what can be replayed. Galloping from the record count (seqs can skip when a profile drops records). */
async function headOf(ports: Pick<StoragePorts, "trace">, runId: string): Promise<number> {
  const count = await ports.trace.count(runId);
  let after = Math.max(-1, count - 2);
  let last = 0;
  for (;;) {
    const page = await ports.trace.query({ runId, afterSeq: after, limit: PAGE });
    for (const r of page) last = Math.max(last, r.simTime);
    if (page.length < PAGE) return last;
    after = (page[page.length - 1] as TraceRecord).seq;
  }
}

/**
 * Opens a recorded run for replay: its header, the agents from their `config` records, the world (rebuilt in the storage worker from the stored scenario
 * version) and the end of the recording. A run that was not recorded cannot be replayed, and says why.
 */
export async function openReplaySource(deps: ReplayDeps): Promise<Result<ReplayRunSource, ReplayOpenError>> {
  const header = await deps.ports.runs.get(deps.runId);
  if (!header) return err({ code: "unknown_run", message: `unknown run ${deps.runId}` });
  if (header.recording !== "stored") return err({ code: "not_recorded", message: header.recording === "none" ? "this run was not recorded (recording was switched off for it)" : "this run was stored before recording existed: it holds no poses or belief maps to replay" });
  const configs = await deps.ports.trace.query({ runId: deps.runId, kinds: ["lifecycle"], op: "config", limit: 4096 });
  if (configs.length === 0) return err({ code: "no_agents", message: "the run holds no agent configuration records" });
  const world = await deps.replay.world(deps.runId);
  if (!world.ok) return err({ code: "world_failed", message: world.error.message });
  const w = world.value;
  const agents = configs.map((r) => {
    const p = r.payload as { key?: string; body?: unknown; beliefs?: { idealized?: boolean } } & Record<string, unknown>;
    const id = r.agentId ?? "";
    const { op: _op, key: _key, ...config } = p as Record<string, unknown>;
    return { id, ...(p.key === undefined ? {} : { key: p.key }), kind: id.startsWith("uav") ? ("uav" as const) : ("ugv" as const), body: p.body, config };
  });
  const dtS = await dtOf(deps);
  const ideal = header.idealAgents ?? agents.filter((a) => (a.config["beliefs"] as { idealized?: boolean } | undefined)?.idealized === true).map((a) => a.id).sort();
  const run: SimLoadedMessage = {
    type: "loaded",
    runId: deps.runId,
    scenarioId: header.scenarioId ?? "",
    scenarioVersion: header.scenarioVersion ?? 1,
    seed: header.seed ?? 0,
    timeMode: "lockstep",
    runConfigHash: header.runConfigHash ?? "00000000",
    effectiveConfigHash: header.effectiveConfigHash ?? "00000000",
    idealAgents: ideal,
    dtS,
    defaultSeed: header.seed ?? 0,
    worldHash: "00000000",
    agents,
  };
  const dims = { sizeX: w.sizeX, sizeY: w.sizeY, chunkSize: w.chunkSize, resolutionM: w.resolutionM };
  const grid: GridSpec = { dims, zones: w.zones.map((z) => ({ id: z.id, kind: z.kind, polygon: [...z.polygon] })) as GridSpec["zones"], queue: new ChunkQueue(Math.ceil(w.sizeX / w.chunkSize), true) };
  const head = await headOf(deps.ports, deps.runId);
  return ok(new ReplayRunSource(deps, run, grid, { coords: w.coords, data: w.data, defaultObstacleHeightM: w.defaultObstacleHeightM }, describePoseRate(header.recordingProfile), head));
}

/** The tick period of the run: from its first checkpoint record (tick and sim time), else the lab's 10 Hz. */
async function dtOf(deps: ReplayDeps): Promise<number> {
  const cps = await deps.ports.trace.query({ runId: deps.runId, kinds: ["event"], op: "checkpoint", limit: 4 });
  for (const r of cps) {
    const tick = (r.payload as { tick?: number }).tick;
    if (typeof tick === "number" && tick > 0 && r.simTime > 0) return r.simTime / tick;
  }
  return 0.1;
}
