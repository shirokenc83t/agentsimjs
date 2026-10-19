// The inventory of a run's mutable state (F3a M1; ADR-0035 addition of 2026-10-17, item 8).
//
// Every field of every class that holds state of a running simulation is classified here, so that a snapshot is
// complete by construction and a new field cannot be forgotten:
//   captured: part of the snapshot; restore puts it back exactly.
//   rebuilt:  not captured; restore (or assembly) reconstructs it from other state, the scenario or the configuration
//             (wiring, parameters, caches, derived views).
//   scratch:  overwritten before it is read in a tick, or empty between ticks, or output that is not run state (the
//             trace's records are persisted by the recorder, not restored).
// `snapshot-inventory.test.ts` walks the objects of real runs and fails when a class gains (or loses) a field that this
// table does not know. Closures hold state too and cannot be walked: they are listed in CLOSURE_STATE with a token the
// test looks for in the source, so removing one is noticed; the ones that matter became explicit state in the core.
//
// Owners: core (world, action runtime, body), the services behind core's ports, and the composition in
// scenarios/assemble.

export type Treatment = "captured" | "rebuilt" | "scratch";

export interface StateItem {
  readonly treatment: Treatment;
  readonly note: string;
  /** The field exists only in some runs or moments (a query in flight, an entity ever seen): its absence is not stale. */
  readonly optional?: true;
}

/** Fields by name; `"*"` classifies every field not listed (a class that is derived data as a whole). */
export type ClassInventory = Readonly<Record<string, StateItem>>;

const c = (note: string, optional?: true): StateItem => ({ treatment: "captured", note, ...(optional ? { optional } : {}) });
const r = (note: string, optional?: true): StateItem => ({ treatment: "rebuilt", note, ...(optional ? { optional } : {}) });
const s = (note: string, optional?: true): StateItem => ({ treatment: "scratch", note, ...(optional ? { optional } : {}) });

const WIRING = "wiring: constructed again when the run is assembled";

