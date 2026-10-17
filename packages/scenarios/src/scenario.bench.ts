import { runLockstep } from "@agentsim/core";
import { expect, it } from "vitest";
import { measure, recordResults, summarize } from "../../../tools/bench/measure.ts";
import { buildReferenceWorld } from "@agentsim/spatial";
import { TraceBuffer } from "@agentsim/trace";
import { assembleRun, preparePlanning } from "./assemble/assemble.ts";
import { createRun } from "./assemble/run.ts";
import { scenarioFromGrid, serializeScenario } from "./encode.ts";
import { loadScenario } from "./load.ts";
import { resolveRunConfig } from "./run-config/resolve.ts";
import { parseScenario, utf8Length } from "./validate.ts";

// ADR-0025: the reference scenario's size (raw vs encoded) is reported in the F1 changelog. Report only.
it("reference scenario document: size, parse and load time", () => {
  const grid = buildReferenceWorld();
  const doc = scenarioFromGrid({ id: "reference", name: "Reference 1 km² / 0.5 m", defaultSeed: 1 }, grid, [], [{ kind: "ugv", start: { xM: 1, yM: 1 } }]);
  const text = serializeScenario(doc);
  const bytes = utf8Length(text);
  const compact = utf8Length(JSON.stringify(doc));
  const parse = measure({ iterations: 10, warmup: 2, setup: () => text, run: (t) => void parseScenario(t) });
  const parsed = parseScenario(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const load = measure({ iterations: 10, warmup: 2, setup: () => parsed.value, run: (d) => void loadScenario(d) });
  recordResults("node.json", {
    "scenario.referenceDocumentBytes": summarize([bytes], "bytes"),
    "scenario.referenceDocumentCompactBytes": summarize([compact], "bytes"),
    "scenario.referenceParse": parse,
    "scenario.referenceLoad": load,
  });
  console.log(`reference scenario: ${(bytes / 1024).toFixed(0)} KiB pretty, ${(compact / 1024).toFixed(0)} KiB compact (raw layers 15625 KiB)`);
});

// F2 M1a (ADR-0024 "at scenario load"): wall time to prepare one UGV's planning view and HPA* graph on the 1 km²
// reference world before tick 0. Report only; it is load time, never tick time.
it("reference world: planning preparation at load (one HPA* profile)", () => {
  const grid = buildReferenceWorld();
  const doc = scenarioFromGrid({ id: "reference", name: "Reference 1 km² / 0.5 m", defaultSeed: 1 }, grid, [], [{ kind: "ugv", start: { xM: 1, yM: 1 } }]);
  const loaded = loadScenario(doc);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "reference", version: 1 }, planning: { default: { algorithm: "hpa" } } }, { loaded: loaded.value, version: 1 });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const r = resolved.value;
  const prepare = measure({
    iterations: 3,
    warmup: 1,
    // A fresh run each time: nothing is cached between iterations.
    setup: () => assembleRun(loaded.value, r, new TraceBuffer("run-000001", () => 0), { dtS: 0.1 }),
    run: (run) => {
      const p = preparePlanning(run, r);
      if (!p.ok || p.value.graphs !== 1) throw new Error("preparation did not build the HPA* graph");
    },
  });
  recordResults("node.json", { "load.planningPrepare": prepare });
});

// F2 acceptance (ROADMAP): 20 agents with 180-ray lidar at 10 Hz within the tick budget. The sensing phase alone,
// on the 1 km² reference world: 20 UGVs on a 5 × 4 grid of free cells, each with the built-in set (lidar 180 rays
// 30 m 10 Hz, proximity, camera); at 10 Hz ticks every lidar reads every tick.
it("sensing phase: 20 agents, 180-ray lidar at 10 Hz, on the reference world", () => {
  const grid = buildReferenceWorld();
  const starts: { kind: "ugv"; start: { xM: number; yM: number } }[] = [];
  for (let r = 0; r < 4 && starts.length < 20; r++) {
    for (let c = 0; c < 5 && starts.length < 20; c++) {
      // Nearest free cell to each grid point (deterministic scan).
      let x = 100 + c * 200;
      const y = 120 + r * 250;
      while (grid.isBlocked(grid.cellI(x), grid.cellJ(y))) x += 0.5;
      starts.push({ kind: "ugv", start: { xM: x, yM: y } });
    }
  }
  const doc = scenarioFromGrid({ id: "reference", name: "Reference 1 km² / 0.5 m", defaultSeed: 1 }, grid, [], starts);
  const loaded = loadScenario(doc);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "reference", version: 1 } }, { loaded: loaded.value, version: 1 });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const assembled = assembleRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0), { dtS: 0.1 });
  let tick = 0;
  const sensing = measure({ iterations: 100, warmup: 20, setup: () => ++tick, run: (t) => assembled.sensing.sense(t, t * 0.1) });
  // The F2 tick budget (plan, ROADMAP F2): a whole world tick for the same 20 agents, with no planning query in
  // flight (planning is bounded per agent separately: planning.slice20k), sensing included: ≤ 25 ms p95.
  const run = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1 });
  const tickNoPlanning = measure({ iterations: 100, warmup: 20, setup: () => undefined, run: () => run.scheduler.step() });
  recordResults("node.json", { "sim.sensing20x180": sensing, "sim.tick20AgentsSensing": tickNoPlanning });

  // ADR-0039 §4: per-tick topology maintenance for the same 20 agents (report first, then a gate). Each agent moves
  // 1 m per tick (10 m/s, faster than any built-in body) so every reading reveals new cells, as while exploring.
  const topo = assembleRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0), { dtS: 0.1 });
  let t2 = 0;
  topo.sensing.sense(++t2, 0.1);
  const firstMs = measure({ iterations: 1, warmup: 0, setup: () => undefined, run: () => topo.topology.update() });
  const update = measure({
    iterations: 100,
    warmup: 20,
    setup: () => {
      t2++;
      for (const a of topo.agents) {
        const nx = a.state.x + 1;
        if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
      }
      topo.sensing.sense(t2, t2 * 0.1);
    },
    run: () => topo.topology.update(),
  });
  recordResults("node.json", { "topology.update20Agents": update, "topology.firstUpdate20Agents": firstMs });
});

