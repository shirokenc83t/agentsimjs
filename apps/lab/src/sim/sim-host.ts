import {
  contentHash,
  LockstepDriver,
  POSE_STRIDE,
  RealtimeDriver,
  Scheduler,
  SIM_PROTOCOL_VERSION,
  STATUS_STRIDE,
  type DegradationEvent,
  type MainToSim,
  type PresetId,
  type Result,
  type SimToMain,
  type TickDriver,
  type TimeMode,
  type ValidationError,
} from "@agentsim/core";
import { f1DemoScenario, f1ReferenceWorldScenario, f2DiscoveryScenario, f2PriorReferenceScenario, f2TwentyAgentsScenario, type StrategyTestError, type StrategyTestRequest, type StrategyTestResult, type StrategyTestRun } from "@agentsim/scenarios";
import { parseRecordingProfile, RunRecorder, type FlowControl, type PersistedHead, type RecorderItem, type TraceBuffer } from "@agentsim/trace";
import { DummyHostedWorld, ScenarioHostedWorld, type HostedWorld } from "./hosted-world.ts";
import { RunRecording } from "./run-recording.ts";
import { RemoteMindCache, type CachePortLike } from "./remote-cache.ts";

/** The scenario document of a preset, built here (off the main thread): the large ones take tens of ms. */
function buildPresetDocument(preset: PresetId): unknown {
  switch (preset) {
    case "f1-demo":
      return f1DemoScenario();
    case "f1-reference-1km":
      return f1ReferenceWorldScenario();
    case "f2-discovery":
      return f2DiscoveryScenario();
    case "f2-20-agents":
      return f2TwentyAgentsScenario();
    case "f2-prior-1km":
      return f2PriorReferenceScenario();
  }
}

/** The sim worker's end of the recorder channel: a `MessagePort` in a worker, a fake in tests. */
interface RecorderPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
  start?(): void;
}

/** What storage tells the recorder (ADR-0019 addition of 2026-10-17). */
type FromStorage =
  | { readonly type: "header"; readonly runId: string }
  | { readonly type: "persisted"; readonly head: PersistedHead }
  | { readonly type: "quota"; readonly state: "paused" | "ok"; readonly usageBytes: number; readonly quotaBytes: number }
  | { readonly type: "rejected"; readonly runId: string; readonly code: string; readonly message: string };

/** The buffers of a snapshot or of belief frames that the worker can take without a copy: those that own their whole buffer. */
function transferList(item: RecorderItem): Transferable[] {
  const out = new Set<ArrayBuffer>();
  const add = (b: Uint8Array | undefined) => {
    if (b && b.byteOffset === 0 && b.buffer instanceof ArrayBuffer && b.byteLength === b.buffer.byteLength) out.add(b.buffer);
  };
  if (item.type === "metrics") return [];
  if (item.type === "snapshot") add(item.bytes);
  for (const b of item.blobs) add(b.bytes);
  if (item.type === "frames") for (const f of item.frames) add(f.data);
  return [...out];
}

/** Host options (tests set the marks of the backlog). */
export interface SimHostOptions {
  readonly flow?: FlowControl;
}

