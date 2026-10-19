import Type, { type Static } from "typebox";
import { SIM_PROTOCOL_VERSION } from "./constants.ts";

/*
 * Sim worker ↔ main thread protocol (ADR-0019). Versioned; extended by adding message kinds.
 * Binary payloads travel as transferable typed arrays and are checked by `instanceof`.
 */

const Float32ArrayType = Type.Refine(
  Type.Unsafe<Float32Array>({}),
  (v) => v instanceof Float32Array,
  () => "expected Float32Array",
);
const Uint8ArrayType = Type.Refine(
  Type.Unsafe<Uint8Array>({}),
  (v) => v instanceof Uint8Array,
  () => "expected Uint8Array",
);
const Uint16ArrayType = Type.Refine(
  Type.Unsafe<Uint16Array>({}),
  (v) => v instanceof Uint16Array,
  () => "expected Uint16Array",
);
const Uint32ArrayType = Type.Refine(
  Type.Unsafe<Uint32Array>({}),
  (v) => v instanceof Uint32Array,
  () => "expected Uint32Array",
);
const ArrayBufferType = Type.Refine(
  Type.Unsafe<ArrayBuffer>({}),
  (v) => v instanceof ArrayBuffer,
  () => "expected ArrayBuffer",
);
const TickRateHz = Type.Number({ exclusiveMinimum: 0, maximum: 1000 });
const RunId = Type.String({ pattern: "^run-[0-9]{6}$" });
const Hash8 = Type.String({ pattern: "^[0-9a-f]{8}$" });
/** Time mode (ADR-0003). `latency-modeled` arrives with minds (F4/F5). */
export const TimeMode = Type.Union([Type.Literal("lockstep"), Type.Literal("realtime")]);
export type TimeMode = Static<typeof TimeMode>;

// ---- main → worker ----------------------------------------------------------------------------

export const SimInit = Type.Object({
  type: Type.Literal("init"),
  protocolVersion: Type.Literal(SIM_PROTOCOL_VERSION),
  tickRateHz: TickRateHz,
});

export const SimControl = Type.Union([
  Type.Object({ type: Type.Literal("control"), op: Type.Literal("play") }),
  Type.Object({ type: Type.Literal("control"), op: Type.Literal("pause") }),
  Type.Object({
    type: Type.Literal("control"),
    op: Type.Literal("step"),
    /** Ticks to run at once (default 1); paused afterwards. */
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  }),
  Type.Object({ type: Type.Literal("control"), op: Type.Literal("setTickRate"), tickRateHz: TickRateHz }),
  Type.Object({ type: Type.Literal("control"), op: Type.Literal("setMode"), mode: TimeMode }),
]);

/** Returns a consumed pose buffer to the worker's pool (no per-tick allocation, ADR-0019). */
export const SimReturnBuffer = Type.Object({ type: Type.Literal("return-buffer"), buffer: ArrayBufferType });

/**
 * Loads a scenario run (v2): the worker validates both documents (`@agentsim/scenarios`), assembles the
 * run and replaces the current world. The main thread owns run IDs and the stored scenario version.
 */
