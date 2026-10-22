import {
  POSE_STRIDE,
  StateHasher,
  STATUS_STRIDE,
  type CodedError,
  type Result,
  type RunInput,
  type SimAgent,
  type SimChunksMessage,
  type SimGridMessage,
  type SimBeliefChunksMessage,
  type SimBudgetMessage,
  type SimRaysMessage,
  type SimTopologyMessage,
  type SimCellBeliefsMessage,
  type SimResearcherDataMessage,
  type SimLoadedMessage,
  type SimTrailMessage,
  type Steppable,
  type TickContext,
} from "@agentsim/core";
import { ATLAS_BYTES_PER_CELL, atlasScratch, encodeAtlasChunk, type GridSpace } from "@agentsim/spatial";
import { startStrategyTest, type StrategyTestError, type StrategyTestRequest, type StrategyTestRun, agentWarnings, checkSensorNoise, checkSensorRates, createRun, idealAgentsOf, loadScenario, parseRunConfigValue, parseScenarioValue, preparePlanning, resolveRunConfig, restoreRun, type CreatedRun, type ResolvedRunConfig } from "@agentsim/scenarios";
import { TraceBuffer, type TraceRecord } from "@agentsim/trace";
import { DUMMY_DT_S, DUMMY_ENTITY_IDS, DUMMY_POSE_FLOATS, writeDummyPoses } from "./dummy-world.ts";
import type { RecordingTarget } from "./run-recording.ts";
import { SCENARIO_DT_S } from "./sim-constants.ts";
import { TrailRecorder } from "./trail-recorder.ts";

/**
 * What the worker host drives (ADR-0019): a world stepped by the scheduler, plus the views the host
 * streams to the main thread. Two kinds: the F0 dummy world (idle, before a scenario is loaded) and a
 * scenario run (F1 e2). No simulation logic here: it adapts `World` to the host.
 */
export interface HostedWorld extends Steppable {
  readonly dtS: number;
  readonly tick: number;
  readonly simTimeS: number;
  readonly entityIds: readonly string[];
  /** Run of a scenario world; undefined for the dummy world. */
  readonly runId: string | undefined;
  /** State hash after the last tick (scenario runs only). */
  readonly stateHash: string | undefined;
  /** Decisions a mind owes before the next tick (lockstep waits for them, ADR-0003). */
  readonly outstandingCount: number;
  decide(): Promise<void>;
  writePoses(out: Float32Array): void;
  /** Per-agent status, `STATUS_STRIDE` floats each; returns false when the world has none. */
  writeStatus(out: Float32Array): boolean;
  /** Trace records appended since the previous call (for panels; persistence is the F3 recorder's job). */
  drainRecords(): TraceRecord[];
  /** The world's trace (degradations of the host's realtime driver are recorded here too, ADR-0013). */
  readonly trace: TraceBuffer;
  /** Grid metadata for the atlas (scenario runs only). */
  gridMessage(): SimGridMessage | undefined;
  /** Chunks changed since the previous call (all of them on the first call), in batches; empty if none. */
  drainChunks(): SimChunksMessage[];
  /** Executed-path points recorded from tick states since the previous call (scenario runs only). */
  drainTrail(): SimTrailMessage | undefined;
  /**
   * Records a researcher command as a run input for the next tick, or for `atTick` when re-simulating a stored
   * run (scenario runs only).
   */
  inject(cmd: { agentId: string; name: string; params: unknown }, atTick?: number): Result<RunInput, CodedError>;
  /** The decision request of an agent's mind as JSON text, without changing the run (scenario runs only). */
  mindView(agentId: string): { tick: number; pending: boolean; request: string } | undefined;
  /** Researcher-only beliefs-vs-truth metrics of an agent, without changing the run (scenario runs only). */
  researcherData(agentId: string): Omit<SimResearcherDataMessage, "type" | "runId"> | undefined;
  /** What every agent believes of one cell, without changing the run (scenario runs only). */
  cellBeliefs(i: number, j: number): Omit<SimCellBeliefsMessage, "type" | "runId"> | undefined;
  /**
   * Belief-map chunks of the watched agent that changed since the previous call (all its materialized ones when the agent
   * changed), in batches; `null` stops and forgets (scenario runs only; `ideal` agents have none: their map is the truth).
   */
  drainBeliefChunks(agentId: string | null): SimBeliefChunksMessage[];
  /**
   * The viewed agent's overlay data: its lidar rays (observation-only recorder, on only while asked) and its topological
   * layer, each only when asked and new (rays: a new reading; topology: changed). `agentId: null` stops both and forgets.
   */
  drainOverlays(w: { agentId: string | null; rays: boolean; topology: boolean }): (SimRaysMessage | SimTopologyMessage)[];
  /** The run's budget use for the HUD (sensing wall time, rays per tick, planning expansions), or none without a scenario run. */
  budget(): Omit<SimBudgetMessage, "type" | "runId"> | undefined;
  /**
   * The researcher's strategy sandbox (ADR-0037 item 16): starts a query on a copy of the agent's map or the ground truth,
   * entirely apart from the run (its own planner; no trace, no run input, no clock). The host steps it between polls.
   */
  startStrategyTest(req: StrategyTestRequest): { ok: true; value: StrategyTestRun } | { ok: false; error: StrategyTestError };
}