// ADR-0024 addition of 2026-10-10: per-tick maintenance of live planning views for 20 exploring agents (report only).
// Each agent's view is prepared at load as in the lab; agents move 1 m per tick so every reading reveals new cells;
// the after-sensing sync point is measured.
it("live planning views: per-tick sync for 20 exploring agents on the reference world", () => {
  const grid = buildReferenceWorld();
  const starts: { kind: "ugv"; start: { xM: number; yM: number } }[] = [];
  for (let r = 0; r < 4 && starts.length < 20; r++) {
    for (let c = 0; c < 5 && starts.length < 20; c++) {
      let x = 100 + c * 200;
      const y = 120 + r * 250;
      while (grid.isBlocked(grid.cellI(x), grid.cellJ(y))) x += 0.5;
      starts.push({ kind: "ugv", start: { xM: x, yM: y } });
    }
  }
  const loaded = loadScenario(scenarioFromGrid({ id: "reference", name: "Reference 1 km² / 0.5 m", defaultSeed: 1 }, grid, [], starts));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "reference", version: 1 } }, { loaded: loaded.value, version: 1 });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const run = assembleRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0), { dtS: 0.1 });
  const prepared = preparePlanning(run, resolved.value);
  if (!prepared.ok) throw new Error(prepared.error.message);
  let t = 0;
  run.sensing.sense(++t, 0.1);
  run.planner.syncViews();
  const sync = measure({
    iterations: 100,
    warmup: 20,
    setup: () => {
      t++;
      for (const a of run.agents) {
        const nx = a.state.x + 1;
        if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
      }
      run.sensing.sense(t, t * 0.1);
    },
    run: () => run.planner.syncViews(),
  });
  recordResults("node.json", { "planning.viewSync20Exploring": sync });

  // The F2 tick budget for exploring agents (2026-10-10): a whole world tick for 20 agents that reveal new
  // cells every tick (moved 1 m between ticks), with their planning views prepared as in the lab: sensing, the
  // sync point after it, topology, the runtime and the state hash. Planning slices are bounded separately
  // (planning.slice20k), so no query is in flight here.
  const world = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1 });
  const prep = preparePlanning(world, resolved.value);
  if (!prep.ok) throw new Error(prep.error.message);
  const tick = measure({
    iterations: 100,
    warmup: 20,
    setup: () => {
      for (const a of world.agents) {
        const nx = a.state.x + 1;
        if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
      }
    },
    run: () => world.scheduler.step(),
  });
  recordResults("node.json", { "sim.tick20AgentsExploring": tick });

  // beliefVsTruth (ADR-0005 addition of 2026-10-11, M2d4): observer-side, so it is not part of the tick gate. Report
  // only: the one-off construction (it labels the ground truth: load time, not tick time), and one look at all 20
  // agents' metrics after a tick of exploring (the incremental refresh), which the trace samples every 10 s of sim time.
  const t0 = performance.now();
  const observed = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1, beliefVsTruth: {} });
  const buildMs = performance.now() - t0;
  const op = preparePlanning(observed, resolved.value);
  if (!op.ok) throw new Error(op.error.message);
  const obsv = observed.observer;
  if (!obsv) throw new Error("no observer");
  // The same exploring tick as the gate, with the observer sampling (staggered: about one agent per tick, every 10 s each).
  const observedTick = measure({
    iterations: 300,
    warmup: 20,
    setup: () => {
      for (const a of observed.agents) {
        const nx = a.state.x + 1;
        if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
      }
    },
    run: () => observed.scheduler.step(),
  });
  // The observer's own work per tick, timed directly (sampling plus recount; zero on ticks when no agent is due): the gate
  // is on this, never on the difference of two tick timings.
  const own: number[] = [];
  let spent = 0;
  const sampleFn = obsv.sample.bind(obsv);
  obsv.sample = (tick, simTimeS) => {
    const t0 = performance.now();
    sampleFn(tick, simTimeS);
    spent += performance.now() - t0;
  };
  for (let k = 0; k < 400; k++) {
    for (const a of observed.agents) {
      const nx = a.state.x + 1;
      if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
    }
    spent = 0;
    observed.scheduler.step();
    if (k >= 20) own.push(spent);
  }
  recordResults("node.json", { "observer.beliefVsTruth20Exploring": summarize(own, "ms") });

  // The same 320 ticks without the observer: the difference is its cost.
  const plain = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1 });
  const pp = preparePlanning(plain, resolved.value);
  if (!pp.ok) throw new Error(pp.error.message);
  const plainTick = measure({
    iterations: 300,
    warmup: 20,
    setup: () => {
      for (const a of plain.agents) {
        const nx = a.state.x + 1;
        if (!grid.isBlocked(grid.cellI(nx), grid.cellJ(a.state.y))) a.state.x = nx;
      }
    },
    run: () => plain.scheduler.step(),
  });
  recordResults("node.json", {
    "sim.tick20AgentsExploringObserved": observedTick,
    "sim.tick20AgentsExploringPlain320": plainTick,
    "observer.beliefVsTruthBuild20Agents": summarize([buildMs], "ms"),
  });
});