/** A run input (ADR-0015 clarification): a world-scope command applied at the start of `tick`. */
const RunInputMessage = Type.Object(
  {
    inputId: Type.String({ pattern: "^inp-[0-9]{6}$" }),
    tick: Type.Integer({ minimum: 1, maximum: 0x7fffffff }),
    agentId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const SimLoad = Type.Object({
  type: Type.Literal("load"),
  runId: RunId,
  scenario: Type.Unknown(),
  scenarioVersion: Type.Integer({ minimum: 1, maximum: 0x7fffffff }),
  runConfig: Type.Unknown(),
  /** Recorded inputs to apply again (re-simulating a stored run), scheduled at their ticks in input order. */
  inputs: Type.Optional(Type.Array(RunInputMessage, { maxItems: 100_000 })),
  /**
   * How the run is recorded (ADR-0035 addition of 2026-10-17, item 6): `stored` with the resolved recording profile (the worker
   * hands the profile's records to the storage worker through the recorder port and holds the run until the header is stored),
   * or `none`, the researcher's explicit opt-out. Absent: the run is not recorded (headless tests).
   */
  recording: Type.Optional(
    Type.Union([Type.Object({ mode: Type.Literal("none") }, { additionalProperties: false }), Type.Object({ mode: Type.Literal("stored"), profile: Type.Unknown() }, { additionalProperties: false })]),
  ),
});

/**
 * The sim worker's end of the recorder channel (ADR-0019 addition of 2026-10-17): the main thread creates a MessageChannel, keeps
 * neither port, and hands one to this worker and one to the storage worker, so trace records never pass through it. The port is
 * transferred (it is a `MessagePort`; the schema cannot say so).
 */
export const SimRecorderPort = Type.Object({ type: Type.Literal("recorderPort"), port: Type.Unknown() });

/**
 * Researcher command (ADR-0015 clarification of 2026-10-04 and addition of 2026-10-12): world scope, recorded by the
 * worker as a run input applied at the next tick boundary, traced as `injected`. `op` is one of the closed set of
 * injectable actions (tools-schema `INJECTABLE_COMMANDS`; the worker refuses any other with `not_injectable`) and
 * `params` are that action's parameters, validated against its tools-schema definition when the action starts, so
 * the preconditions and parameter checks are the ones every mind meets. The shape here is deliberately generic: the
 * protocol never repeats a capability's parameters.
 */
export const SimCommand = Type.Object({
  type: Type.Literal("command"),
  op: Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-zA-Z][a-zA-Z0-9]*$" }),
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  params: Type.Optional(Type.Record(Type.String({ maxLength: 32 }), Type.Union([Type.Number(), Type.String({ maxLength: 64 }), Type.Boolean()]), { maxProperties: 8 })),
});

/** Scenario presets the sim worker can build (F1). */
export const PresetId = Type.Union([Type.Literal("f1-demo"), Type.Literal("f1-reference-1km"), Type.Literal("f2-discovery"), Type.Literal("f2-20-agents"), Type.Literal("f2-prior-1km")]);
export type PresetId = Static<typeof PresetId>;

/**
 * Builds a preset scenario document in the worker (F1 f1): large presets (the 1 km² reference world) are generated
 * and encoded off the main thread, which only passes the document on to storage and back in `load`.
 */
export const SimBuildPreset = Type.Object({
  type: Type.Literal("buildPreset"),
  requestId: Type.Integer({ minimum: 0 }),
  preset: PresetId,
});

/**
 * Which agent the panels are looking at (ADR-0019 addition of 2026-10-12): the worker streams per-agent data (the
 * decision request the mind gets) only for it. Not a run input, never traced, never changes the simulation; `null`
 * stops the stream.
 */
export const SimView = Type.Object({
  type: Type.Literal("view"),
  agentId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
});

/**
 * Asks for the researcher-only comparison of an agent's beliefs with the ground truth (ADR-0005 addition of
 * 2026-10-12), streamed while a panel shows it; `null` stops it. Carries no observer data itself, and nothing in any
 * main → worker message does: observer data travels one way, worker → main.
 */
export const SimResearcherWatch = Type.Object({
  type: Type.Literal("researcherWatch"),
  agentId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
});

/**
 * Asks for the belief map of an agent as chunks (ADR-0019 addition of 2026-10-12), for the Scene's belief overlay,
 * while the overlay is on; `null` stops the stream. Not a run input, never traced, no effect on the simulation.
 */
export const SimBeliefWatch = Type.Object({
  type: Type.Literal("beliefWatch"),
  agentId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
});

/**
 * Asks for the viewed agent's sensor rays and topological layer for the Scene's overlays (ADR-0019 addition of
 * 2026-10-12): each stream runs only while its flag is set and an agent is named; `agentId: null` stops both. Flags and an
 * ID, nothing else; not a run input, never traced, no effect on the simulation.
 */
export const SimOverlayWatch = Type.Object({
  type: Type.Literal("overlayWatch"),
  agentId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  rays: Type.Boolean(),
  topology: Type.Boolean(),
});

/**
 * The researcher's "test on map" request (ADR-0019 and ADR-0037 additions of 2026-10-13): plan from an agent's current
 * position to `to` with a strategy (a shipped one by reference, or an inline document; absent: the agent's own planner) on a
 * snapshot copy of the agent's belief map (`planOn: "belief"`) or on the ground truth (`truth`). A one-shot request answered by
 * `strategyTestResult`; not a run input, never traced, no effect on the simulation. The strategy is data the worker validates.
 */
export const SimStrategyTest = Type.Object({
  type: Type.Literal("strategyTest"),
  requestId: Type.Integer({ minimum: 0 }),
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  strategy: Type.Optional(Type.Unknown()),
  to: Type.Object({ xM: Type.Number(), yM: Type.Number() }, { additionalProperties: false }),
  /** Which map to plan on: a choice of source, not data (the name `map` is kept out of every main → worker message, ADR-0005). */
  planOn: Type.Union([Type.Literal("belief"), Type.Literal("truth")]),
});

export const MainToSim = Type.Union([SimInit, SimControl, SimReturnBuffer, SimRecorderPort, SimLoad, SimCommand, SimBuildPreset, SimView, SimResearcherWatch, SimBeliefWatch, SimOverlayWatch, SimStrategyTest]);
export type MainToSim = Static<typeof MainToSim>;

// ---- worker → main ----------------------------------------------------------------------------

export const SimReady = Type.Object({
  type: Type.Literal("ready"),
  protocolVersion: Type.Literal(SIM_PROTOCOL_VERSION),
  tickRateHz: TickRateHz,
});

export const SimState = Type.Object({
  type: Type.Literal("state"),
  tick: Type.Integer({ minimum: 0 }),
  simTimeS: Type.Number({ minimum: 0 }),
  /** Present only when the entity table changed since the previous state. */
  entityIds: Type.Optional(Type.Array(Type.String())),
  poses: Float32ArrayType,
  /** Per-agent status in entity order, `STATUS_STRIDE` floats each; sent at ≤ 10 Hz, not every tick. */
  agentStatus: Type.Optional(Float32ArrayType),
  /** Wall-clock send time in epoch ms, set by the worker host; for latency metrics only, never sim logic. */
  sentAtEpochMs: Type.Optional(Type.Number({ minimum: 0 })),
});

export const SimStats = Type.Object({
  type: Type.Literal("stats"),
  running: Type.Boolean(),
  mode: TimeMode,
  /** Degradations (realtime tick skips) since the run started; each is also traced. */
  degradations: Type.Integer({ minimum: 0 }),
  tickRateHz: TickRateHz,
  ticksPerSecond: Type.Number({ minimum: 0 }),
  tickTimeMeanMs: Type.Number({ minimum: 0 }),
  tickTimeP95Ms: Type.Number({ minimum: 0 }),
  /** The loaded run, if any. */
  runId: Type.Optional(RunId),
  /** Tick of `stateHash`. */
  tick: Type.Optional(Type.Integer({ minimum: 0 })),
  /** World state hash after `tick` (ADR-0002): diagnostics and the determinism check from the UI. */
  stateHash: Type.Optional(Hash8),
});

/** A realtime degradation (ADR-0013), forwarded for the status line; the trace record stays in the worker. */
export const SimDegradation = Type.Object({
  type: Type.Literal("degradation"),
  tick: Type.Integer({ minimum: 0 }),
  simTimeS: Type.Number({ minimum: 0 }),
  skippedTicks: Type.Integer({ minimum: 1 }),
});

export const SimError = Type.Object({
  type: Type.Literal("error"),
  code: Type.String(),
  message: Type.String(),
});

/** A scenario run was loaded (v2): what the run header needs, and the agent table. */
export const SimLoaded = Type.Object({
  type: Type.Literal("loaded"),
  runId: RunId,
  scenarioId: Type.String({ maxLength: 64 }),
  scenarioVersion: Type.Integer({ minimum: 1 }),
  seed: Type.Integer(),
  timeMode: TimeMode,
  runConfigHash: Hash8,
  effectiveConfigHash: Hash8,
  /** Agents with `ideal` beliefs as resolved by the worker, sorted: copied into the run header (ADR-0028 addition of 2026-10-10). */
  idealAgents: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 4096 }),
  /** IDs of the scenario's prior maps (a run configuration may start agents from one: ADR-0028 addition of 2026-10-09). */
  priors: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 64 })),
  /** Content hash of each prior by ID (what `effectiveConfigHash` records of the one an agent starts from): the run-configuration panel resolves with them. */
  priorHashes: Type.Optional(Type.Record(Type.String({ maxLength: 32 }), Type.String({ maxLength: 16 }), { maxProperties: 64 })),
  dtS: Type.Number({ exclusiveMinimum: 0 }),
  /** The scenario's default seed (the run configuration may override it). */
  defaultSeed: Type.Integer({ minimum: 0 }),
  /** Hash of the loaded grid (all layers), computed once at load: identifies the world content, which `stateHash` does not cover. */
  worldHash: Hash8,
  agents: Type.Array(
    Type.Object({
      id: Type.String({ maxLength: 64 }),
      key: Type.Optional(Type.String({ maxLength: 64 })),
      kind: Type.Union([Type.Literal("ugv"), Type.Literal("uav")]),
      /** Body as authored in the scenario (run-configuration editing resolves over it without parsing the scenario). */
      body: Type.Optional(Type.Unknown()),
      /** Effective configuration (planning, the level that supplied each planning field, resolved body), for the Inspector. */
      config: Type.Optional(Type.Unknown()),
      /** Non-blocking body warnings of the scenario (stable codes). */
      warnings: Type.Optional(Type.Array(Type.Object({ code: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 500 }) }), { maxItems: 32 })),
    }),
    { maxItems: 4096 },
  ),
});