export class DummyHostedWorld implements HostedWorld {
  readonly trace: TraceBuffer;
  readonly dtS = DUMMY_DT_S;
  readonly entityIds = DUMMY_ENTITY_IDS;
  readonly runId = undefined;
  readonly stateHash = undefined;
  readonly outstandingCount = 0;
  tick = 0;

  constructor(nowWallMs: () => number) {
    // No run before a scenario is loaded: the live session keeps a fixed placeholder ID.
    this.trace = new TraceBuffer("run-live", nowWallMs);
  }

  get simTimeS(): number {
    return this.tick * this.dtS;
  }

  step(ctx: TickContext): void {
    this.tick = ctx.tick;
  }

  decide(): Promise<void> {
    return Promise.resolve();
  }

  writePoses(out: Float32Array): void {
    writeDummyPoses(this.tick, out.subarray(0, DUMMY_POSE_FLOATS));
  }

  writeStatus(): boolean {
    return false;
  }

  drainRecords(): TraceRecord[] {
    return [];
  }

  gridMessage(): undefined {
    return undefined;
  }

  drainChunks(): SimChunksMessage[] {
    return [];
  }

  drainTrail(): undefined {
    return undefined;
  }

  mindView(): undefined {
    return undefined;
  }

  researcherData(): undefined {
    return undefined;
  }

  cellBeliefs(): undefined {
    return undefined;
  }

  drainBeliefChunks(): SimBeliefChunksMessage[] {
    return [];
  }

  drainOverlays(): [] {
    return [];
  }

  budget(): undefined {
    return undefined;
  }

  startStrategyTest(): { ok: false; error: StrategyTestError } {
    return { ok: false, error: { code: "no_run", message: "load a scenario run before testing a strategy" } };
  }

  inject(): Result<RunInput, CodedError> {
    return { ok: false, error: { code: "no_run", message: "load a scenario run before sending commands" } };
  }
}

export { SCENARIO_DT_S };
/** In-memory trace records kept per run until the F3 recorder persists them. */
const TRACE_CAPACITY = 200_000;
/** Ticks the HUD's budget figures average over. */
const BUDGET_WINDOW = 100;

/** Appends to a bounded window. */
function push(window: number[], v: number): void {
  window.push(v);
  if (window.length > BUDGET_WINDOW) window.shift();
}

/** Chunks per `chunks` message (64 × 64 cells: 16 KiB each, so at most 4 MiB per message). */
const CHUNKS_PER_MESSAGE = 256;

export class ScenarioHostedWorld implements HostedWorld {
  readonly dtS = SCENARIO_DT_S;
  readonly entityIds: readonly string[];
  private drained = -1;
  /** Grid version already sent to the main thread (-1: nothing sent yet). */
  private sentGridVersion = -1;
  private readonly trail: TrailRecorder;

  private constructor(
    private readonly run: CreatedRun,
    private readonly resolved: ResolvedRunConfig,
    readonly trace: TraceBuffer,
    readonly runId: string,
    readonly loaded: SimLoadedMessage,
  ) {
    this.entityIds = run.agents.map((a) => a.id);
    this.instrumentBudgets();
    this.trail = new TrailRecorder(run.agents.length);
    this.recordTrail(); // start poses
  }