/** What the host needs from a worker scope (keeps it unit-testable). */
export interface SimScope {
  postMessage(message: SimToMain, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
}

/**
 * Optional structural check of incoming messages. The main thread is a trusted internal peer, so this
 * runs in dev builds and tests only (ADR-0018: validate at trust boundaries). Scenario and run-config
 * documents inside `load` are always validated, because they may come from an imported database.
 */
export type SimMessageCheck = (m: unknown) => Result<MainToSim, ValidationError>;

export interface SimClock {
  /** Monotonic wall time in ms (worker-local). */
  now(): number;
  /** Epoch ms comparable across realms. */
  epochNow(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Ticks the lockstep driver runs per poll before yielding (the worker stays responsive; nothing is dropped). */
const LOCKSTEP_MAX_PER_POLL = 8;
/** Ticks the realtime driver runs per poll before dropping the excess (traced degradation). */
const REALTIME_MAX_PER_POLL = 4;
/** Wall time a sandbox query may take per poll before yielding to the run's own loop (a query is counted in sim ticks: slicing never changes its result). */
const SANDBOX_SLICE_MS = 6;
/** Sandbox queries waiting or running; a researcher tool, not a queue to grow. */
const SANDBOX_MAX_PENDING = 8;
/** Panel streams (status, events) are batched at ≤ 10 Hz (UI-SPEC §10). */
const PANEL_INTERVAL_MS = 100;
/** A headless run steps for at most this long (wall ms) and this many ticks per poll, then yields so the worker stays responsive (nothing is dropped). */
const HEADLESS_SLICE_MS = 20;
const HEADLESS_MAX_PER_POLL = 400;

/**
 * Sim worker host (ADR-0019): owns the wall-clock timer (outside deterministic packages) and drives the
 * world through a time-mode driver (ADR-0003). Lockstep never skips ticks and stops the sim clock while a
 * mind's decision is outstanding; realtime drops overrun ticks and traces each drop (ADR-0013). Never waits
 * for the main thread. Before a scenario is loaded it runs the F0 dummy world.
 */
export function runSimHost(scope: SimScope, clock: SimClock, check?: SimMessageCheck, options: SimHostOptions = {}): { trace: () => TraceBuffer } {
  let world: HostedWorld = new DummyHostedWorld(() => clock.epochNow());
  let scheduler = new Scheduler(world, world.dtS);
  let tickRateHz = 10;
  let mode: TimeMode = "lockstep";
  let running = false;
  let deciding = false;
  let timer: unknown;
  let postedTick = -1;
  let sentIds = false;
  let degradations = 0;
  let lastPanelAt = Number.NEGATIVE_INFINITY;
  const pool: ArrayBuffer[] = [];
  const tickTimes: number[] = [];
  let ticksThisWindow = 0;
  let windowStart = clock.now();
  /** Recording: the channel to the storage worker (from the main thread), and the recorder of the loaded run when it is recorded. */
  let recorderPort: RecorderPort | undefined;
  /** The minds' response cache over the channel the main thread gave (F4 M2): absent, a run keeps its cache in memory. */
  let mindCache: RemoteMindCache | undefined;
  /** The provider keys the main thread gave, by entry id: in this closure and in the adapters made from it, nowhere else. */
  let providerKeys: ReadonlyMap<string, string> = new Map();
  let recorder: RunRecorder | undefined;
  /** What a recorded run writes besides its components' records: checkpoints, snapshots, pose samples, belief keyframes and deltas. */
  let recording: RunRecording | undefined;
  let gateWaiters: (() => void)[] = [];
  /** The storage quota is near its limit: the run is paused until the worker says there is room (`wasPlaying`: it goes on by itself then). */
  let quotaPaused = false;
  let wasPlayingBeforeQuota = false;
  /** Flow control: since when (wall time) the run has been waiting for the writer, and what was last reported to the main thread. */
  let waitingSince: number | undefined;
  /** The backlog when the wait began: what caused it (the one reported with the degradation, not the smaller one the wait ended on). */
  let waitingBacklog: { readonly records: number; readonly bytes: number } | undefined;
  let reported: "ok" | "storage_backpressure" | "storage_quota" = "ok";
  /** A headless run (ADR-0029): no render state is posted and the run goes as fast as lockstep allows; `untilS` is its end condition, when it has one. */
  let headless: { readonly untilS: number | undefined } | undefined;
  let headlessDone = false;
  /** Wall time the run has been running (while playing), for the progress view. */
  let wallAccum = 0;
  let playedAt = 0;
  let rates = { ticksPerSecond: 0, simSecondsPerSecond: 0 };
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const poseFloats = () => world.entityIds.length * POSE_STRIDE;

  const onDegradation = (e: DegradationEvent) => {
    degradations++;
    world.trace.degradation(e);
    scope.postMessage({ type: "degradation", tick: e.tick, simTimeS: e.simTimeS, skippedTicks: e.skippedTicks });
  };
  const ready = () => world.outstandingCount === 0;
  const makeDriver = (): TickDriver =>
    mode === "lockstep"
      ? new LockstepDriver(scheduler, tickRateHz, LOCKSTEP_MAX_PER_POLL, ready)
      : new RealtimeDriver(scheduler, tickRateHz, onDegradation, REALTIME_MAX_PER_POLL);
  let driver = makeDriver();

  const takeBuffer = (): Float32Array => {
    const n = poseFloats();
    const b = pool.pop();
    return b && b.byteLength === n * 4 ? new Float32Array(b) : new Float32Array(n);
  };

  /** Dirty grid chunks for the atlas (ADR-0027), transferred; none in steady state without edits. */
  const postChunks = () => {
    for (const m of world.drainChunks()) scope.postMessage(m, [m.coords.buffer, m.data.buffer]);
  };

  /** The agent the panels look at (a `view` message), or none. Reset by a load. */
  let viewed: string | null = null;

  /** The viewed agent's decision request as its mind gets it, for the Inspector (pure: nothing in the run changes). */
  const postAgentView = () => {
    if (viewed === null || !world.runId) return;
    const v = world.mindView(viewed);
    if (v) scope.postMessage({ type: "agentView", runId: world.runId, agentId: viewed, ...v });
  };

  let budgetPosts = 0;

  /** The run's budget use for the HUD at about a third of the panel rate (≈ 3 Hz); always after a forced post (a step). */
  const postBudget = (force: boolean) => {
    if (!world.runId) return;
    const b = world.budget();
    if (!b) return;
    if (!force && budgetPosts++ % 3 !== 0) return;
    scope.postMessage({ type: "budget", runId: world.runId, ...b });
  };

  /** What the System 2 minds are doing (F4): posted when it changed, at the panel rate, and at once with a forced post (a load, a step). */
  const postMinds = (force: boolean) => {
    if (!world.runId) return;
    const s = world.mindStatus(force);
    if (s) scope.postMessage({ type: "minds", runId: world.runId, ...s });
  };

  /** What the Scene's ray and topology overlays watch (an agent and which streams), or nothing. Reset by a load. */
  let overlayWatch: { agentId: string | null; rays: boolean; topology: boolean } = { agentId: null, rays: false, topology: false };
  let rayPosts = 0;

  /** Rays (decimated to every second panel post: ≤ 5 Hz) and the topological layer (when it changed), transferred. */
  const postOverlays = () => {
    if (overlayWatch.agentId === null) return;
    for (const m of world.drainOverlays(overlayWatch)) {
      if (m.type === "rays" && rayPosts++ % 2 === 1) continue;
      scope.postMessage(m, m.type === "rays" ? [m.segments.buffer, m.hit.buffer] : [m.regions.buffer, m.frontiers.buffer]);
    }
  };

  /** The agent whose belief map the Scene's overlay shows, or none. Reset by a load. */
  let beliefWatched: string | null = null;

  /** Belief chunks of the watched agent (dirty ones only), transferred. */
  const postBeliefChunks = () => {
    for (const m of world.drainBeliefChunks(beliefWatched)) scope.postMessage(m, [m.coords.buffer, m.data.buffer]);
  };

  /** The agent whose researcher-only metrics a panel shows, or none. Reset by a load. */
  let watched: string | null = null;

  /** Researcher-only beliefs-vs-truth for the watched agent (observer data: worker → main only). */
  /** The cell whose beliefs a panel shows, or none. Reset by a load. */
  let watchedCell: { i: number; j: number } | null = null;
  const postCellBeliefs = () => {
    if (watchedCell === null || !world.runId) return;
    const d = world.cellBeliefs(watchedCell.i, watchedCell.j);
    if (d) scope.postMessage({ type: "cellBeliefs", runId: world.runId, ...d });
  };

  const postResearcher = () => {
    if (watched === null || !world.runId) return;
    const d = world.researcherData(watched);
    if (d) scope.postMessage({ type: "researcherData", runId: world.runId, ...d });
  };

  /** Status and new trace records at ≤ 10 Hz (or at once when `force`, e.g. after a step or a load). */
  const postPanels = (force: boolean): Float32Array | undefined => {
    const now = clock.now();
    if (!force && now - lastPanelAt < PANEL_INTERVAL_MS) return undefined;
    lastPanelAt = now;
    postChunks();
    const trail = world.drainTrail();
    if (trail) {
      const r = trail.replace;
      scope.postMessage(trail, r ? [trail.agents.buffer, trail.points.buffer, r.agents.buffer, r.offsets.buffer, r.points.buffer] : [trail.agents.buffer, trail.points.buffer]);
    }
    // A recorded run shows what the recorder gathered (profile applied), whole; a run without one reads its cache from a cursor.
    const records = recorder ? recorder.takePanel() : world.drainRecords();
    if (records.length > 0 && world.runId) scope.postMessage({ type: "events", runId: world.runId, records });
    postAgentView();
    postResearcher();
    postCellBeliefs();
    postBeliefChunks();
    postOverlays();
    postBudget(force);
    postMinds(force);
    const status = new Float32Array(world.entityIds.length * STATUS_STRIDE);
    return world.writeStatus(status) ? status : undefined;
  };

  const postState = (force = false) => {
    if (world.tick === postedTick && !force) return;
    postedTick = world.tick;
    const poses = takeBuffer();
    world.writePoses(poses);
    const status = postPanels(force);
    scope.postMessage(
      {
        type: "state",
        tick: world.tick,
        simTimeS: world.simTimeS,
        ...(sentIds ? {} : { entityIds: [...world.entityIds] }),
        poses,
        ...(status ? { agentStatus: status } : {}),
        sentAtEpochMs: clock.epochNow(),
      },
      status ? [poses.buffer, status.buffer] : [poses.buffer],
    );
    sentIds = true;
  };

  const postStats = () => {
    const now = clock.now();
    const elapsed = now - windowStart;
    const sorted = [...tickTimes].sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p95 = sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0) : 0;
    rates = { ticksPerSecond: elapsed > 0 ? (ticksThisWindow * 1000) / elapsed : 0, simSecondsPerSecond: elapsed > 0 ? (ticksThisWindow * world.dtS * 1000) / elapsed : 0 };
    scope.postMessage({
      type: "stats",
      running,
      mode,
      degradations,
      tickRateHz,
      ticksPerSecond: elapsed > 0 ? (ticksThisWindow * 1000) / elapsed : 0,
      tickTimeMeanMs: mean,
      tickTimeP95Ms: p95,
      ...(world.runId === undefined ? {} : { runId: world.runId }),
      ...(world.stateHash === undefined ? {} : { tick: world.tick, stateHash: world.stateHash }),
    });
    ticksThisWindow = 0;
    windowStart = now;
  };

  const recordTicks = (n: number, ms: number) => {
    if (n === 0) return;
    for (let i = 0; i < n; i++) tickTimes.push(ms / n);
    while (tickTimes.length > 256) tickTimes.shift();
    ticksThisWindow += n;
  };

  // Poll at least every 16 ms, and at least twice per tick at high rates, so pacing jitter stays small.
  const pollMs = () => Math.max(1, Math.min(16, 500 / tickRateHz));

  /**
   * Lockstep wait for minds (ADR-0003): the sim clock stops until every outstanding decision has arrived;
   * pacing then restarts from now, so the wait never turns into a burst of catch-up ticks.
   */
  const awaitDecisions = () => {
    if (deciding) return;
    deciding = true;
    const w = world;
    w.decide().then(
      () => {
        deciding = false;
        if (w === world && running) driver.start(clock.now());
      },
      (e: unknown) => {
        deciding = false;
        const text = e instanceof Error ? e.message : String(e);
        // A limit reached (no one to ask) or a miss of a strict replay ends a headless run with that reason (ADR-0044 section 5); a run in front of a researcher shows the error and pauses.
        const reason = text.includes("limit_reached") ? ("limit_reached" as const) : text.includes("cache_miss_strict") ? ("cache_miss_strict" as const) : undefined;
        if (headless && reason !== undefined && w === world) {
          endReason = reason;
          scope.postMessage({ type: "error", code: "mind_failed", message: text });
          finishHeadless();
          return;
        }
        scope.postMessage({ type: "error", code: "mind_failed", message: text });
        pause();
      },
    );
  };

  /** Why the headless run ended when it was not its end condition (a limit of a mind, a miss of a strict replay). */
  let endReason: "limit_reached" | "cache_miss_strict" | undefined;

  const loop = () => {
    if (!running) return;
    if (headless) return headlessLoop();
    const t0 = clock.now();
    // Header first: a recorded run does not step until the storage worker has its header (like a wait for decisions, it is not a backlog).
    const n = deciding || gated() ? 0 : driver.advance(t0);
    recordTicks(n, clock.now() - t0);
    if (n > 0) recorder?.collect(world.tick, world.simTimeS);
    syncRecordingState();
    if (n > 0) postState();
    else postPanels(false);
    if (world.outstandingCount > 0) awaitDecisions();
    if (clock.now() - windowStart >= 1000) postStats();
    timer = clock.setTimer(loop, pollMs());
  };

  const play = () => {
    if (running) return;
    if (headlessDone) return; // the end condition was reached: the run is over
    running = true;
    driver.start(clock.now());
    windowStart = clock.now();
    playedAt = clock.now();
    ticksThisWindow = 0;
    timer = clock.setTimer(loop, headless ? 1 : pollMs());
    postStats();
  };

  function pause() {
    if (running) wallAccum += Math.max(0, clock.now() - playedAt);
    running = false;
    clock.clearTimer(timer);
    recorder?.collect(world.tick, world.simTimeS); // what the recorder holds goes out; a pause is not the end of the run
    postStats();
    if (headless) postProgress(true);
  }

  // ---- headless runs (ADR-0029) -------------------------------------------------------------------------------------------

  const reachedEnd = (): boolean => headless?.untilS !== undefined && world.simTimeS >= headless.untilS - 1e-9;

  /** What a headless run is waiting for right now. */
  const waitingFor = (): "none" | "decision" | "header" | "storage_backpressure" | "storage_quota" => {
    if (recorder?.awaitingHeader) return "header";
    if (quotaPaused) return "storage_quota";
    if (recorder?.waiting) return "storage_backpressure";
    if (deciding || world.outstandingCount > 0) return "decision";
    return "none";
  };

  /** Progress of the loaded run, at most at the panel rate unless `force` (a pause, the end, a switch to the live view). */
  function postProgress(force: boolean): void {
    if (!world.runId || (!headless && !force)) return;
    const now = clock.now();
    if (!force && now - lastProgressAt < PANEL_INTERVAL_MS) return;
    lastProgressAt = now;
    const sorted = [...tickTimes].sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p95 = sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0) : 0;
    const b = recorder?.backlog;
    scope.postMessage({
      type: "progress",
      runId: world.runId,
      headless: headless !== undefined,
      running,
      done: headlessDone,
      tick: world.tick,
      simTimeS: world.simTimeS,
      ...(headless?.untilS === undefined ? {} : { untilS: headless.untilS }),
      wallMs: wallAccum + (running ? Math.max(0, now - playedAt) : 0),
      ticksPerSecond: running ? rates.ticksPerSecond : 0,
      simSecondsPerSecond: running ? rates.simSecondsPerSecond : 0,
      tickTimeMeanMs: mean,
      tickTimeP95Ms: p95,
      waiting: running ? waitingFor() : "none",
      ...(endReason === undefined ? {} : { endReason }),
      recordsHandedOver: recorder?.recordsHandedOver ?? 0,
      backlogRecords: b?.records ?? 0,
      backlogBytes: b?.bytes ?? 0,
      snapshotTicks: [...(recording?.snapshotTicks ?? [])],
      ...(world.stateHash === undefined ? {} : { stateHash: world.stateHash }),
    });
  }