/**
 * New trace records of the loaded run, batched at ≤ 10 Hz for panels (Explorer, Inspector, paths). They are
 * the worker's records as they are; persistence goes through the storage worker (F3), never this channel.
 */
export const SimEvents = Type.Object({
  type: Type.Literal("events"),
  runId: RunId,
  records: Type.Array(Type.Unknown(), { maxItems: 100_000 }),
});

/** The loaded run's grid (once per load): dimensions for the atlas (ADR-0027) and zones as polygons (metres). */
export const SimGrid = Type.Object({
  type: Type.Literal("grid"),
  runId: RunId,
  sizeX: Type.Integer({ minimum: 1, maximum: 8192 }),
  sizeY: Type.Integer({ minimum: 1, maximum: 8192 }),
  resolutionM: Type.Number({ exclusiveMinimum: 0 }),
  chunkSize: Type.Integer({ minimum: 1, maximum: 256 }),
  /** Height assumed for occupied cells without a recorded height (ADR-0012/0025); absent = unlimited for air. */
  defaultObstacleHeightM: Type.Optional(Type.Number({ minimum: 0 })),
  zones: Type.Array(
    Type.Object({ id: Type.String({ maxLength: 64 }), kind: Type.String({ maxLength: 32 }), polygon: Type.Array(Type.Number(), { maxItems: 2048 }) }),
    { maxItems: 1024 },
  ),
});