/** Classes reached from a run, with the treatment of every own field. */
export const STATE_INVENTORY: Readonly<Record<string, ClassInventory>> = {
  // ---- core: the world loop ----------------------------------------------------------------------------------------
  World: {
    parts: r(WIRING),
    agents: r("the agent objects are shared with sensing, topology, the mind view and the host; their fields are the SimAgent entry"),
    brainAt: r(WIRING),
    inboxes: c("one Inbox per agent (entries and seq)"),
    lastRequestS: c("sim time of each agent's previous request; starts at -Infinity"),
    prevSoc: c("state of charge of the previous tick, for the batteryLow crossing"),
    minDecisionIntervalS: r("run configuration"),
    timers: c("active timers of each agent: tag -> due tick"),
    dtS: c("the last tick's step: timers and requests convert with it"),
    seenSpaces: c("space summaries already traced: decides whether the next request writes a space record"),
    slots: c("requests asked and not yet applied, with their envelopes when answered (outstanding decisions)"),
    unanswered: c("derived from slots; captured so restore can check it"),
    failed: s("a failed world refuses to snapshot"),
    inputLog: c("run inputs recorded so far"),
    nextInput: c("run input ID counter"),
    hasher: s("buffer of the state hash"),
    lastTick: c("last executed tick"),
    lastSimTimeS: c("sim time of the last executed tick"),
    lastHash: c("the hash the last tick reported: taken before that tick's requests empty the inbox, so it is not recomputable from the state a snapshot leaves; WorldSnapshot.checkHash validates the restore instead"),
  },
  Inbox: {
    entries: c("undelivered events in arrival order, with their tick and seq"),
    seq: c("arrival counter"),
  },
  ScriptBrain: {
    tier: r("constant"),
    id: r(WIRING),
    steps: r(WIRING),
    cursor: c("steps already returned"),
  },
  Clock: {
    dtS: r("run configuration"),
    t: c("the tick count (setTick restores it)"),
  },
  Scheduler: {
    world: r(WIRING),
    clock: c("the Clock"),
  },
  // ---- core: actions and body ---------------------------------------------------------------------------------------
  ActionRuntime: {
    ports: r(WIRING),
    dtS: r("run configuration"),
    nextAction: c("action ID counter"),
    active: c("the running behaviour of each agent: info (an Active entry) and its state (GoToBehavior, ExploreBehavior, closures)"),
    last: c("each agent's current or latest action info (result and failure are plain data)"),
    ended: s("taken by the world every tick: empty between ticks (the runtime's snapshot asserts it)"),
    manifestHashCache: r("cache of the capability manifest hash"),
    recovering: c("agents whose running action is a reflex recovery"),
  },
  GoToBehavior: {
    ports: r(WIRING),
    agent: r("the shared SimAgent"),
    tx: c("action parameter"),
    ty: c("action parameter"),
    cruise: c("action parameter (UAV altitude)"),
    returning: c("action parameter (returnToBase)"),
    note: r("closure over the runtime's emit: rebuilt from context"),
    guard: r("closure over the reflexes: rebuilt from context"),
    onUnreachable: r("closure over the frontier port's markAt: rebuilt from context"),
    phase: c("planning, climbing, following, backing-off, landing"),
    queryId: c("the planner query in flight; PlanningService.snapshot holds the query itself"),
    follower: c("PathFollower, including which parameter variant it was built with (a back-off or escape uses a tighter arrival tolerance)"),
    backingOff: c(""),
    recoveries: c(""),
    planMap: r("the agent's live planning view as of the plan: rebuilt from the planner's live view"),
    uavPath: c("remaining UAV waypoints"),
    uavIndex: c(""),
    planVersion: c("belief plan version the path was last checked against (the restored map keeps its versions)"),
    replans: c(""),
    excursionPeakM: c("open tracking excursion"),
    legsPending: c("lazy plan: legs still being planned"),
    holdStartS: c("lazy plan: start of a hold between legs"),
    predictedEnd: c("end pose of the last accepted leg's pre-drive check"),
    window: c("action parameter of an explore target's goTo: the search window of every query (absent for a plain goTo)"),
  },
  ExploreBehavior: {
    phase: c(""),
    inner: c("the GoToBehavior of the current target"),
    target: c("the frontier candidate being approached"),
    mode: c("what the target is for: a group of the iteration, or the travel to the next centre"),
    originKey: c("the centre the target's failure counts against"),
    targetWindow: c("the search window of the target's queries, for the trace of a mark"),
    iteration: c("the iteration in progress: number, centre, window, groups visited before it"),
    iterations: c("iterations begun so far"),
    failures: c("per frontier cell: the centres it failed from and the travels that failed (ADR-0040)"),
    visited: c(""),
    marked: c(""),
    distanceM: c(""),
    waitedS: c("seconds spent waiting for a first reading"),
    radiusM: c("action parameter: the radius of an iteration, fixed when the action started"),
    marginM: c("action parameter: the margin of the search windows, fixed when the action started"),
    planMap: r("closure over the planner's current map: rebuilt from context"),
    frontiers: r(WIRING),
    agent: r("the shared SimAgent"),
    region: c("action parameter"),
    strategy: c("action parameter"),
    cruise: c("cruise altitude of every goTo of the explore: a UAV's height when the action started (a restore must not read it from the agent again)"),
    note: r("closure: rebuilt from context"),
    navigate: r("closure that builds the inner goTo: rebuilt from context (and the captured cruise)"),
  },
  HoldBehavior: {
    phase: c("holding"),
    agent: r("the shared SimAgent"),
    dtS: r("run configuration"),
    ticks: c("duration in ticks; Infinity for an open hold"),
    held: c("ticks held so far"),
  },
  TakeoffBehavior: {
    phase: c("climbing"),
    s: r("the shared agent's UavState"),
    b: r("the agent's body parameters"),
    x: c("where the climb started: it rises straight up from here"),
    y: c("where the climb started"),
    altitudeM: c("action parameter"),
  },
  PathFollower: {
    p: r("follower parameters from the body; the arrival tolerance a back-off or escape follower was built with is part of FollowerSnapshot"),
    stuckAfterS: r("constant of the follower"),
    index: c("segment being driven"),
    pursuit: c("the PurePursuit of the current segment"),
    virt: s("rewritten at the start of every update"),
    cmd: s("rewritten at the start of every update"),
    segments: c("path points and direction of every segment, including legs appended by a lazy plan"),
  },
  PurePursuit: {
    path: c("the points, including legs appended by extend()"),
    p: r("derived from the follower's segment and parameters"),
    stuckAfterS: r("constant of the follower"),
    segment: c("progress along the path"),
    bestDistance: c("closest approach to the goal so far (starts at +Infinity)"),
    sinceProgressS: c("no-progress timer"),
    cmd: s("rewritten at every update"),
  },
  // ---- core shapes without a class ---------------------------------------------------------------------------------
  SimAgent: {
    id: r("scenario"),
    key: r("scenario", true),
    base: r("scenario", true),
    kind: r("scenario"),
    body: r("resolved body parameters of the run configuration"),
    battery: c("BatteryState"),
    state: c("UgvState or UavState"),
    odometerM: c("metres since the current action started"),
  },
  UgvState: {
    x: c(""),
    y: c(""),
    heading: c(""),
    speed: c(""),
    steering: c(""),
    lastStepM: c("set to 0 at the start of every tick, but read by the next tick's reflexes and hash: captured"),
    lastRotationRad: c("never reset when the agent stops driving, and it keeps draining the battery (pinned, not fixed: see rotation-drain.test.ts)"),
  },
  UavState: {
    x: c(""),
    y: c(""),
    z: c(""),
    heading: c(""),
    airborne: c(""),
    lastStepM: c(""),
  },
  BatteryState: {
    soc: c("state of charge"),
  },
  Pending: {
    agentId: c("a request of the World's slots"),
    request: c("plain data"),
    envelope: c("the answer, once received", true),
  },
  Active: {
    info: c("actionId, agentId, name, startedTick"),
    behavior: c("see GoToBehavior, ExploreBehavior and CLOSURE_STATE"),
  },
  ActionInfo: {
    actionId: c(""),
    agentId: c(""),
    name: c(""),
    status: c(""),
    phase: c(""),
    startedTick: c(""),
    endedTick: c("", true),
    failure: c("", true),
    result: c("", true),
  },
  // ---- trace ---------------------------------------------------------------------------------------------------------
  TraceBuffer: {
    runId: r(WIRING),
    nowWallMs: r(WIRING),
    capacity: r(WIRING),
    records: s("output, persisted by the recorder (F3a M2), not restored; a restored run's records after the snapshot continue the sequence"),
    seq: c("next record sequence number"),
    lastSimTime: c("trace time never goes backwards"),
    droppedCount: s("statistic of the in-memory buffer"),
    holding: r("set when the run's recorder attaches (a recorded run's cache forgets only what is persisted); a restored run builds its own"),
    persistedSeq: s("cache bookkeeping: how far the storage worker has saved the run's records"),
    tracers: r("cache of handles by source"),
  },
  TraceBufferSink: { buffer: r(WIRING) },
  StateHasher: { "*": s("buffer") },
  // ---- sensing (scenarios/assemble) ---------------------------------------------------------------------------------
  SensingService: {
    grid: r("ground truth, immutable during a run"),
    objects: r("scenario"),
    trace: r(WIRING),
    ideal: r("run configuration"),
    byId: c("AgentSensing of each agent: belief map, entity beliefs, latest proximity hits, sensor RNG state and dropout"),
    order: r("the same AgentSensing objects as byId, in ID order"),
    cameraScratch: s("buffers of a camera reading"),
    tickUs: r("run configuration"),
    pending: s("perception events of the tick, taken by the world in the same tick: empty between ticks (snapshot() asserts it)"),
    rayRec: s("observation-only ray recorder for the Scene overlay: no rng, no hash input"),
    curTick: s("set at the start of every sense(); read only by the observation-only ray recorder"),
  },
  AgentSensing: {
    agent: r("the shared SimAgent"),
    sensors: c("SensorState of each sensor: rng state and dropped"),
    belief: c("BeliefMap (a content-addressed section of the snapshot)"),
    entities: c("EntityBelief by id, in insertion order (it drives the order of `lost` events and so of the inbox)"),
    proximity: c("latest proximity hit points: read by the obstacle reflex until the next proximity reading"),
  },
  SensorState: {
    spec: r("run configuration"),
    periodUs: r("derived from the spec"),
    phaseUs: r("derived from the spec and the agent"),
    rng: c("Rng state, set in place so the noise closure stays valid"),
    scratch: s("buffers of a range reading"),
    window: s("ReadingWindow"),
    ray: s("one reused ray object"),
    noise: r("closure over rng"),
    rayCos: r("derived from the spec with detmath"),
    raySin: r("derived from the spec with detmath"),
    dropped: c("in a dropout streak"),
  },
  EntityBelief: {
    xM: c(""),
    yM: c(""),
    zM: c(""),
    observedAtS: c(""),
    kind: c(""),
    lost: c("a `lost` event was raised (derived from time, not hashed, but it decides the next events)"),
  },
  ReadingWindow: { "*": s("rewritten from scratch at every reading (a reading stamp compares against 0 on a fresh window)") },
  Rng: {
    seed: r("derived from the run seed and the stream path"),
    path: r("stream path"),
    s: c("xoshiro128** state"),
    spareNormal: c("Box-Muller spare; NaN when empty"),
  },
  // ---- topology (scenarios/assemble, spatial) -----------------------------------------------------------------------
  TopologyService: {
    viewOf: r(WIRING),
    trace: r(WIRING),
    positionOf: r(WIRING),
    byAgent: r("AgentTopology of each agent: derived from its belief map"),
    marks: c("unreachable marks of each agent (Marks), re-based onto the rebuilt views' version counters"),
    temporary: c("temporary marks of each agent's exploration iteration (Marks), re-based like the marks"),
    hadFrontier: c("per agent: had an unmarked frontier at the last update (reaching none is the `frontierExhausted` transition)"),
    witness: r("cache of one unmarked frontier group"),
    watchedAt: r("cache of the last look's stamp"),
    exhausted: s("taken by the world every tick: empty between ticks (snapshot() asserts it)"),
    rangeSensors: r("derived from the run configuration"),
    ids: r("run configuration"),
    build: r("builds an agent's layer over its map: at assembly, and again on a restore (the layer is derived data)"),
  },
  Marks: {
    byChunk: c("marked cells per chunk and the view content version they were marked at", true),
    checkedAt: c("view content version at the last clearing check", true),
    rev: c("change stamp", true),
  },
  AgentTopology: { "*": r("the topological layer is derived data, maintained from the planning grid's dirty chunks and rebuilt from the restored map") },
  BeliefGrid: {
    belief: c("the BeliefMap, shared with sensing, topology, the observer and the planner"),
    "*": r("mission data and the prior are immutable inputs; the rest is geometry and caches"),
  },
  BeliefMap: {
    sizeX: r("geometry"),
    sizeY: r("geometry"),
    chunkSize: r("geometry"),
    cellLog: s("the recording's tracking of cells changed since its last belief delta: observation only; a restored run's recording starts its own"),
    chunks: c("materialized chunks: log-odds Int8 and height bounds Uint16, a content-addressed section per map"),
    chunkVersion: c("change stamp of each chunk: planners and views compare against it"),
    versionCounter: c(""),
    chunkPlanVersion: c(""),
    planVersionCounter: c("plan versions are compared across ticks by views, queries and goTo's planVersion"),
    planLog: c("change log views read with cellsPlanChangedSince"),
    logLength: c(""),
    logFirst: c(""),
    materialized: r("count of materialized chunks"),
    hashedAt: r("hash cache"),
    chunkHash: r("hash cache"),
    chunksX: r("geometry"),
    chunksY: r("geometry"),
    shift: r("geometry"),
    mask: r("geometry"),
  },
  // ---- planning (algorithms, scenarios/assemble) --------------------------------------------------------------------
  PlanningService: {
    grid: r("ground truth, immutable during a run"),
    opts: r(WIRING),
    active: c("queries in flight: PlanningSnapshot keeps (request, charge, restarts, continuations, spent) and, since the ADR-0024 addition of 2026-10-17, the change of the view a query has not examined (pending chunks, graph moved) with the chunks its search has read"),
    completed: s("drained by the adapter every tick: empty between ticks"),
    restartEvents: s("drained by the adapter every tick: empty between ticks"),
    views: r("live planning views and graphs: rebuilt from the restored maps (ADR-0024: caches never change results)"),
    nextViewId: r("ID of views, not part of any output"),
    retained: r("the last completed plan's views: rebuilt with the views"),
    results: r("result cache: a hit is charged what the search cost, so it changes wall time only"),
    nextQuery: c("query ID counter"),
    cachesEnabled: r("run configuration"),
    pinned: r("view keys built by prepare()"),
    lazy: c("legs of lazy queries: produced and taken counts; the adapter's snapshot asserts untaken legs are empty between ticks", true),
    diagnostics: s("host diagnostics"),
    lastTick: s("statistics of the last tick for the host"),
    smoothMemo: r("cache of a smoothed path"),
  },
  PlanningServiceAdapter: {
    service: c("the PlanningService"),
    knownMap: r(WIRING),
    trace: r(WIRING),
    beliefGrids: r(WIRING),
    completed: s("outcomes of completed queries are taken in the tick they complete: empty between ticks (snapshot() asserts it, with the service's outputs and lazy legs)"),
    configs: c("each agent's effective planning configuration: the snapshot keeps the ones setConfig changed"),
    initial: r("each agent's configuration at assembly: what `configs` is compared with"),
  },
  ActiveQuery: {
    "*": c("a query in flight: PlanningSnapshot keeps (request, charge, restarts, continuations, spent, strategy, pending change and read set); engines and views are rebuilt by replay; `carry` is a restored query's pending change until its next slice"),
  },
  // ---- observer and views -------------------------------------------------------------------------------------------
  // The observer-side beliefs-vs-truth class is classified in snapshot-inventory.test.ts, not here: ADR-0005 allows only
  // its own module, its export and createRun to name it (tools/lint/belief-vs-truth-boundary.test.ts). Its tracker shape:
  Tracker: { "*": r("derived tallies of one agent's map against the truth") },
  MindViewService: {
    sensing: r(WIRING),
    topology: r(WIRING),
    planner: r(WIRING),
    byId: r(WIRING),
  },
  GridSpatialAdapter: { grid: r("ground truth, immutable during a run") },
};