  /**
   * One poll of a headless run: as many ticks as fit in a slice, checked tick by tick for the writer's backlog like a step (a headless run waits for the writer: wall time
   * only), no render state, and progress at the panel rate. A run with an end condition stops there with its end snapshot written.
   */
  function headlessLoop(): void {
    if (!running) return;
    const t0 = clock.now();
    let n = 0;
    while (n < HEADLESS_MAX_PER_POLL && !deciding && world.outstandingCount === 0 && !gated() && !reachedEnd()) {
      scheduler.step();
      n++;
      if (recorder) {
        recorder.collect(world.tick, world.simTimeS);
        syncRecordingState();
      }
      if (clock.now() - t0 >= HEADLESS_SLICE_MS) break;
    }
    recordTicks(n, clock.now() - t0);
    syncRecordingState();
    if (world.outstandingCount > 0) awaitDecisions();
    if (reachedEnd()) {
      finishHeadless();
      return;
    }
    postProgress(false);
    if (clock.now() - windowStart >= 1000) postStats();
    timer = clock.setTimer(headlessLoop, 1);
  }

  /** The end condition was reached: the run stops, its end snapshot is written and the main thread is told it is done. */
  function finishHeadless(): void {
    headlessDone = true;
    pause();
    endRecording();
    postProgress(true);
  }