/**
 * Grid chunks for the atlas (ADR-0027), all of them after a load and the dirty ones after an edit. `coords`
 * holds (ci, cj) pairs; `data` the chunks' cells in the same order, 4 bytes per cell (R occupancy, G terrain,
 * B + A height dm). Both buffers are transferred.
 */
export const SimChunks = Type.Object({
  type: Type.Literal("chunks"),
  runId: RunId,
  gridVersion: Type.Integer({ minimum: 0 }),
  coords: Uint16ArrayType,
  data: Uint8ArrayType,
});

/**
 * New points of the agents' executed paths, recorded by the worker from each tick's state (never from
 * rendering), decimated by distance. `agents` holds each appended point's agent index (entity order); `points`
 * its (x, y, z) in sim metres (`TRAIL_STRIDE`). Batches arrive at ≤ 10 Hz; buffers are transferred.
 *
 * The trail is a bounded display aid (F2 M1b, ADR-0029 addition): when an agent reaches `TRAIL_MAX_POINTS`, the
 * worker thins its points and sends them in `replace`, which supersedes everything received for that agent
 * (apply it before the appends). `replace.offsets[k]..offsets[k+1]` are agent `replace.agents[k]`'s points.
 */
export const SimTrail = Type.Object({
  type: Type.Literal("trail"),
  runId: RunId,
  agents: Uint16ArrayType,
  points: Float32ArrayType,
  replace: Type.Optional(
    Type.Object({
      agents: Uint16ArrayType,
      offsets: Uint32ArrayType,
      points: Float32ArrayType,
    }),
  ),
});

/** A run input was recorded (live command or the input of a re-simulation): the main thread stores it with the run. */
export const SimInput = Type.Object({ type: Type.Literal("input"), runId: RunId, input: RunInputMessage });

/** A preset built on request: the document (passed through by the main thread, never parsed there) and its content hash. */
export const SimPreset = Type.Object({
  type: Type.Literal("preset"),
  requestId: Type.Integer({ minimum: 0 }),
  preset: PresetId,
  document: Type.Unknown(),
  /** `contentHash` of `JSON.stringify(document)`, as storage records it per version. */
  contentHash: Hash8,
});