  /**
   * Builds every agent's starting planning views and HPA* graphs before tick 0 (ADR-0024 "at scenario load"),
   * so the first query does not build them inside a tick. Wall time only; the run is the same either way.
   */
  preparePlanning(onProgress?: (done: number, total: number) => void): Result<{ views: number; graphs: number }, CodedError> {
    return preparePlanning(this.run, this.resolved, onProgress);
  }

  /** Executed paths come from the authoritative state after each tick, never from rendering. */
  private recordTrail(): void {
    const agents = this.run.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i] as SimAgent;
      this.trail.observe(i, a.state.x, a.state.y, a.kind === "uav" ? a.state.z : 0);
    }
  }

  startStrategyTest(req: StrategyTestRequest): { ok: true; value: StrategyTestRun } | { ok: false; error: StrategyTestError } {
    return startStrategyTest(this.run, this.resolved, req);
  }

  inject(cmd: { agentId: string; name: string; params: unknown }, atTick?: number): Result<RunInput, CodedError> {
    if (!this.entityIds.includes(cmd.agentId)) return { ok: false, error: { code: "unknown_agent", message: `no agent ${cmd.agentId} in this run` } };
    // The closed set is checked before anything is recorded: a run input is a fact that can be applied again, never a refused name.
    if (!this.run.runtime.isInjectable(cmd.name)) return { ok: false, error: { code: "not_injectable", message: `${cmd.name.slice(0, 32)} is not a researcher command` } };
    if (atTick !== undefined && atTick <= this.run.world.tick) return { ok: false, error: { code: "past_tick", message: `tick ${atTick} has already run` } };
    return { ok: true, value: this.run.world.inject(cmd, atTick) };
  }

  /**
   * What the agent's mind gets (or would get now), from the world's own request builder, as the JSON a mind receives.
   * Pure: nothing is consumed, recorded or timed (ADR-0005 addition of 2026-10-12).
   */
  mindView(agentId: string): { tick: number; pending: boolean; request: string } | undefined {
    const p = this.run.world.peekRequest(agentId);
    return p && { tick: p.request.tick, pending: p.pending, request: JSON.stringify(p.request) };
  }

  /**
   * Observer-side comparison of the agent's beliefs with the ground truth (researcher view). Pure: the observer's
   * tallies are caches of what the state already is; nothing in the run changes (ADR-0005 addition of 2026-10-12).
   */
  researcherData(agentId: string): Omit<SimResearcherDataMessage, "type" | "runId"> | undefined {
    const obs = this.run.observer;
    if (!obs || !this.entityIds.includes(agentId)) return undefined;
    const r = obs.report(agentId, this.run.world.tick, this.run.world.simTimeS);
    return { agentId, tick: r.tick, simTimeS: r.simTimeS, ideal: r.map === undefined, ...(r.map ? { map: { ...r.map } } : {}), entities: { ...r.entities } };
  }

  cellBeliefs(i: number, j: number): Omit<SimCellBeliefsMessage, "type" | "runId"> | undefined {
    const obs = this.run.observer;
    if (!obs) return undefined;
    return { i, j, tick: this.run.world.tick, agents: obs.beliefAt(i, j) };
  }

  drainTrail(): SimTrailMessage | undefined {
    const t = this.trail.drain();
    return t && { type: "trail", runId: this.runId, ...t };
  }

  /**
   * Validates both documents (untrusted: they may come from an imported database) and assembles the run. With `restore` the run skips genesis and takes the state
   * of a snapshot of a recording (a re-simulated window starts there); a snapshot that does not fit the run is a typed error, not a throw.
   */
  static load(
    m: { runId: string; scenario: unknown; scenarioVersion: number; runConfig: unknown },
    nowWallMs: () => number,
    options: { readonly restore?: { readonly bytes: Uint8Array; readonly resolve: (hash: string) => Uint8Array | undefined } } = {},
  ): Result<ScenarioHostedWorld, CodedError> {
    const doc = parseScenarioValue(m.scenario);
    if (!doc.ok) return doc;
    const loaded = loadScenario(doc.value);
    if (!loaded.ok) return loaded;
    const rc = parseRunConfigValue(m.runConfig);
    if (!rc.ok) return rc;
    const resolved = resolveRunConfig(rc.value, { loaded: loaded.value, version: m.scenarioVersion });
    if (!resolved.ok) return resolved;
    const rates = checkSensorRates(resolved.value, SCENARIO_DT_S);
    if (!rates.ok) return rates;
    const noise = checkSensorNoise(resolved.value, loaded.value.grid.resolutionM);
    if (!noise.ok) return noise;
    const trace = new TraceBuffer(m.runId, nowWallMs, TRACE_CAPACITY);
    const run = createRun(loaded.value, resolved.value, trace, { dtS: SCENARIO_DT_S, beliefVsTruth: {}, ...(options.restore ? { genesis: false } : {}) });
    if (options.restore) {
      try {
        restoreRun({ ...run, trace }, options.restore.bytes, { resolve: options.restore.resolve });
      } catch (e) {
        return { ok: false, error: { code: "snapshot_not_restorable", message: e instanceof Error ? e.message : String(e) } };
      }
    }
    const r = resolved.value;
    const info: SimLoadedMessage = {
      type: "loaded",
      runId: m.runId,
      scenarioId: r.scenario.id,
      scenarioVersion: r.scenario.version,
      seed: r.seed,
      timeMode: r.timeMode,
      runConfigHash: r.runConfigHash,
      effectiveConfigHash: r.effectiveConfigHash,
      idealAgents: idealAgentsOf(r),
      priors: loaded.value.priors.map((p) => p.id),
      priorHashes: loaded.value.priorHashes,
      dtS: SCENARIO_DT_S,
      defaultSeed: loaded.value.document.defaultSeed,
      worldHash: gridHash(loaded.value.grid),
      agents: run.agents.map((a) => {
        const cfg = r.agents.find((c) => c.agentId === a.id);
        const k = loaded.value.agents.findIndex((l) => l.id === a.id);
        const warnings = loaded.value.warnings.filter((w) => w.path.startsWith(`/agents/${k}/`)).map((w) => ({ code: w.code, message: w.message }));
        return {
          id: a.id,
          ...(a.key === undefined ? {} : { key: a.key }),
          kind: a.kind,
          body: loaded.value.agents[k]?.body ?? {},
          ...(cfg ? { config: { planning: cfg.planning, planningSources: cfg.planningSources, body: cfg.body, beliefs: cfg.beliefs, beliefsSource: cfg.beliefsSource, warnings: agentWarnings(cfg) } } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }),
    };
    return { ok: true, value: new ScenarioHostedWorld(run, r, trace, m.runId, info) };
  }

  /** Every run input the world holds, in input-ID order: after a restore, the ones the snapshot carried. */
  get inputs(): readonly RunInput[] {
    return this.run.world.inputs;
  }

  get tick(): number {
    return this.run.world.tick;
  }

  get simTimeS(): number {
    return this.run.world.simTimeS;
  }

  get stateHash(): string {
    return this.run.world.stateHash;
  }

  get outstandingCount(): number {
    return this.run.world.outstandingCount;
  }

  /** Called after each tick, between ticks, by a recorded run's recording (ADR-0035 addition of 2026-10-17): observation only. */
  private tickHook: (() => void) | undefined;

  setTickHook(hook: (() => void) | undefined): void {
    this.tickHook = hook;
  }

  /** What a recorded run's recording reads: the run, its trace, the step and the agents whose beliefs are the ground truth. */
  recordingTarget(): RecordingTarget {
    return {
      run: { ...this.run, trace: this.trace },
      trace: this.trace,
      dtS: this.dtS,
      idealAgents: new Set(this.resolved.agents.filter((a) => a.beliefs.idealized).map((a) => a.agentId)),
    };
  }

  step(ctx: TickContext): void {
    this.run.world.step(ctx);
    this.recordTrail();
    this.tickHook?.();
  }

  decide(): Promise<void> {
    return this.run.world.decide();
  }

  writePoses(out: Float32Array): void {
    const agents = this.run.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i] as SimAgent;
      const o = i * POSE_STRIDE;
      out[o] = a.state.x;
      out[o + 1] = a.state.y;
      out[o + 2] = a.kind === "uav" ? a.state.z : 0;
      out[o + 3] = a.state.heading;
    }
  }

  writeStatus(out: Float32Array): boolean {
    const agents = this.run.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i] as SimAgent;
      const o = i * STATUS_STRIDE;
      out[o] = a.battery.soc;
      out[o + 1] = a.kind === "ugv" ? Math.abs(a.state.speed) : a.state.lastStepM / this.dtS;
      out[o + 2] = a.odometerM;
      out[o + 3] = a.kind === "uav" && a.state.airborne ? 1 : 0;
    }
    return true;
  }

  gridMessage(): SimGridMessage {
    const g = this.run.spatial.grid;
    return {
      type: "grid",
      runId: this.runId,
      sizeX: g.sizeX,
      sizeY: g.sizeY,
      resolutionM: g.resolutionM,
      chunkSize: g.chunkSize,
      ...(g.defaultObstacleHeightM === undefined ? {} : { defaultObstacleHeightM: g.defaultObstacleHeightM }),
      zones: g.zones.zones.map((z) => ({ id: z.id, kind: z.kind, polygon: z.polygon.flat() })),
    };
  }

  drainChunks(): SimChunksMessage[] {
    const g = this.run.spatial.grid;
    if (g.version === this.sentGridVersion) return [];
    const changed: number[] = [];
    if (this.sentGridVersion < 0) for (let k = 0; k < g.chunksX * g.chunksY; k++) changed.push(k);
    else changed.push(...g.chunksChangedSince(this.sentGridVersion));
    this.sentGridVersion = g.version;
    const bytes = g.chunkSize * g.chunkSize * ATLAS_BYTES_PER_CELL;
    const scratch = atlasScratch(g.chunkSize);
    const out: SimChunksMessage[] = [];
    for (let start = 0; start < changed.length; start += CHUNKS_PER_MESSAGE) {
      const batch = changed.slice(start, start + CHUNKS_PER_MESSAGE);
      const coords = new Uint16Array(batch.length * 2);
      const data = new Uint8Array(batch.length * bytes);
      batch.forEach((k, n) => {
        const ci = k % g.chunksX;
        const cj = (k - ci) / g.chunksX;
        coords[n * 2] = ci;
        coords[n * 2 + 1] = cj;
        encodeAtlasChunk(g, ci, cj, data.subarray(n * bytes, (n + 1) * bytes), scratch);
      });
      out.push({ type: "chunks", runId: this.runId, gridVersion: g.version, coords, data });
    }
    return out;
  }

  /** The agent whose belief chunks are being sent, and the belief-map version already sent for it. */
  private beliefSent: { readonly agentId: string; version: number } | undefined;

  /**
   * Chunks of the watched agent's belief map changed since the last call, one byte per cell (the belief map's own
   * state codes). Reads only: the map's change stamps and its chunk classes (ADR-0005 addition of 2026-10-12).
   */
  drainBeliefChunks(agentId: string | null): SimBeliefChunksMessage[] {
    if (agentId === null || !this.entityIds.includes(agentId) || this.resolved.agents.find((a) => a.agentId === agentId)?.beliefs.idealized) {
      this.beliefSent = undefined;
      return [];
    }
    if (this.beliefSent?.agentId !== agentId) this.beliefSent = { agentId, version: 0 };
    const belief = this.run.sensing.belief(agentId);
    if (belief.version === this.beliefSent.version) return [];
    const changed = belief.chunksChangedSince(this.beliefSent.version);
    this.beliefSent.version = belief.version;
    const n = belief.chunkSize;
    const bytes = n * n;
    const out: SimBeliefChunksMessage[] = [];
    for (let start = 0; start < changed.length; start += CHUNKS_PER_MESSAGE) {
      const batch = changed.slice(start, start + CHUNKS_PER_MESSAGE);
      const coords = new Uint16Array(batch.length * 2);
      const data = new Uint8Array(batch.length * bytes);
      batch.forEach((k, i) => {
        const ci = k % belief.chunksX;
        const cj = (k - ci) / belief.chunksX;
        coords[i * 2] = ci;
        coords[i * 2 + 1] = cj;
        belief.classifyChunk(ci, cj, data.subarray(i * bytes, (i + 1) * bytes));
      });
      out.push({ type: "beliefChunks", runId: this.runId, agentId, coords, data });
    }
    return out;
  }

  /** Wall time of each sensing phase and the planning phase's spending, over the last `BUDGET_WINDOW` ticks (diagnostics). */
  private readonly senseMs: number[] = [];
  private readonly planExpansions: number[] = [];
  private readonly planBudget: number[] = [];
  private planQueries = 0;
  private raysPerTick = 0;
  private lidarRaysPerTick = 0;

  /**
   * Measures the sensing phase and the planning phase's spending each tick for the HUD (ADR-0013): wall time around
   * `sense`, and the planner's own per-tick counters. Nothing here reaches the trace, a hash or the simulation.
   */
  private instrumentBudgets(): void {
    const sensing = this.run.sensing;
    const service = this.run.planner.service;
    const sense = sensing.sense.bind(sensing);
    sensing.sense = (tick, simTimeS) => {
      const t0 = performance.now();
      sense(tick, simTimeS);
      push(this.senseMs, performance.now() - t0);
      push(this.planExpansions, service.lastTick.expansions);
      push(this.planBudget, service.lastTick.budget);
      this.planQueries = service.lastTick.queries;
    };
    let rays = 0;
    let lidar = 0;
    for (const c of this.resolved.agents) {
      for (const s of (c.body as { sensors: readonly { type: string; rays?: number; rateHz: number }[] }).sensors) {
        if (s.type === "camera") continue;
        const n = (s.rays ?? 0) * Math.min(1, s.rateHz * this.dtS);
        rays += n;
        if (s.type === "lidar") lidar += n;
      }
    }
    this.raysPerTick = rays;
    this.lidarRaysPerTick = lidar;
  }

  budget(): Omit<SimBudgetMessage, "type" | "runId"> | undefined {
    if (this.senseMs.length === 0) return undefined;
    const mean = (a: readonly number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const sorted = [...this.senseMs].sort((x, y) => x - y);
    return {
      tick: this.run.world.tick,
      sensingMsMean: mean(this.senseMs),
      sensingMsP95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      raysPerTick: this.raysPerTick,
      lidarRaysPerTick: this.lidarRaysPerTick,
      planningExpansionsPerTick: mean(this.planExpansions),
      planningBudgetPerTick: mean(this.planBudget),
      planningQueries: this.planQueries,
    };
  }

  /** What the overlay streams last sent for the watched agent (to send topology only when it changed). */
  private overlayState: { agentId: string; rays: boolean; topology: string } | undefined;

  drainOverlays(w: { agentId: string | null; rays: boolean; topology: boolean }): (SimRaysMessage | SimTopologyMessage)[] {
    const sensing = this.run.sensing;
    if (w.agentId === null || !this.entityIds.includes(w.agentId)) {
      if (this.overlayState) sensing.watchRays(null);
      this.overlayState = undefined;
      return [];
    }
    if (this.overlayState?.agentId !== w.agentId || this.overlayState.rays !== w.rays) {
      sensing.watchRays(w.rays ? w.agentId : null);
      this.overlayState = { agentId: w.agentId, rays: w.rays, topology: "" };
    }
    const out: (SimRaysMessage | SimTopologyMessage)[] = [];
    if (w.rays) {
      const r = sensing.takeRays();
      if (r) out.push({ type: "rays", runId: this.runId, agentId: w.agentId, tick: r.tick, segments: r.segments, hit: r.hit });
    }
    if (w.topology) {
      const o = this.run.topology.overlay(w.agentId);
      const key = `${Array.from(o.regions).join(",")}|${Array.from(o.frontiers).join(",")}`;
      if (key !== this.overlayState.topology) {
        this.overlayState.topology = key;
        out.push({ type: "topology", runId: this.runId, agentId: w.agentId, tick: this.run.world.tick, regions: o.regions, frontiers: o.frontiers });
      }
    } else if (this.overlayState.topology !== "") this.overlayState.topology = "";
    return out;
  }

  /** The records the cache holds from the last one given on: for a run without a recorder (the opted-out run's panel stream). */
  drainRecords(): TraceRecord[] {
    const out = this.trace.since(this.drained + 1);
    const last = out[out.length - 1];
    if (last) this.drained = last.seq;
    return out;
  }
}

/** Hash of every grid layer (`GridSpace.hashInto`): the world's content, reported once at load. */
export function gridHash(g: GridSpace): string {
  const h = new StateHasher();
  g.hashInto(h);
  return h.hex();
}