  /**
   * The run ends because another run replaces it: its end snapshot (ADR-0035 addition of 2026-10-17, item 8: start, every S, and the end:
   * completion, stop, or replacement). A pause or the end of a manual step is not one: what is stored must not depend on when the
   * researcher clicked.
   */
  function endRecording(): void {
    recording?.end();
    recorder?.collect(world.tick, world.simTimeS);
  }

  /** The run may not step: the header is not stored, the writer is behind (backlog above its high mark) or the storage quota is near. */
  const gated = (): boolean => recorder !== undefined && (recorder.awaitingHeader || recorder.waiting || quotaPaused);

  /** Resolves when the run may step (at once when it may now). */
  const gateOpen = (): Promise<void> => (gated() ? new Promise<void>((resolve) => gateWaiters.push(resolve)) : Promise.resolve());

  const releaseGate = () => {
    if (gated()) return;
    const waiting = gateWaiters;
    gateWaiters = [];
    for (const w of waiting) w();
  };

  /** Tells the main thread when the recording's state changes, and in realtime traces the wait for the writer when it ends (ADR-0013 addition). */
  const syncRecordingState = () => {
    if (!recorder || !world.runId) return;
    const b = recorder.backlog;
    const state = quotaPaused ? "storage_quota" : recorder.waiting ? "storage_backpressure" : "ok";
    if (recorder.waiting && waitingSince === undefined) {
      waitingSince = clock.now();
      waitingBacklog = b;
    }
    if (!recorder.waiting && waitingSince !== undefined) {
      const waitMs = Math.max(0, clock.now() - waitingSince);
      waitingSince = undefined;
      // Lockstep (and headless) loses wall time only; realtime traces the wait as a degradation, next to the ticks it makes the driver skip.
      const cause = waitingBacklog ?? b;
      waitingBacklog = undefined;
      if (mode === "realtime") world.trace.storageBackpressure({ tick: world.tick, simTimeS: world.simTimeS, backlogRecords: cause.records, backlogBytes: cause.bytes, waitMs });
      if (running && mode !== "realtime") driver.start(clock.now()); // the wait is not a backlog of ticks
    }
    if (state !== reported) {
      reported = state;
      postRecordingState();
    }
    // A finished headless run has no loop left to report the writer's backlog going down: each acknowledgement does, the last one at once.
    if (headlessDone) postProgress(recorder !== undefined && recorder.backlog.records === 0);
    releaseGate();
  };