/**
 * The answer to a `strategyTest`: `ok` with the result (the planned path, the strategy trace with each search's geometry, the
 * lazy legs with their ready ticks, the ticks used, and the map actually planned on), or a refusal with its stable code
 * (`error.path` points into the strategy). A result on the ground truth is researcher data (ADR-0005): the request carries none.
 */
export const SimStrategyTestResult = Type.Object({
  type: Type.Literal("strategyTestResult"),
  requestId: Type.Integer({ minimum: 0 }),
  ok: Type.Boolean(),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), path: Type.Optional(Type.String()) })),
  result: Type.Optional(Type.Unknown()),
});

/**
 * Planning views and HPA* graphs are being built before tick 0 (ADR-0024 "at scenario load"), sent before
 * `loaded`: `done` of `total` distinct views so far.
 */
export const SimPreparing = Type.Object({
  type: Type.Literal("preparing"),
  runId: RunId,
  done: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});

/** Planning preparation finished: what was built and its wall time (never part of the trace or a hash). */
export const SimPrepared = Type.Object({
  type: Type.Literal("prepared"),
  runId: RunId,
  views: Type.Integer({ minimum: 0 }),
  graphs: Type.Integer({ minimum: 0 }),
  ms: Type.Number({ minimum: 0 }),
});

/**
 * The decision request the viewed agent's mind gets (or would get now), serialized exactly as a mind receives it
 * (ADR-0005 addition of 2026-10-12): the world's own builder, JSON text, never a UI-side reconstruction. Panels only,
 * ≤ 10 Hz; `pending` means it is the request the mind has been asked and has not answered yet.
 */
export const SimAgentView = Type.Object({
  type: Type.Literal("agentView"),
  runId: RunId,
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  tick: Type.Integer({ minimum: 0 }),
  pending: Type.Boolean(),
  request: Type.String({ maxLength: 4_000_000 }),
});

/**
 * Researcher-only: how well the agent's beliefs match the ground truth (ADR-0005 addition of 2026-10-12). Observer
 * data: never part of a decision request or any mind-visible summary, never sent back to the worker. Panels only,
 * ≤ 10 Hz, while a panel has asked with `researcherWatch`.
 */
export const SimResearcherData = Type.Object({
  type: Type.Literal("researcherData"),
  runId: RunId,
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  tick: Type.Integer({ minimum: 0 }),
  simTimeS: Type.Number({ minimum: 0 }),
  /** An `ideal` agent's map is the ground truth: no map metrics. */
  ideal: Type.Boolean(),
  map: Type.Optional(
    Type.Object({
      reachableCells: Type.Integer({ minimum: 0 }),
      correctPct: Type.Number(),
      phantomPct: Type.Number(),
      unknownPct: Type.Number(),
      falseFreeCells: Type.Integer({ minimum: 0 }),
      falseFreePct: Type.Number(),
      heightViolations: Type.Integer({ minimum: 0 }),
    }),
  ),
  entities: Type.Object({ total: Type.Integer({ minimum: 0 }), known: Type.Integer({ minimum: 0 }), meanErrM: Type.Number(), maxErrM: Type.Number() }),
});

/**
 * Chunks of the watched agent's belief map that changed since the last batch (all of its materialized chunks after a
 * watch starts or the agent changes), for the belief overlay (ADR-0027): `coords` holds (ci, cj) pairs, `data` the
 * chunks' cells in the same order, ONE byte per cell (0 unknown, 1 believed free, 2 believed occupied), row-major in
 * the chunk. Chunks the agent never observed are omitted (they are all unknown). Both buffers are transferred.
 */
export const SimBeliefChunks = Type.Object({
  type: Type.Literal("beliefChunks"),
  runId: RunId,
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  coords: Uint16ArrayType,
  data: Uint8ArrayType,
});

/**
 * The watched agent's lidar rays of its latest reading (what its sensor saw, decimated to at most 64 per lidar):
 * `segments` holds x0, y0, x1, y1 per ray in sim metres, `hit` whether it ended on an obstacle (otherwise at range).
 * ≤ 5 Hz; buffers transferred.
 */
export const SimRays = Type.Object({
  type: Type.Literal("rays"),
  runId: RunId,
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  tick: Type.Integer({ minimum: 0 }),
  segments: Float32ArrayType,
  hit: Uint8ArrayType,
});