/**
 * Classes reachable from a run that hold no run state, and why. A class that is in neither table is a failure of
 * `snapshot-inventory.test.ts`: classify it.
 */
export const NOT_STATE: Readonly<Record<string, string>> = {
  GridSpace: "ground truth: immutable while a run executes (grid changes, if ever, are an input)",
  ChunkedLayer: "a layer of the ground truth",
  OccupancyPyramid: "derived from the ground truth",
  ZoneSet: "scenario zones: immutable",
  SpatialHash: "derived from the ground truth",
  SearchSpace: "a planning view: derived from a map, rebuilt (ADR-0024)",
  GridSearch: "a search engine: rebuilt by replay to the expansions charged (ADR-0024)",
  NodeTable: "a search engine's tables",
  OpenHeap: "a search engine's open list",
  HpaQuery: "a search engine: rebuilt by replay",
  AbstractGraph: "an HPA* graph: derived from a view",
  ClusterDijkstra: "derived from an HPA* graph",
  StrategyRunner: "a strategy's runner is pure: rebuilt by replay of the completed stages (StrategySnapshot)",
};

/** State kept in closures, which no walk can see. `token` must be found in `file` (relative to packages/). */
export interface ClosureState {
  readonly where: string;
  readonly file: string;
  readonly token: string;
  readonly treatment: Treatment;
  readonly note: string;
}

export const CLOSURE_STATE: readonly ClosureState[] = [
  { where: "land behaviour", file: "core/src/actions/runtime.ts", token: 'phase: "descending"', treatment: "rebuilt", note: "reads only the agent's state and the ground: nothing of its own beyond its phase (LandSnapshot)" },
  { where: "battery reflex latch: fired", file: "core/src/reflexes/builtin.ts", token: "const fired = new Set<string>()", treatment: "captured", note: "agents the critical-battery reflex already acted on: handed over by Reflex.snapshot and put back by Reflex.restore " },
  { where: "sensing noise closure", file: "scenarios/src/assemble/sensing.ts", token: "noise: spec.type !== \"camera\"", treatment: "rebuilt", note: "draws from the sensor's Rng, which is captured" },
  { where: "TopologyService constructor closures (viewOf, positionOf)", file: "scenarios/src/assemble/topology.ts", token: "private readonly viewOf", treatment: "rebuilt", note: "wiring" },
  { where: "PlanningServiceAdapter.take / takeLegs map objects", file: "scenarios/src/assemble/adapters.ts", token: "get version()", treatment: "rebuilt", note: "views onto the live planning view, created when a plan is taken" },
];