  /** The recording's state, as a message, when it changes (the client keeps the latest). */
  function postRecordingState(): void {
    if (!recorder || !world.runId) return;
    const b = recorder.backlog;
    scope.postMessage({ type: "recording", runId: world.runId, state: reported, backlogRecords: b.records, backlogBytes: b.bytes });
  }

  const onFromStorage = (m: FromStorage) => {
    if (m.type === "header") {
      if (!recorder || m.runId !== world.runId) return;
      recorder.headerStored();
      if (running) driver.start(clock.now()); // the wait for the header is not a backlog
      syncRecordingState();
    } else if (m.type === "persisted") {
      recorder?.persisted(m.head);
      syncRecordingState();
    } else if (m.type === "quota") {
      if (!recorder) return;
      if (m.state === "paused") {
        quotaPaused = true;
        wasPlayingBeforeQuota = running;
        if (running) pause();
        syncRecordingState();
      } else {
        quotaPaused = false;
        syncRecordingState();
        if (wasPlayingBeforeQuota && !running) play();
        wasPlayingBeforeQuota = false;
      }
    } else if (m.type === "rejected") {
      scope.postMessage({ type: "error", code: "recording_failed", message: `the recording of ${m.runId} failed (${m.code}): ${m.message}` });
      if (running) pause();
    }
  };