/**
 * The watched agent's topological layer for the overlay (ADR-0039): `regions` holds x0, y0, x1, y1 (m) and the known %
 * per region; `frontiers` x, y (m), cells and a marked-unreachable flag per frontier group (at most 64). Sent when it
 * changed, ≤ 10 Hz; buffers transferred.
 */
export const SimTopology = Type.Object({
  type: Type.Literal("topology"),
  runId: RunId,
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  tick: Type.Integer({ minimum: 0 }),
  regions: Float32ArrayType,
  frontiers: Float32ArrayType,
});

/**
 * How much of its per-tick budgets the run is using (ADR-0013, ADR-0019 addition of 2026-10-12), for the HUD: the wall time
 * of the sensing phase (mean and p95 over the last ticks), the rays the sensors fire per tick, and the planning phase's
 * expansions against the budget of the queries it stepped. Diagnostics only: wall times never enter the trace or a hash.
 * ≈ 3 Hz.
 */
export const SimBudget = Type.Object({
  type: Type.Literal("budget"),
  runId: RunId,
  tick: Type.Integer({ minimum: 0 }),
  sensingMsMean: Type.Number({ minimum: 0 }),
  sensingMsP95: Type.Number({ minimum: 0 }),
  /** Range-sensor rays fired per tick by all agents (rays × rate ÷ tick rate, summed). */
  raysPerTick: Type.Number({ minimum: 0 }),
  /** …of which fired by lidars (the F2 budget scenario counts these: 20 agents × 180 rays). */
  lidarRaysPerTick: Type.Number({ minimum: 0 }),
  /** Planning: expansions spent per tick and the budget of the queries stepped (means over the last ticks), and queries in flight. */
  planningExpansionsPerTick: Type.Number({ minimum: 0 }),
  planningBudgetPerTick: Type.Number({ minimum: 0 }),
  planningQueries: Type.Number({ minimum: 0 }),
});

/**
 * The state of a recorded run's recording (ADR-0035 §6): `storage_backpressure` while the run waits for the writer (the backlog is above its
 * high mark), `storage_quota` while it is paused near the storage quota, `ok` otherwise. Sent when it changes; the status line shows it.
 */
export const SimRecordingState = Type.Object({
  type: Type.Literal("recording"),
  runId: RunId,
  state: Type.Union([Type.Literal("ok"), Type.Literal("storage_backpressure"), Type.Literal("storage_quota")]),
  backlogRecords: Type.Integer({ minimum: 0 }),
  backlogBytes: Type.Integer({ minimum: 0 }),
});

export const SimToMain = Type.Union([SimReady, SimState, SimStats, SimDegradation, SimError, SimLoaded, SimEvents, SimGrid, SimChunks, SimTrail, SimInput, SimPreset, SimPreparing, SimPrepared, SimAgentView, SimResearcherData, SimBeliefChunks, SimRays, SimTopology, SimBudget, SimRecordingState, SimStrategyTestResult]);
export type SimToMain = Static<typeof SimToMain>;
export type SimStateMessage = Static<typeof SimState>;
export type SimStatsMessage = Static<typeof SimStats>;
export type SimLoadedMessage = Static<typeof SimLoaded>;
export type SimLoadMessage = Static<typeof SimLoad>;
export type SimCommandMessage = Static<typeof SimCommand>;
export type SimGridMessage = Static<typeof SimGrid>;
export type SimChunksMessage = Static<typeof SimChunks>;
export type SimTrailMessage = Static<typeof SimTrail>;
export type SimInputMessage = Static<typeof SimInput>;
export type SimAgentViewMessage = Static<typeof SimAgentView>;
export type SimResearcherDataMessage = Static<typeof SimResearcherData>;
export type SimBeliefChunksMessage = Static<typeof SimBeliefChunks>;
export type SimRaysMessage = Static<typeof SimRays>;
export type SimBudgetMessage = Static<typeof SimBudget>;
export type SimTopologyMessage = Static<typeof SimTopology>;
export type SimPresetMessage = Static<typeof SimPreset>;
export type SimStrategyTestMessage = Static<typeof SimStrategyTest>;
export type SimStrategyTestResultMessage = Static<typeof SimStrategyTestResult>;
export type SimPreparedMessage = Static<typeof SimPrepared>;
