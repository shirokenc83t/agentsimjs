import { describe, expect, it } from "vitest";
import { validate } from "../contracts/validation.ts";
import { SIM_PROTOCOL_VERSION } from "./constants.ts";
import { MainToSim, SimToMain } from "./messages.ts";

describe("sim worker protocol", () => {
  it("accepts well-formed main → worker messages", () => {
    for (const m of [
      { type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 },
      { type: "control", op: "play" },
      { type: "control", op: "setTickRate", tickRateHz: 20 },
      { type: "control", op: "setMode", mode: "realtime" },
      { type: "return-buffer", buffer: new ArrayBuffer(16) },
    ]) {
      expect(validate(MainToSim, m).ok, JSON.stringify(m)).toBe(true);
    }
  });

  it("rejects unknown versions, ops and bad payloads with a stable code", () => {
    for (const m of [
      { type: "init", protocolVersion: 999, tickRateHz: 10 },
      { type: "control", op: "explode" },
      { type: "control", op: "setMode", mode: "warp" },
      { type: "control", op: "setTickRate", tickRateHz: 0 },
      { type: "return-buffer", buffer: [1, 2, 3] },
      null,
    ]) {
      const r = validate(MainToSim, m);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid");
    }
  });

  it("requires state poses to be a Float32Array", () => {
    const base = { type: "state", tick: 3, simTimeS: 0.3 };
    expect(validate(SimToMain, { ...base, poses: new Float32Array(4) }).ok).toBe(true);
    expect(validate(SimToMain, { ...base, poses: [0, 0, 0, 0] }).ok).toBe(false);
    expect(validate(SimToMain, { ...base, tick: -1, poses: new Float32Array(4) }).ok).toBe(false);
  });

  it("treats optional fields with exact optional semantics", () => {
    const r = validate(SimToMain, { type: "state", tick: 1, simTimeS: 0.1, entityIds: undefined, poses: new Float32Array(0) });
    expect(r.ok).toBe(false);
  });

  it("v2: load a scenario run, step several ticks, and report what was loaded", () => {
    const load = { type: "load", runId: "run-000003", scenario: { any: "document" }, scenarioVersion: 2, runConfig: { schemaVersion: 0 } };
    expect(validate(MainToSim, load).ok).toBe(true);
    expect(validate(MainToSim, { ...load, runId: "live" }).ok).toBe(false);
    expect(validate(MainToSim, { ...load, scenarioVersion: 0 }).ok).toBe(false);
    expect(validate(MainToSim, { type: "control", op: "step", count: 100 }).ok).toBe(true);
    expect(validate(MainToSim, { type: "control", op: "step", count: 0 }).ok).toBe(false);
    expect(validate(MainToSim, { type: "control", op: "step", count: 100_001 }).ok).toBe(false);
    const loaded = {
      type: "loaded",
      runId: "run-000003",
      scenarioId: "f1-demo",
      scenarioVersion: 2,
      seed: 1,
      timeMode: "lockstep",
      runConfigHash: "0123abcd",
      effectiveConfigHash: "89abcdef",
      idealAgents: [],
      dtS: 0.1,
      defaultSeed: 1,
      worldHash: "1cb21b01",
      agents: [{ id: "ugv-001", key: "rover", kind: "ugv", body: { maxSpeedMps: 1.5 } }],
    };
    expect(validate(SimToMain, loaded).ok).toBe(true);
    expect(validate(SimToMain, { ...loaded, runConfigHash: "xyz" }).ok).toBe(false);
    expect(validate(SimToMain, { ...loaded, worldHash: "not-a-hash" }).ok).toBe(false);
  });

  it("v2: `view` names the agent the panels look at (or none) and `agentView` carries its decision request as JSON text", () => {
    expect(validate(MainToSim, { type: "view", agentId: "ugv-001" }).ok).toBe(true);
    expect(validate(MainToSim, { type: "view", agentId: null }).ok).toBe(true);
    expect(validate(MainToSim, { type: "view", agentId: "" }).ok).toBe(false);
    const msg = { type: "agentView", runId: "run-000001", agentId: "ugv-001", tick: 12, pending: false, request: "{}" };
    expect(validate(SimToMain, msg).ok).toBe(true);
    expect(validate(SimToMain, { ...msg, request: { agentId: "ugv-001" } }).ok).toBe(false); // text as the mind gets it, not an object
    expect(validate(SimToMain, { ...msg, pending: "no" }).ok).toBe(false);
  });

  it("v2: `beliefWatch` names the agent whose belief map the overlay shows; `beliefChunks` carries one byte per cell, transferred", () => {
    expect(validate(MainToSim, { type: "beliefWatch", agentId: "ugv-001" }).ok).toBe(true);
    expect(validate(MainToSim, { type: "beliefWatch", agentId: null }).ok).toBe(true);
    expect(validate(MainToSim, { type: "beliefWatch", agentId: "" }).ok).toBe(false);
    const msg = { type: "beliefChunks", runId: "run-000001", agentId: "ugv-001", coords: new Uint16Array([1, 2]), data: new Uint8Array(32 * 32) };
    expect(validate(SimToMain, msg).ok).toBe(true);
    expect(validate(SimToMain, { ...msg, data: [0, 1] }).ok).toBe(false);
    expect(validate(SimToMain, { ...msg, coords: new Float32Array([1, 2]) }).ok).toBe(false);
    expect(validate(MainToSim, msg).ok).toBe(false); // belief data goes worker → main only
  });

  it("v2: `overlayWatch` names the viewed agent and which overlay streams run; `rays` and `topology` carry typed arrays, worker → main only", () => {
    expect(validate(MainToSim, { type: "overlayWatch", agentId: "ugv-001", rays: true, topology: false }).ok).toBe(true);
    expect(validate(MainToSim, { type: "overlayWatch", agentId: null, rays: false, topology: false }).ok).toBe(true);
    expect(validate(MainToSim, { type: "overlayWatch", agentId: "ugv-001", rays: "yes", topology: false }).ok).toBe(false);
    const rays = { type: "rays", runId: "run-000001", agentId: "ugv-001", tick: 4, segments: new Float32Array([0, 0, 1, 1]), hit: new Uint8Array([1]) };
    expect(validate(SimToMain, rays).ok).toBe(true);
    expect(validate(SimToMain, { ...rays, segments: [0, 0, 1, 1] }).ok).toBe(false);
    const topo = { type: "topology", runId: "run-000001", agentId: "ugv-001", tick: 4, regions: new Float32Array(5), frontiers: new Float32Array(4) };
    expect(validate(SimToMain, topo).ok).toBe(true);
    expect(validate(MainToSim, rays).ok).toBe(false);
    expect(validate(MainToSim, topo).ok).toBe(false);
  });

  it("v2: `budget` carries the HUD's sensing and planning figures, worker → main only", () => {
    const msg = { type: "budget", runId: "run-000001", tick: 40, sensingMsMean: 0.4, sensingMsP95: 0.6, raysPerTick: 3760, lidarRaysPerTick: 3600, planningExpansionsPerTick: 100, planningBudgetPerTick: 300, planningQueries: 1 };
    expect(validate(SimToMain, msg).ok).toBe(true);
    expect(validate(SimToMain, { ...msg, sensingMsMean: -1 }).ok).toBe(false);
    expect(validate(MainToSim, msg).ok).toBe(false);
  });

  it("`cellWatch` asks for one cell (or stops), and what comes back, `cellBeliefs`, goes worker → main only", () => {
    expect(validate(MainToSim, { type: "cellWatch", cell: { i: 3, j: 4 } }).ok).toBe(true);
    expect(validate(MainToSim, { type: "cellWatch", cell: null }).ok).toBe(true);
    expect(validate(MainToSim, { type: "cellWatch", cell: { i: -1, j: 0 } }).ok).toBe(false);
    expect(validate(MainToSim, { type: "cellWatch", cell: { i: 1.5, j: 0 } }).ok).toBe(false);
    const data = { type: "cellBeliefs", runId: "run-000001", i: 3, j: 4, tick: 5, agents: [{ agentId: "ugv-001", state: "free" }, { agentId: "ugv-002", state: "ideal" }] };
    expect(validate(SimToMain, data).ok).toBe(true);
    expect(validate(SimToMain, { ...data, agents: [{ agentId: "ugv-001", state: "maybe" }] }).ok).toBe(false);
    expect(validate(MainToSim, data).ok).toBe(false);
  });

  it("researcher data travels one way: `researcherWatch` and no other main → worker message carries observer fields", () => {
    expect(validate(MainToSim, { type: "researcherWatch", agentId: "ugv-001" }).ok).toBe(true);
    expect(validate(MainToSim, { type: "researcherWatch", agentId: null }).ok).toBe(true);
    expect(validate(MainToSim, { type: "researcherWatch", agentId: "" }).ok).toBe(false);
    const data = { type: "researcherData", runId: "run-000001", agentId: "ugv-001", tick: 5, simTimeS: 0.5, ideal: false, entities: { total: 2, known: 1, meanErrM: 0, maxErrM: 0 }, map: { reachableCells: 10, correctPct: 1, phantomPct: 0, unknownPct: 99, falseFreeCells: 0, falseFreePct: 0, heightViolations: 0 } };
    expect(validate(SimToMain, data).ok).toBe(true);
    expect(validate(MainToSim, data).ok).toBe(false); // not a message the worker accepts
    // Every property name that any main → worker message can carry (nested ones included).
    const names = new Set<string>();
    const walk = (schema: unknown): void => {
      if (!schema || typeof schema !== "object") return;
      const o = schema as { properties?: Record<string, unknown>; anyOf?: unknown[]; items?: unknown; additionalProperties?: unknown; patternProperties?: Record<string, unknown> };
      for (const [k, v] of Object.entries(o.properties ?? {})) {
        names.add(k);
        walk(v);
      }
      for (const v of o.anyOf ?? []) walk(v);
      walk(o.items);
      for (const v of Object.values(o.patternProperties ?? {})) walk(v);
    };
    walk(MainToSim);
    for (const observerField of ["correctPct", "phantomPct", "unknownPct", "falseFreeCells", "falseFreePct", "heightViolations", "reachableCells", "meanErrM", "maxErrM", "known", "ideal", "map", "entities", "researcher"]) {
      expect(names.has(observerField), observerField).toBe(false);
    }
  });

  it("presets are built in the worker: buildPreset names a known preset; preset returns the document and its content hash", () => {
    expect(validate(MainToSim, { type: "buildPreset", requestId: 1, preset: "f1-reference-1km" }).ok).toBe(true);
    expect(validate(MainToSim, { type: "buildPreset", requestId: 1, preset: "anything" }).ok).toBe(false);
    expect(validate(SimToMain, { type: "preset", requestId: 1, preset: "f1-demo", document: { id: "f1-demo" }, contentHash: "0123abcd" }).ok).toBe(true);
    expect(validate(SimToMain, { type: "preset", requestId: 1, preset: "f1-demo", document: {}, contentHash: "zz" }).ok).toBe(false);
  });

  it("v2: state carries an optional per-agent status block; events and the state hash travel at low rate", () => {
    const base = { type: "state", tick: 3, simTimeS: 0.3, poses: new Float32Array(4) };
    expect(validate(SimToMain, { ...base, agentStatus: new Float32Array(4) }).ok).toBe(true);
    expect(validate(SimToMain, { ...base, agentStatus: [1, 2] }).ok).toBe(false);
    expect(validate(SimToMain, { type: "events", runId: "run-000001", records: [{ kind: "action" }] }).ok).toBe(true);
    const stats = { type: "stats", running: false, mode: "lockstep", degradations: 0, tickRateHz: 10, ticksPerSecond: 0, tickTimeMeanMs: 0, tickTimeP95Ms: 0 };
    expect(validate(SimToMain, { ...stats, runId: "run-000001", tick: 100, stateHash: "deadbeef" }).ok).toBe(true);
    expect(validate(SimToMain, { ...stats, stateHash: "nothex!!" }).ok).toBe(false);
  });

  it("v2: grid metadata and chunk batches for the atlas (typed arrays only)", () => {
    const grid = { type: "grid", runId: "run-000001", sizeX: 128, sizeY: 128, resolutionM: 0.5, chunkSize: 32, zones: [{ id: "base", kind: "base", polygon: [2, 2, 8, 2, 8, 8, 2, 8] }] };
    expect(validate(SimToMain, grid).ok).toBe(true);
    expect(validate(SimToMain, { ...grid, sizeX: 9000 }).ok).toBe(false);
    const chunks = { type: "chunks", runId: "run-000001", gridVersion: 3, coords: new Uint16Array([0, 0]), data: new Uint8Array(32 * 32 * 4) };
    expect(validate(SimToMain, chunks).ok).toBe(true);
    expect(validate(SimToMain, { ...chunks, data: [1, 2, 3] }).ok).toBe(false);
  });

  it("v2: run inputs travel with a load (replay) and back to the main thread (storage)", () => {
    const input = { inputId: "inp-000001", tick: 6, agentId: "ugv-001", name: "goTo", params: { xM: 1, yM: 2 } };
    const load = { type: "load", runId: "run-000002", scenario: {}, scenarioVersion: 1, runConfig: {}, inputs: [input] };
    expect(validate(MainToSim, load).ok).toBe(true);
    expect(validate(MainToSim, { ...load, inputs: [{ ...input, tick: 0 }] }).ok).toBe(false);
    expect(validate(SimToMain, { type: "input", runId: "run-000002", input }).ok).toBe(true);
    expect(validate(SimToMain, { type: "input", runId: "run-000002", input: { ...input, inputId: "x" } }).ok).toBe(false);
  });

  it("v2: a researcher command names an action and carries its parameters (the closed set is the worker's check)", () => {
    expect(validate(MainToSim, { type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } }).ok).toBe(true);
    expect(validate(MainToSim, { type: "command", op: "land", agentId: "uav-001" }).ok).toBe(true);
    expect(validate(MainToSim, { type: "command", op: "explore", agentId: "ugv-001", params: { strategy: "largest" } }).ok).toBe(true);
    expect(validate(MainToSim, { type: "command", op: "goTo", agentId: "", params: { xM: 1, yM: 2 } }).ok).toBe(false);
    expect(validate(MainToSim, { type: "command", op: "go to", agentId: "ugv-001" }).ok).toBe(false);
    expect(validate(MainToSim, { type: "command", op: "goTo", agentId: "ugv-001", params: { xM: { nested: 1 } } }).ok).toBe(false);
  });

  it("v2: executed-path points are typed arrays (agent index; x, y, z), with an optional replace of whole trails", () => {
    const trail = { type: "trail", runId: "run-000001", agents: new Uint16Array([0]), points: new Float32Array([1, 2, 0]) };
    expect(validate(SimToMain, trail).ok).toBe(true);
    expect(validate(SimToMain, { ...trail, points: [1, 2, 0] }).ok).toBe(false);
    expect(validate(SimToMain, { ...trail, points: new Float64Array([1, 2, 0]) }).ok).toBe(false);
    // Agent 1's trail is replaced by its 2 thinned points: offsets index points, one more than the agents.
    const replace = { agents: new Uint16Array([1]), offsets: new Uint32Array([0, 2]), points: new Float32Array([0, 0, 0, 4, 4, 0]) };
    expect(validate(SimToMain, { ...trail, replace }).ok).toBe(true);
    expect(validate(SimToMain, { ...trail, replace: { ...replace, offsets: [0, 2] } }).ok).toBe(false);
  });

  it("v2: planning preparation before `loaded` reports progress, then what was built and its wall time", () => {
    expect(validate(SimToMain, { type: "preparing", runId: "run-000001", done: 0, total: 3 }).ok).toBe(true);
    expect(validate(SimToMain, { type: "preparing", runId: "run-000001", done: -1, total: 3 }).ok).toBe(false);
    expect(validate(SimToMain, { type: "preparing", runId: "run-000001", done: 1.5, total: 3 }).ok).toBe(false);
    const prepared = { type: "prepared", runId: "run-000001", views: 2, graphs: 1, ms: 1650.4 };
    expect(validate(SimToMain, prepared).ok).toBe(true);
    expect(validate(SimToMain, { ...prepared, ms: -1 }).ok).toBe(false);
    expect(validate(SimToMain, { ...prepared, runId: "live" }).ok).toBe(false);
  });

  it("validates degradation and stats messages", () => {
    expect(validate(SimToMain, { type: "degradation", tick: 12, simTimeS: 1.2, skippedTicks: 3 }).ok).toBe(true);
    expect(validate(SimToMain, { type: "degradation", tick: 12, simTimeS: 1.2, skippedTicks: 0 }).ok).toBe(false);
    const stats = { type: "stats", running: true, mode: "lockstep", degradations: 0, tickRateHz: 10, ticksPerSecond: 10, tickTimeMeanMs: 0.1, tickTimeP95Ms: 0.2 };
    expect(validate(SimToMain, stats).ok).toBe(true);
    expect(validate(SimToMain, { ...stats, mode: undefined }).ok).toBe(false);
  });
});