  /** Runs `count` ticks now (paused afterwards). Lockstep semantics: decisions are awaited between ticks. */
  /**
   * Waits for the minds' decisions of this tick and, while it waits, keeps reporting what the minds are doing (the panel rate): a stepped run has no loop, and without this a limit passed inside a decision
   * left the step waiting for an answer nobody could see asked (T-128: no notice, the records of the decision held back).
   */
  const decideReporting = async () => {
    if (headless) return world.decide();
    let timer: unknown;
    const poll = () => {
      postPanels(false);
      timer = clock.setTimer(poll, pollMs());
    };
    timer = clock.setTimer(poll, pollMs());
    try {
      await world.decide();
    } finally {
      clock.clearTimer(timer);
    }
  };

  const step = async (count: number) => {
    if (running) pause();
    for (let i = 0; i < count; i++) {
      if (gated()) await gateOpen(); // no await when the run may step: a step stays synchronous
      if (world.outstandingCount > 0) await decideReporting();
      scheduler.step();
      // A recorded run's backlog is judged tick by tick, so a long step waits for the writer too.
      if (recorder) {
        recorder.collect(world.tick, world.simTimeS);
        syncRecordingState();
      }
    }
    recorder?.collect(world.tick, world.simTimeS);
    syncRecordingState();
    if (headless) postProgress(true);
    else postState(true);
    postStats();
  };

  // The researcher's strategy sandbox (ADR-0037 item 16): queries stepped in slices between the run's own polls, entirely apart
  // from the run (a separate planner over a map copy: no trace record, no run input, no clock, no hash).
  let sandbox: { requestId: number; run: StrategyTestRun }[] = [];
  let sandboxTimer: unknown;
  const answer = (requestId: number, r: { ok: true; value: StrategyTestResult } | { ok: false; error: StrategyTestError }) =>
    scope.postMessage(r.ok ? { type: "strategyTestResult", requestId, ok: true, result: r.value } : { type: "strategyTestResult", requestId, ok: false, error: r.error });
  const pumpSandbox = () => {
    sandboxTimer = undefined;
    const job = sandbox[0];
    if (!job) return;
    // A queued query does not run while a realtime run plays (see `strategyTest`); it resumes at the next pause.
    if (mode === "realtime" && running) {
      sandboxTimer = clock.setTimer(pumpSandbox, 50);
      return;
    }
    const start = clock.now();
    let done: boolean;
    do {
      done = job.run.step(1);
    } while (!done && clock.now() - start < SANDBOX_SLICE_MS);
    if (done) {
      sandbox.shift();
      answer(job.requestId, job.run.result());
    }
    if (sandbox.length > 0) sandboxTimer = clock.setTimer(pumpSandbox, 0);
  };
  /** A new run (or a replacement of the world) answers whatever was pending: its results would be about a world that is gone. */
  const dropSandbox = () => {
    if (sandboxTimer !== undefined) clock.clearTimer(sandboxTimer);
    sandboxTimer = undefined;
    for (const job of sandbox) answer(job.requestId, { ok: false, error: { code: "run_changed", message: "another run was loaded before the query ended" } });
    sandbox = [];
  };