// ADR-0005 addition of 2026-10-11 (M2d): what the request records cost in a trace. 20 UGVs exploring the 1 km²
// reference world with `unknown` beliefs; a mind explores again whenever an action ends and otherwise stays idle.
// Reported per agent per hour of sim time: the records as written (space summaries deduplicated by hash, allowed
// actions as names plus the manifest hash), and what the same requests would take with every space summary and every
// parameter schema inlined. Report only.
it("trace: request records, bytes per agent per hour (20 exploring agents, deduplicated vs inlined)", async () => {
  const grid = buildReferenceWorld();
  const starts: { kind: "ugv"; key: string; start: { xM: number; yM: number } }[] = [];
  for (let r = 0; r < 4 && starts.length < 20; r++) {
    for (let c = 0; c < 5 && starts.length < 20; c++) {
      let x = 100 + c * 200;
      const y = 120 + r * 250;
      while (grid.isBlocked(grid.cellI(x), grid.cellJ(y))) x += 0.5;
      starts.push({ kind: "ugv", key: `a${starts.length}`, start: { xM: x, yM: y } });
    }
  }
  const loaded = loadScenario(scenarioFromGrid({ id: "reference", name: "Reference 1 km² / 0.5 m", defaultSeed: 1 }, grid, [], starts));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "reference", version: 1 }, beliefs: { default: { init: "unknown" } } }, { loaded: loaded.value, version: 1 });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const mind = (id: string) => ({
    id,
    tier: "baseline" as const,
    decide: (req: { events: readonly { kind: string }[] }) =>
      Promise.resolve({ decision: req.events.some((e) => ["start", "actionCompleted", "actionFailed", "actionRejected"].includes(e.kind)) ? { kind: "action" as const, name: "explore", params: {} } : { kind: "idle" as const } }),
  });
  const brains = Object.fromEntries(starts.map((s) => [s.key, mind(`mind-${s.key}`)]));
  const trace = new TraceBuffer("run-000001", () => 0, 4_000_000);
  const run = createRun(loaded.value, resolved.value, trace, { dtS: 0.1, brains });
  const ticks = 1200;
  await runLockstep(run.world, run.scheduler, ticks);
  let written = 0;
  let inlined = 0;
  let requests = 0;
  const spaces = new Map<string, string>();
  const manifestBytes = JSON.stringify(run.runtime.actionMenu(run.agents[0] as never).allowed).length;
  for (const r of trace.all()) {
    if (r.kind !== "thought") continue;
    const p = r.payload as { op: string; hash?: string; summary?: unknown; space?: string; allowed?: { names: string[] } };
    if (p.op === "space") {
      const s = JSON.stringify(p.summary);
      spaces.set(p.hash ?? "", s);
      written += JSON.stringify(p).length;
    } else if (p.op === "request") {
      requests++;
      const body = JSON.stringify(p).length;
      written += body;
      // Inlined: the summary itself instead of its 16-digit reference, and every allowed schema instead of the manifest hash.
      inlined += body + (spaces.get(p.space ?? "")?.length ?? 0) - 18 + manifestBytes;
    }
  }
  const simHours = (ticks * 0.1) / 3600;
  const perAgentHour = (bytes: number) => bytes / starts.length / simHours;
  // The cost of building one request's view and menu, on these explored maps (what a request adds to its tick).
  const build = measure({
    iterations: 100,
    warmup: 10,
    setup: () => undefined,
    run: () => {
      for (const a of run.agents) {
        run.mindView.view(a.id, 120);
        run.runtime.actionMenu(a);
      }
    },
  });
  recordResults("node.json", {
    "sim.requestBuild20Agents": build,
    "trace.requestBytesPerAgentHour": summarize([perAgentHour(written)], "bytes"),
    "trace.requestBytesPerAgentHour.inlined": summarize([perAgentHour(inlined)], "bytes"),
    "trace.requestsPerAgentHour": summarize([requests / starts.length / simHours], "count"),
  });
});