  const load = (m: Extract<MainToSim, { type: "load" }>) => {
    // A headless run is always recorded (ADR-0035 addition of 2026-10-17, item 6): there is no opt-out.
    if (m.headless && m.recording?.mode !== "stored") {
      scope.postMessage({ type: "error", code: "headless_needs_recording", message: "a headless run is always recorded: there is no opt-out" });
      return;
    }
    // A recorded run needs the channel to the storage worker and a valid profile; refused before anything changes.
    let profile: ReturnType<typeof parseRecordingProfile> | undefined;
    if (m.recording?.mode === "stored") {
      if (!recorderPort) {
        scope.postMessage({ type: "error", code: "recording_unavailable", message: "a recorded run needs the recorder channel to the storage worker, which was not set up" });
        return;
      }
      profile = parseRecordingProfile(JSON.stringify(m.recording.profile));
      if (!profile.ok) {
        scope.postMessage({ type: "error", code: "invalid_recording_profile", message: profile.error.message });
        return;
      }
    }
    endReason = undefined;
    const r = ScenarioHostedWorld.load(m, () => clock.epochNow(), m.minds === undefined ? {} : { minds: m.minds, headless: m.headless !== undefined, ...(mindCache === undefined ? {} : { mindCache }), keys: providerKeys });
    if (!r.ok) {
      scope.postMessage({ type: "error", code: r.error.code, message: r.error.message });
      return;
    }
    // Planning views and HPA* graphs are built here, before tick 0, not inside the first query's tick (ADR-0024).
    // The time is wall time: reported to the UI, never traced or hashed.
    const t0 = clock.now();
    const prepared = r.value.preparePlanning((done, total) => scope.postMessage({ type: "preparing", runId: m.runId, done, total }));
    if (!prepared.ok) {
      scope.postMessage({ type: "error", code: prepared.error.code, message: prepared.error.message });
      return;
    }
    // `realtime` is not meaningful headless (ADR-0029): refused before anything changes.
    if (m.headless && r.value.loaded.timeMode === "realtime") {
      scope.postMessage({ type: "error", code: "headless_realtime", message: "a headless run goes as fast as lockstep allows: realtime is not meaningful for it, and the run configuration asks for it" });
      return;
    }
    scope.postMessage({ type: "prepared", runId: m.runId, ...prepared.value, ms: Math.max(0, clock.now() - t0) });
    if (running) pause();
    endRecording();
    dropSandbox();
    world = r.value;
    // The recorder of a recorded run sits next to the run's trace; it waits for the header before it sends. Runs that are opted out or not
    // asked about have none: their cache forgets at capacity and counts.
    const channel = recorderPort;
    gateWaiters = [];
    quotaPaused = false;
    wasPlayingBeforeQuota = false;
    waitingSince = undefined;
    waitingBacklog = undefined;
    reported = "ok";
    recorder =
      profile?.ok && channel
        ? new RunRecorder({ buffer: world.trace, profile: profile.value, send: (batch) => channel.postMessage({ type: "batch", batch }), sendItem: (item) => channel.postMessage(item, transferList(item)), ...(options.flow ? { flow: options.flow } : {}) })
        : undefined;
    recording = undefined;
    if (recorder && profile?.ok && world instanceof ScenarioHostedWorld) {
      recording = new RunRecording(world.recordingTarget(), recorder, profile.value);
      const rec = recording;
      world.setTickHook(() => rec.afterTick());
    }
    scheduler = new Scheduler(world, world.dtS);
    // The run's declared time mode (run configuration, in its header and runConfigHash), not the previous one.
    mode = r.value.loaded.timeMode === "realtime" ? "realtime" : "lockstep"; // a latency-modeled run is paced as lockstep
    driver = makeDriver();
    degradations = 0;
    headless = m.headless === undefined ? undefined : { untilS: m.headless.untilS };
    headlessDone = false;
    wallAccum = 0;
    rates = { ticksPerSecond: 0, simSecondsPerSecond: 0 };
    lastProgressAt = Number.NEGATIVE_INFINITY;
    postedTick = -1;
    sentIds = false;
    pool.length = 0;
    viewed = null;
    watched = null;
    watchedCell = null;
    beliefWatched = null;
    budgetPosts = 0;
    overlayWatch = { agentId: null, rays: false, topology: false };
    rayPosts = 0;
    recording?.start(); // the first snapshot, keyframes, checkpoint and poses: held with the rest until the header is stored
    recorder?.collect(0, 0); // what genesis emitted (start events, first requests, configuration records): held until the header is stored
    scope.postMessage(r.value.loaded);
    // A headless run posts no render state: the grid and its chunks go with the first live view.
    if (!headless) scope.postMessage(r.value.gridMessage());
    // Re-simulation of a stored run: its inputs, in input order at their ticks (the world assigns the same IDs).
    for (const input of m.inputs ?? []) {
      const ri = world.inject({ agentId: input.agentId, name: input.name, params: input.params }, input.tick);
      if (!ri.ok) {
        scope.postMessage({ type: "error", code: "replay_input_rejected", message: `${input.inputId}: ${ri.error.message}` });
        break;
      }
      scope.postMessage({ type: "input", runId: m.runId, input: ri.value });
    }
    if (headless) postProgress(true);
    else postState(true);
    postStats();
  };

  scope.addEventListener("message", (ev) => {
    let m = ev.data as MainToSim;
    if (check) {
      const r = check(ev.data);
      if (!r.ok) {
        scope.postMessage({ type: "error", code: "invalid_message", message: r.error.message });
        return;
      }
      m = r.value;
    }
    switch (m.type) {
      case "init":
        tickRateHz = m.tickRateHz;
        driver = makeDriver();
        scope.postMessage({ type: "ready", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz });
        play();
        break;
      case "recorderPort": {
        const port = m.port as RecorderPort;
        recorderPort = port;
        port.addEventListener("message", (e) => onFromStorage(e.data as FromStorage));
        port.start?.();
        break;
      }
      case "providerKeys":
        providerKeys = new Map(Object.entries(m.keys));
        break;
      case "cachePort":
        mindCache = new RemoteMindCache(m.port as CachePortLike);
        break;
      case "load":
        load(m);
        break;
      case "limitAnswer":
        // The researcher's answer to a limit that paused the run: the mind's decision, which the world has been waiting for, goes on or ends the run.
        if (m.runId === world.runId && world.answerLimit(m.action === "raise" ? { agentId: m.agentId, limit: m.limit, action: "raise", value: m.value } : { agentId: m.agentId, limit: m.limit, action: "stop" })) postMinds(true);
        break;
      case "view":
        viewed = m.agentId;
        if (viewed !== null) postAgentView();
        break;
      case "overlayWatch":
        if (overlayWatch.agentId !== null && m.agentId === null) world.drainOverlays({ agentId: null, rays: false, topology: false });
        overlayWatch = { agentId: m.agentId, rays: m.rays, topology: m.topology };
        rayPosts = 0;
        postOverlays();
        break;
      case "beliefWatch":
        beliefWatched = m.agentId;
        postBeliefChunks();
        break;
      case "researcherWatch":
        watched = m.agentId;
        if (watched !== null) postResearcher();
        break;
      case "cellWatch":
        watchedCell = m.cell;
        postCellBeliefs();
        break;
      case "command": {
        // A run input for the next tick (ADR-0015): applied in the world's input phase, traced as injected,
        // and reported so the main thread stores it with the run.
        const r = world.inject({ agentId: m.agentId, name: m.op, params: m.params ?? {} });
        if (!r.ok) scope.postMessage({ type: "error", code: r.error.code, message: r.error.message });
        else if (world.runId) scope.postMessage({ type: "input", runId: world.runId, input: r.value });
        break;
      }
      case "buildPreset": {
        // Presets are generated and encoded here, off the main thread (F1 f1): the 1 km² world takes tens of ms.
        const document = buildPresetDocument(m.preset);
        scope.postMessage({ type: "preset", requestId: m.requestId, preset: m.preset, document, contentHash: contentHash(JSON.stringify(document)) });
        break;
      }
      case "strategyTest": {
        // A realtime run drops the ticks it is late for and traces each drop: the sandbox's work (a cold HPA* graph on the 1 km² world
        // is a second of one synchronous step) must not be the cause, so it waits for a pause. Lockstep never skips a tick.
        if (mode === "realtime" && running) {
          answer(m.requestId, { ok: false, error: { code: "sandbox_needs_pause", message: "pause the run to test a strategy: in realtime mode the test would delay ticks" } });
          break;
        }
        if (sandbox.length >= SANDBOX_MAX_PENDING) {
          answer(m.requestId, { ok: false, error: { code: "sandbox_busy", message: `at most ${SANDBOX_MAX_PENDING} strategy tests at a time` } });
          break;
        }
        const started = world.startStrategyTest({ agentId: m.agentId, to: m.to, map: m.planOn, ...(m.strategy === undefined ? {} : { strategy: m.strategy as NonNullable<StrategyTestRequest["strategy"]> }) });
        if (!started.ok) {
          answer(m.requestId, started);
          break;
        }
        sandbox.push({ requestId: m.requestId, run: started.value });
        if (sandboxTimer === undefined) sandboxTimer = clock.setTimer(pumpSandbox, 0);
        break;
      }
      case "return-buffer":
        if (pool.length < 8 && m.buffer.byteLength === poseFloats() * 4) pool.push(m.buffer);
        break;
      case "control":
        switch (m.op) {
          case "play":
            play();
            break;
          case "pause":
            pause();
            break;
          case "step":
            // A world that throws is reported, never lost in an unhandled rejection.
            step(m.count ?? 1).catch((e: unknown) => {
              scope.postMessage({ type: "error", code: "step_failed", message: e instanceof Error ? e.message : String(e) });
              postStats();
            });
            break;
          case "setTickRate":
            tickRateHz = m.tickRateHz;
            driver.setSpeed(tickRateHz);
            if (running) driver.start(clock.now()); // a speed change is not a backlog
            postStats();
            break;
          case "stop":
            // The researcher ends a headless run: the same end as its end condition (a snapshot at its tick), marked done.
            if (headless === undefined || headlessDone || world.runId === undefined) break;
            finishHeadless();
            break;
          case "liveView":
            // A headless run goes on with a live view: rendering starts from the next tick (the grid, the chunks and the agent table go first).
            if (headless === undefined) break;
            headless = undefined;
            if (world instanceof ScenarioHostedWorld) scope.postMessage(world.gridMessage());
            postState(true);
            postProgress(true);
            if (running) {
              clock.clearTimer(timer);
              driver.start(clock.now());
              timer = clock.setTimer(loop, pollMs());
            }
            postStats();
            break;
          case "setMode":
            // A headless run never takes realtime (ADR-0029).
            if (headless !== undefined && m.mode === "realtime") {
              scope.postMessage({ type: "error", code: "headless_realtime", message: `run ${world.runId ?? ""} is headless: realtime is not meaningful for it` });
              break;
            }
            // A scenario run's time mode is part of the run (header, runConfigHash): it is set at load and locked.
            // Changing it means a new run of the same scenario version. Only the F0 dummy world accepts it.
            if (world.runId !== undefined) {
              if (m.mode !== mode) scope.postMessage({ type: "error", code: "mode_locked", message: `run ${world.runId} runs in ${mode}; re-run to change the time mode` });
              break;
            }
            mode = m.mode;
            driver = makeDriver();
            if (running) driver.start(clock.now());
            postStats();
            break;
        }
        break;
    }
  });

  return { trace: () => world.trace };
}
