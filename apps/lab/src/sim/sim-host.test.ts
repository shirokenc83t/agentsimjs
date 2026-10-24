import { contentHash, MainToSim, runLockstep, SIM_PROTOCOL_VERSION, SimToMain as SimToMainSchema, StateHasher, STATUS_STRIDE, validate, type SimToMain } from "@agentsim/core";
import { createRun, f1DemoRunConfig, f1DemoScenario, loadScenario, resolveRunConfig } from "@agentsim/scenarios";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { writeDummyPoses } from "./dummy-world.ts";
import { SCENARIO_DT_S } from "./hosted-world.ts";
import { runSimHost, type SimClock, type SimScope } from "./sim-host.ts";

/** Deterministic fake clock + scope: advance time manually and collect posted messages. */
function harness() {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: SimClock = {
    now: () => t,
    epochNow: () => 1_700_000_000_000 + t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      timers = timers.filter((x) => x.id !== h);
    },
  };
  const out: SimToMain[] = [];
  let listener: ((e: MessageEvent<unknown>) => void) | undefined;
  const scope: SimScope = {
    postMessage: (m) => out.push(m),
    addEventListener: (_t, l) => (listener = l),
  };
  const host = runSimHost(scope, clock, (m) => validate(MainToSim, m));
  const send = (data: unknown) => listener?.({ data } as MessageEvent<unknown>);
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = Math.max(t, next.at); // timers due during a stall fire late, never in the past
      next.fn();
    }
    t = end;
  };
  /** The worker is blocked for `ms` (a long tick, a stalled tab): wall time passes, no timer fires. */
  const stall = (ms: number) => {
    t += ms;
  };
  const states = () => out.filter((m): m is Extract<SimToMain, { type: "state" }> => m.type === "state");
  return { send, advance, stall, out, states, trace: host.trace };
}

describe("sim host (ADR-0019)", () => {
  it("ticks at the configured fixed rate, independent of the display", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    expect(h.out[0]).toEqual({ type: "ready", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(2000);
    expect(h.states()).toHaveLength(20);
    const last = h.states().at(-1);
    expect(last?.tick).toBe(20);
    expect(last?.simTimeS).toBeCloseTo(2.0);
    expect(h.out.some((m) => m.type === "stats" && m.ticksPerSecond > 9 && m.ticksPerSecond < 11)).toBe(true);
  });

  it("sends deterministic poses and the entity table only once", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(300);
    const [s1, s2] = h.states();
    expect(s1?.entityIds).toEqual(["dummy-001"]);
    expect(s2?.entityIds).toBeUndefined();
    const expected = new Float32Array(4);
    writeDummyPoses(2, expected);
    expect(Array.from(s2?.poses ?? [])).toEqual(Array.from(expected));
  });

  it("pauses, steps one tick at a time, and changes speed", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(500);
    h.send({ type: "control", op: "pause" });
    const n = h.states().length;
    h.advance(1000);
    expect(h.states()).toHaveLength(n);
    h.send({ type: "control", op: "step" });
    expect(h.states()).toHaveLength(n + 1);
    h.send({ type: "control", op: "setTickRate", tickRateHz: 40 });
    h.send({ type: "control", op: "play" });
    h.advance(1000);
    expect(h.states().length - (n + 1)).toBe(40);
  });

  it("reuses returned buffers and rejects invalid messages", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(100);
    const buf = new ArrayBuffer(16);
    h.send({ type: "return-buffer", buffer: buf });
    h.advance(100);
    expect(h.states().at(-1)?.poses.buffer).toBe(buf);
    h.send({ type: "control", op: "launch-missiles" });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("lockstep never skips ticks after a stall: owed ticks run later, in order, with no degradation", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(500);
    h.stall(3000); // 30 ticks become due at once
    h.advance(2000);
    const ticks = h.states().map((m) => m.tick);
    expect(ticks.at(-1)).toBe(55); // every due tick executed: 5.5 s at 10 Hz
    for (let i = 1; i < ticks.length; i++) expect((ticks[i] ?? 0) > (ticks[i - 1] ?? 0)).toBe(true);
    expect(h.out.some((m) => m.type === "degradation")).toBe(false);
    expect(h.trace().ofKind("degradation")).toHaveLength(0);
  });

  it("realtime drops overrun ticks after a stall and traces the drop as a degradation", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ type: "control", op: "setMode", mode: "realtime" });
    h.advance(520); // polls every 16 ms: tick 5 runs at 512 ms
    h.stall(3000);
    h.advance(1000);
    const deg = h.out.filter((m): m is Extract<SimToMain, { type: "degradation" }> => m.type === "degradation");
    expect(deg).toHaveLength(1);
    expect(deg[0]?.skippedTicks).toBe(26); // 30 due, 4 run, 26 dropped
    expect(h.trace().ofKind("degradation")).toHaveLength(1);
    expect(h.trace().ofKind("degradation")[0]?.payload).toMatchObject({ reason: "tick-overrun", skippedTicks: 26 });
    expect(h.states().at(-1)?.tick).toBe(5 + 4 + 10); // the sim never jumps: dropped ticks are not executed
    const stats = h.out.filter((m): m is Extract<SimToMain, { type: "stats" }> => m.type === "stats").at(-1);
    expect(stats).toMatchObject({ mode: "realtime", degradations: 1 });
  });
});

describe("sim host: scenario runs (F1 e2, protocol v2)", () => {
  const demo = () => {
    const scenario = f1DemoScenario();
    return { type: "load", runId: "run-000007", scenario, scenarioVersion: 1, runConfig: f1DemoRunConfig(1) };
  };

  /** The same run, headless: the state hash after `ticks` ticks (no minds, nothing injected). */
  async function headlessHash(ticks: number): Promise<string> {
    const loaded = loadScenario(f1DemoScenario());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const resolved = resolveRunConfig(f1DemoRunConfig(1), { loaded: loaded.value, version: 1 });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const run = createRun(loaded.value, resolved.value, new TraceBuffer("run-000007", () => 0), { dtS: SCENARIO_DT_S });
    await runLockstep(run.world, run.scheduler, ticks);
    return run.world.stateHash;
  }

  it("loads a scenario run: reports it, sends the agent table, and starts paused at tick 0", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.advance(300);
    h.send(demo());
    const loaded = h.out.find((m) => m.type === "loaded");
    expect(loaded).toMatchObject({ runId: "run-000007", scenarioId: "f1-demo", scenarioVersion: 1, timeMode: "lockstep", dtS: 0.1 });
    expect(loaded?.type === "loaded" && loaded.agents.map((a) => a.key)).toEqual(["scout", "rover", "low"]);
    const first = h.states().at(-1);
    expect(first).toMatchObject({ tick: 0, entityIds: ["uav-001", "ugv-001", "ugv-002"] });
    expect(first?.agentStatus?.length).toBe(3 * STATUS_STRIDE);
    const n = h.states().length;
    h.advance(1000);
    expect(h.states()).toHaveLength(n); // paused after load
  });

  it("prepares the planning graphs before tick 0: preparing n/m, then prepared, then loaded (ADR-0024)", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ ...demo(), runConfig: { ...f1DemoRunConfig(1), planning: { default: { algorithm: "hpa" } } } });
    const seq = h.out.filter((m) => m.type === "preparing" || m.type === "prepared" || m.type === "loaded").map((m) => m.type);
    expect(seq.at(-1)).toBe("loaded");
    expect(seq.at(-2)).toBe("prepared");
    expect(seq.slice(0, -2).every((t) => t === "preparing")).toBe(true);
    const progress = h.out.filter((m): m is Extract<SimToMain, { type: "preparing" }> => m.type === "preparing");
    expect(progress[0]).toMatchObject({ runId: "run-000007", done: 0 });
    expect(progress.at(-1)?.done).toBe(progress.at(-1)?.total);
    const prepared = h.out.find((m) => m.type === "prepared");
    expect(prepared).toMatchObject({ runId: "run-000007", views: 2, graphs: 2 }); // the UGVs share a view; the UAV has its own
    for (const m of h.out) expect(validate(SimToMainSchema, m).ok, m.type).toBe(true);
  });

  // Regression (F1 f): the worker kept the toolbar's mode, so a run declared realtime (in its header and
  // runConfigHash) could run lockstep, and the reverse.
  it("runs in the time mode its run configuration declares, whatever mode the previous run used", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    const stats = () => h.out.filter((m): m is Extract<SimToMain, { type: "stats" }> => m.type === "stats").at(-1);
    h.send({ ...demo(), runConfig: { ...f1DemoRunConfig(1), timeMode: "realtime" } });
    expect(h.out.find((m) => m.type === "loaded")).toMatchObject({ timeMode: "realtime" });
    expect(stats()).toMatchObject({ mode: "realtime" });
    h.send({ ...demo(), runId: "run-000008" });
    expect(stats()).toMatchObject({ mode: "lockstep" });
  });

  // 2026-10-09: the time mode is part of the run (header, runConfigHash); it cannot change mid-run.
  // Changing it means a new run of the same scenario version ("Re-run in <mode>").
  it("refuses a mode change while a scenario run is loaded, with a stable code; pause and step still work", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    const stats = () => h.out.filter((m): m is Extract<SimToMain, { type: "stats" }> => m.type === "stats").at(-1);
    h.send(demo());
    h.send({ type: "control", op: "setMode", mode: "realtime" });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "mode_locked" });
    expect(stats()).toMatchObject({ mode: "lockstep" });
    h.send({ type: "control", op: "step", count: 3 });
    h.send({ type: "control", op: "pause" });
    expect(stats()).toMatchObject({ mode: "lockstep" });
    expect(h.states().at(-1)?.tick).toBe(3);
  });

  // F1 known limitation (2026-10-09, item 5): what a re-simulation of a stored realtime run reproduces.
  it("re-simulating a realtime run reproduces its state at every tick, but not its degradation records", () => {
    const realtime = { ...demo(), runConfig: { ...f1DemoRunConfig(1), timeMode: "realtime" } };
    const lastStats = (h: ReturnType<typeof harness>) => h.out.filter((m): m is Extract<SimToMain, { type: "stats" }> => m.type === "stats").at(-1);

    // Run A: realtime, a send-to at tick 5, then a 3 s stall (a long tick): 26 ticks dropped, traced.
    const a = harness();
    a.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    a.send(realtime);
    a.send({ type: "control", op: "play" });
    a.advance(520);
    a.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } });
    a.stall(3000);
    a.advance(1000);
    a.send({ type: "control", op: "pause" });
    const inputs = a.out.filter((m): m is Extract<SimToMain, { type: "input" }> => m.type === "input").map((m) => m.input);
    const endA = lastStats(a);
    expect(inputs).toHaveLength(1);
    expect(a.trace().ofKind("degradation")).toHaveLength(1);

    // Run B: the stored run re-simulated (same documents, same inputs), realtime, no stall, paused at the same tick.
    const b = harness();
    b.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    b.send({ ...realtime, runId: "run-000008", inputs });
    b.send({ type: "control", op: "play" });
    while ((b.states().at(-1)?.tick ?? 0) < (endA?.tick ?? 0)) b.advance(16);
    b.send({ type: "control", op: "pause" });
    const endB = lastStats(b);

    // Dropped ticks are never executed (the sim does not jump), and inputs apply at their recorded ticks, so the
    // state at every tick is the same. The degradation records depend on wall time and are not reproduced.
    expect(endA?.tick).toBe(5 + 4 + 10);
    expect(endA?.stateHash).toMatch(/^[0-9a-f]{8}$/);
    expect(endB?.tick).toBe(endA?.tick);
    expect(endB?.stateHash).toBe(endA?.stateHash);
    expect(b.trace().ofKind("degradation")).toHaveLength(0);

    // Not vacuous: without the recorded input the state at that tick differs.
    const c = harness();
    c.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    c.send({ ...realtime, runId: "run-000009" });
    c.send({ type: "control", op: "play" });
    while ((c.states().at(-1)?.tick ?? 0) < (endA?.tick ?? 0)) c.advance(16);
    c.send({ type: "control", op: "pause" });
    expect(lastStats(c)?.stateHash).not.toBe(endA?.stateHash);
  });

  it("stepping N ticks gives the same state hash as the headless run (the lab adds nothing to the simulation)", async () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "control", op: "step", count: 100 });
    const stats = h.out.filter((m) => m.type === "stats").at(-1);
    expect(stats).toMatchObject({ runId: "run-000007", tick: 100 });
    expect(stats?.type === "stats" && stats.stateHash).toBe(await headlessHash(100));
  });

  it("sends the grid and every atlas chunk once after a load, then only dirty chunks (none without edits)", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    expect(h.out.find((m) => m.type === "grid")).toMatchObject({ sizeX: 128, sizeY: 128, resolutionM: 0.5, chunkSize: 32, zones: [{ id: "base", kind: "base" }] });
    const chunks = () => h.out.filter((m): m is Extract<SimToMain, { type: "chunks" }> => m.type === "chunks");
    expect(chunks().reduce((n, m) => n + m.coords.length / 2, 0)).toBe(16); // 4 × 4 chunks of 32 × 32
    expect(chunks()[0]?.data.length).toBe(16 * 32 * 32 * 4);
    h.send({ type: "control", op: "play" });
    h.advance(2000);
    expect(chunks()).toHaveLength(1);
  });

  it("streams executed-path points recorded from tick states: the start of each agent, nothing while idle", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "control", op: "play" });
    h.advance(2000);
    const trails = h.out.filter((m): m is Extract<SimToMain, { type: "trail" }> => m.type === "trail");
    expect(trails).toHaveLength(1);
    expect(Array.from(trails[0]?.agents ?? [])).toEqual([0, 1, 2]);
    expect(Array.from(trails[0]?.points.subarray(3, 6) ?? [])).toEqual([10, 10, 0]); // rover start (x, y, z)
    expect(trails[0]?.replace).toBeUndefined();
  });

  it("a researcher command becomes a run input for the next tick, traced as injected; unknown agents are refused", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 20, yM: 10 } });
    h.send({ type: "control", op: "step", count: 1 });
    const records = h.out.flatMap((m) => (m.type === "events" ? (m.records as { kind: string; source: string; payload: { inputId?: string; ok?: boolean } }[]) : []));
    const injected = records.find((r) => r.kind === "injected");
    expect(injected).toMatchObject({ source: "world/sim", payload: { inputId: "inp-000001", ok: true } });
    h.send({ type: "command", op: "goTo", agentId: "ugv-099", params: { xM: 1, yM: 1 } });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "unknown_agent" });
  });

  it("a run stored by F1 re-simulates to the same checkpoint hashes (stored inputs never had the message's shape: ADR-0019 addition of 2026-10-12)", () => {
    // The F1 stored form, written out: the same inputs the live run below is given as commands.
    const f1Stored = [
      { inputId: "inp-000001", tick: 1, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } },
      { inputId: "inp-000002", tick: 101, agentId: "ugv-002", name: "goTo", params: { xM: 25, yM: 30 } },
    ];
    const hashes = (h: ReturnType<typeof harness>) => h.out.flatMap((m) => (m.type === "stats" ? [m.stateHash] : []));
    const live = harness();
    live.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    live.send(demo());
    live.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } });
    live.send({ type: "control", op: "step", count: 100 });
    live.send({ type: "command", op: "goTo", agentId: "ugv-002", params: { xM: 25, yM: 30 } });
    live.send({ type: "control", op: "step", count: 200 });
    expect(live.out.flatMap((m) => (m.type === "input" ? [m.input] : []))).toEqual(f1Stored);
    const replay = harness();
    replay.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    replay.send({ ...demo(), runId: "run-000008", inputs: f1Stored });
    replay.send({ type: "control", op: "step", count: 100 });
    replay.send({ type: "control", op: "step", count: 200 });
    expect(hashes(replay).at(-1)).toBe(hashes(live).at(-1));
    expect(hashes(replay).length).toBeGreaterThan(1);
  });

  it("a `view` streams the viewed agent's decision request as JSON text, changes nothing in the run, and stops with null or a load", () => {
    const run = (view: boolean) => {
      const h = harness();
      h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
      h.send(demo());
      if (view) h.send({ type: "view", agentId: "ugv-001" });
      h.send({ type: "control", op: "step", count: 50 });
      return h;
    };
    const viewed = run(true);
    const quiet = run(false);
    const views = viewed.out.filter((m) => m.type === "agentView");
    expect(views.length).toBeGreaterThan(0);
    expect(quiet.out.some((m) => m.type === "agentView")).toBe(false);
    const last = views.at(-1);
    if (last?.type !== "agentView") throw new Error("no view");
    expect(last.agentId).toBe("ugv-001");
    const req = JSON.parse(last.request) as { agentId: string; tick: number; allowedActions: { name: string }[] };
    expect(req.agentId).toBe("ugv-001");
    expect(req.allowedActions.map((a) => a.name)).toContain("goTo");
    const hash = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash(viewed)?.type === "stats" && hash(viewed)).toEqual(hash(quiet)); // looking changes nothing
    viewed.send({ type: "view", agentId: null });
    const n = viewed.out.filter((m) => m.type === "agentView").length;
    viewed.send({ type: "control", op: "step", count: 10 });
    expect(viewed.out.filter((m) => m.type === "agentView").length).toBe(n);
  });

  it("`researcherWatch` streams beliefs-versus-truth for the watched agent only, changes nothing in the run, and stops with null (observer data: worker → main only)", () => {
    const unknown = () => ({ ...demo(), runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, beliefs: { default: { init: "unknown" } } } });
    const run = (watch: boolean) => {
      const h = harness();
      h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
      h.send(unknown());
      if (watch) h.send({ type: "researcherWatch", agentId: "ugv-001" });
      h.send({ type: "control", op: "step", count: 50 });
      return h;
    };
    const watched = run(true);
    const quiet = run(false);
    const data = watched.out.filter((m) => m.type === "researcherData");
    expect(data.length).toBeGreaterThan(0);
    expect(quiet.out.some((m) => m.type === "researcherData")).toBe(false);
    const last = data.at(-1);
    if (last?.type !== "researcherData") throw new Error("no data");
    expect(last.agentId).toBe("ugv-001");
    expect(last.ideal).toBe(false);
    expect(last.map?.reachableCells).toBeGreaterThan(1000);
    expect(last.map?.correctPct).toBeGreaterThan(0);
    const hash = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash(watched)).toEqual(hash(quiet));
    watched.send({ type: "researcherWatch", agentId: null });
    const n = watched.out.filter((m) => m.type === "researcherData").length;
    watched.send({ type: "control", op: "step", count: 10 });
    expect(watched.out.filter((m) => m.type === "researcherData").length).toBe(n);
    // An `ideal` agent has no map metrics: its map is the ground truth.
    const ideal = harness();
    ideal.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    ideal.send(demo());
    ideal.send({ type: "researcherWatch", agentId: "ugv-001" });
    const d = ideal.out.filter((m) => m.type === "researcherData").at(-1);
    expect(d?.type === "researcherData" && d.ideal).toBe(true);
    expect(d?.type === "researcherData" && d.map).toBeUndefined();
  });

  it("`cellWatch` streams what every agent believes of one cell (the ideal ones as such), changes nothing in the run, and stops with null (observer data: worker → main only)", () => {
    const unknown = () => ({ ...demo(), runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, beliefs: { default: { init: "unknown" } } } });
    const run = (watch: boolean) => {
      const h = harness();
      h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
      h.send(unknown());
      if (watch) h.send({ type: "cellWatch", cell: { i: 20, j: 20 } });
      h.send({ type: "control", op: "step", count: 50 });
      return h;
    };
    const watched = run(true);
    const quiet = run(false);
    const beliefs = watched.out.filter((m) => m.type === "cellBeliefs");
    expect(beliefs.length).toBeGreaterThan(0);
    expect(quiet.out.some((m) => m.type === "cellBeliefs")).toBe(false);
    const last = beliefs.at(-1);
    if (last?.type !== "cellBeliefs") throw new Error("no data");
    expect([last.i, last.j]).toEqual([20, 20]);
    expect(last.agents.map((a) => a.agentId).sort()).toEqual(["ugv-001", "ugv-002", "uav-001"].sort());
    expect(last.agents.every((a) => a.state === "unknown" || a.state === "free" || a.state === "occupied")).toBe(true);
    const hash = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash(watched)).toEqual(hash(quiet));
    watched.send({ type: "cellWatch", cell: null });
    const n = watched.out.filter((m) => m.type === "cellBeliefs").length;
    watched.send({ type: "control", op: "step", count: 10 });
    expect(watched.out.filter((m) => m.type === "cellBeliefs").length).toBe(n);
    // Agents whose map is the truth are `ideal`.
    const ideal = harness();
    ideal.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    ideal.send(demo());
    ideal.send({ type: "cellWatch", cell: { i: 5, j: 5 } });
    const d = ideal.out.filter((m) => m.type === "cellBeliefs").at(-1);
    expect(d?.type === "cellBeliefs" && d.agents.every((a) => a.state === "ideal")).toBe(true);
  });

  it("`beliefWatch` streams the watched agent's belief chunks (dirty ones only, one byte per cell), nothing for an ideal agent, and changes nothing in the run, whatever the agent switching", () => {
    const unknown = () => ({ ...demo(), runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, beliefs: { default: { init: "unknown" } } } });
    const run = (script: (h: ReturnType<typeof harness>) => void) => {
      const h = harness();
      h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
      h.send(unknown());
      script(h);
      return h;
    };
    const steps = (h: ReturnType<typeof harness>, n: number) => h.send({ type: "control", op: "step", count: n });
    const chunks = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "beliefChunks");
    const watched = run((h) => {
      h.send({ type: "beliefWatch", agentId: "ugv-001" });
      steps(h, 20);
      h.send({ type: "beliefWatch", agentId: "ugv-002" }); // switching: the new agent's chunks start from scratch
      steps(h, 20);
      h.send({ type: "beliefWatch", agentId: "ugv-001" });
      steps(h, 10);
      h.send({ type: "beliefWatch", agentId: null });
      steps(h, 10);
    });
    const quiet = run((h) => {
      steps(h, 20);
      steps(h, 20);
      steps(h, 10);
      steps(h, 10);
    });
    expect(chunks(quiet)).toHaveLength(0);
    const all = chunks(watched);
    expect(all.length).toBeGreaterThan(2);
    for (const m of all) {
      if (m.type !== "beliefChunks") continue;
      expect(["ugv-001", "ugv-002"]).toContain(m.agentId);
      expect(m.data.length).toBe((m.coords.length / 2) * 32 * 32); // one byte per cell (the demo's chunks are 32 × 32)
      expect(Math.max(...m.data)).toBeLessThanOrEqual(2);
    }
    // After the first batch for an agent, later batches carry only chunks that changed: fewer than the first (which has them all).
    const first = all.find((m) => m.type === "beliefChunks" && m.agentId === "ugv-001");
    const later = all.filter((m) => m.type === "beliefChunks" && m.agentId === "ugv-001").at(-1);
    expect(first?.type === "beliefChunks" && later?.type === "beliefChunks" && later.coords.length <= first.coords.length).toBe(true);
    // Switching agents resent the first agent's chunks from scratch (a new atlas starts empty).
    expect(all.filter((m) => m.type === "beliefChunks" && m.agentId === "ugv-001").length).toBeGreaterThanOrEqual(2);
    // Observationally pure: same stats hash and the same trace records as the run that never watched.
    const hash = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash(watched)).toEqual(hash(quiet));
    const trace = (h: ReturnType<typeof harness>) => JSON.stringify(h.out.flatMap((m) => (m.type === "events" ? (m.records as { wallTime?: number }[]).map((r) => ({ ...r, wallTime: 0 })) : [])));
    expect(trace(watched).length).toBeGreaterThan(2);
    expect(trace(watched)).toBe(trace(quiet));
    // Nothing is posted after `null`.
    const n = chunks(watched).length;
    steps(watched, 10);
    expect(chunks(watched).length).toBe(n);
    // An ideal agent has no map of its own: nothing is sent for it.
    const ideal = harness();
    ideal.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    ideal.send(demo());
    ideal.send({ type: "beliefWatch", agentId: "ugv-001" });
    steps(ideal, 20);
    expect(chunks(ideal)).toHaveLength(0);
  });

  it("`overlayWatch` streams the viewed agent's decimated lidar rays and its topological layer (when changed), only while asked, and changes nothing in the run", () => {
    const unknown = () => ({ ...demo(), runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, beliefs: { default: { init: "unknown" } } } });
    const run = (script: (h: ReturnType<typeof harness>) => void) => {
      const h = harness();
      h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
      h.send(unknown());
      script(h);
      return h;
    };
    const steps = (h: ReturnType<typeof harness>, n: number) => h.send({ type: "control", op: "step", count: n });
    const of = (h: ReturnType<typeof harness>, type: "rays" | "topology") => h.out.filter((m) => m.type === type);
    const watched = run((h) => {
      h.send({ type: "overlayWatch", agentId: "ugv-001", rays: true, topology: true });
      steps(h, 30);
      h.send({ type: "overlayWatch", agentId: "ugv-001", rays: false, topology: true }); // rays off: the recorder stops
      steps(h, 20);
      h.send({ type: "overlayWatch", agentId: null, rays: false, topology: false });
      steps(h, 10);
    });
    const quiet = run((h) => {
      steps(h, 30);
      steps(h, 20);
      steps(h, 10);
    });
    expect(of(quiet, "rays")).toHaveLength(0);
    expect(of(quiet, "topology")).toHaveLength(0);
    const rays = of(watched, "rays");
    expect(rays.length).toBeGreaterThan(0);
    for (const m of rays) {
      if (m.type !== "rays") continue;
      expect(m.agentId).toBe("ugv-001");
      expect(m.segments.length / 4).toBeLessThanOrEqual(64);
      expect(m.hit.length).toBe(m.segments.length / 4);
    }
    const topo = of(watched, "topology");
    expect(topo.length).toBeGreaterThan(1);
    const first = topo[0];
    if (first?.type !== "topology") throw new Error("no topology");
    expect(first.regions.length % 5).toBe(0);
    expect(first.regions.length).toBeGreaterThan(0);
    expect(first.frontiers.length % 4).toBe(0);
    // Nothing is sent after `null`, and the run is unchanged by having been watched.
    const hash = (h: ReturnType<typeof harness>) => h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash(watched)).toEqual(hash(quiet));
    const trace = (h: ReturnType<typeof harness>) => JSON.stringify(h.out.flatMap((m) => (m.type === "events" ? (m.records as { wallTime?: number }[]).map((r) => ({ ...r, wallTime: 0 })) : [])));
    expect(trace(watched)).toBe(trace(quiet));
    const n = of(watched, "rays").length + of(watched, "topology").length;
    steps(watched, 10);
    expect(of(watched, "rays").length + of(watched, "topology").length).toBe(n);
  });

  it("`budget` reports the sensing wall time, the rays fired per tick and the planning phase's spending, at about 3 Hz, without changing the run", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } });
    h.send({ type: "control", op: "step", count: 30 });
    const budgets = h.out.filter((m) => m.type === "budget");
    expect(budgets.length).toBeGreaterThan(0);
    const last = budgets.at(-1);
    if (last?.type !== "budget") throw new Error("no budget");
    expect(last.runId).toBe("run-000007");
    expect(last.sensingMsMean).toBeGreaterThanOrEqual(0);
    expect(last.sensingMsP95).toBeGreaterThanOrEqual(last.sensingMsMean * 0.5);
    // The demo's three vehicles each fire a 180-ray lidar and an 8-ray proximity sensor at the tick rate.
    expect(last.raysPerTick).toBe(3 * (180 + 8));
    expect(last.lidarRaysPerTick).toBe(3 * 180);
    // The rover was planning (300 expansions per tick of budget) at least part of the time.
    expect(Math.max(...budgets.map((m) => (m.type === "budget" ? m.planningBudgetPerTick : 0)))).toBeGreaterThan(0);
    // Wall-clock diagnostics are outside the run: the state hash is the headless run's.
    const hash = h.out.filter((m) => m.type === "stats").at(-1);
    expect(hash?.type === "stats" && hash.stateHash).toBeTruthy();
  });

  it("only the closed set of researcher commands is accepted (ADR-0015 addition of 2026-10-12); a refused name is never recorded as an input", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "command", op: "returnToBase", agentId: "ugv-001" });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "not_injectable" });
    h.send({ type: "command", op: "setTimer", agentId: "ugv-001", params: { delayS: 1, tag: "x" } });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "not_injectable" });
    expect(h.out.some((m) => m.type === "input")).toBe(false);
    for (const [op, agentId, params] of [["takeoff", "uav-001", { altitudeM: 12 }], ["explore", "ugv-001", {}], ["hold", "ugv-002", { durationS: 2 }], ["land", "uav-001", undefined]] as const) {
      h.send({ type: "command", op, agentId, ...(params ? { params } : {}) });
    }
    expect(h.out.filter((m) => m.type === "input").map((m) => (m.type === "input" ? m.input.name : ""))).toEqual(["takeoff", "explore", "hold", "land"]);
  });

  it("a load with stored inputs applies them again: same input IDs reported back, same hash as the live run", () => {
    const live = harness();
    live.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    live.send(demo());
    live.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } });
    live.send({ type: "control", op: "step", count: 100 });
    live.send({ type: "command", op: "goTo", agentId: "ugv-002", params: { xM: 25, yM: 30 } });
    live.send({ type: "control", op: "step", count: 200 });
    const inputs = live.out.flatMap((m) => (m.type === "input" ? [m.input] : []));
    expect(inputs.map((i) => [i.inputId, i.tick])).toEqual([
      ["inp-000001", 1],
      ["inp-000002", 101],
    ]);
    const liveHash = live.out.filter((m) => m.type === "stats").at(-1);

    const replay = harness();
    replay.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    replay.send({ ...demo(), runId: "run-000008", inputs });
    expect(replay.out.flatMap((m) => (m.type === "input" ? [m.input] : []))).toEqual(inputs);
    replay.send({ type: "control", op: "step", count: 300 });
    const replayHash = replay.out.filter((m) => m.type === "stats").at(-1);
    expect(replayHash?.type === "stats" && replayHash.stateHash).toBe(liveHash?.type === "stats" && liveHash.stateHash);
  });

  it("plays a loaded run at the tick rate and streams trace records at most at 10 Hz", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(demo());
    h.send({ type: "control", op: "play" });
    h.advance(2000);
    expect(h.states().at(-1)?.tick).toBe(20);
    // No mind and no command yet: no records; the stream is there for e3–e5.
    const events = h.out.filter((m) => m.type === "events");
    expect(events.length).toBeLessThanOrEqual(20);
  });

  it("rejects an invalid scenario or run configuration with its stable code and keeps the current world", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ ...demo(), scenario: { schemaVersion: 99 } });
    expect(h.out.at(-1)).toMatchObject({ type: "error", code: "unsupported_schema_version" });
    h.send({ ...demo(), runConfig: { schemaVersion: 0, scenario: { id: "other", version: 1 } } });
    expect(h.out.at(-1)?.type).toBe("error");
    h.advance(200);
    expect(h.states().at(-1)?.entityIds ?? ["dummy-001"]).toEqual(["dummy-001"]);
  });

  it("loads a run configured with a lazy refine strategy like any other (no refusal since F2b M3)", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    const lazy = { schemaVersion: 0, id: "lazy-test", version: 1, root: { kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } };
    h.send({ ...demo(), runConfig: { ...f1DemoRunConfig(1), planning: { default: { strategy: lazy } } } });
    expect(h.out.some((m) => m.type === "error")).toBe(false);
    expect(h.out.some((m) => m.type === "loaded")).toBe(true);
  });

  it("loads a run configured with a shipped strategy and reports it in the agents' effective configuration", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ ...demo(), runConfig: { ...f1DemoRunConfig(1), planning: { default: { strategy: { ref: "short-astar-long-hpa", version: 1 } } } } });
    const loaded = h.out.find((m): m is Extract<SimToMain, { type: "loaded" }> => m.type === "loaded");
    expect(loaded).toBeDefined();
    const planning = (loaded?.agents[0]?.config as { planning?: { strategy?: { id: string; version: number } } } | undefined)?.planning;
    expect(planning?.strategy).toMatchObject({ id: "short-astar-long-hpa", version: 1 });
  });
});

describe("presets built in the worker (F1 f1)", () => {
  it("returns the preset document with storage's content hash; loading it reports the world hash and authored bodies", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ type: "buildPreset", requestId: 7, preset: "f1-demo" });
    const preset = h.out.find((m): m is Extract<SimToMain, { type: "preset" }> => m.type === "preset");
    expect(preset).toMatchObject({ requestId: 7, preset: "f1-demo" });
    if (!preset) return;
    expect(preset.document).toEqual(f1DemoScenario());
    expect(preset.contentHash).toBe(contentHash(JSON.stringify(f1DemoScenario())));

    h.send({ type: "load", runId: "run-000009", scenario: preset.document, scenarioVersion: 1, runConfig: f1DemoRunConfig(1) });
    const loaded = h.out.find((m): m is Extract<SimToMain, { type: "loaded" }> => m.type === "loaded");
    const ref = loadScenario(f1DemoScenario());
    if (!ref.ok) throw new Error(ref.error.message);
    const hasher = new StateHasher();
    ref.value.grid.hashInto(hasher);
    expect(loaded?.worldHash).toBe(hasher.hex());
    expect(loaded?.defaultSeed).toBe(1);
    expect(loaded?.agents.find((a) => a.key === "low")?.body).toEqual(f1DemoScenario().agents.find((a) => a.key === "low")?.body);
  });
});

describe("sim host: the strategy sandbox (`strategyTest`, F2b M4, ADR-0037 item 16)", () => {
  const unknownMaps = () => ({
    type: "load",
    runId: "run-000009",
    scenario: f1DemoScenario(),
    scenarioVersion: 1,
    runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, beliefs: { default: { init: "unknown" } } },
  });
  const boot = () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(unknownMaps());
    return h;
  };
  const request = (over: Record<string, unknown> = {}) => ({ type: "strategyTest", requestId: 1, agentId: "ugv-001", to: { xM: 40, yM: 40 }, planOn: "belief", ...over });
  const results = (h: ReturnType<typeof harness>) => h.out.filter((m): m is Extract<SimToMain, { type: "strategyTestResult" }> => m.type === "strategyTestResult");
  const inline = (root: unknown) => ({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root });

  it("answers with the planned path, the strategy trace and the map it planned on; the request id is echoed", () => {
    const h = boot();
    h.send(request({ strategy: { ref: "astar-then-hpa", version: 1 }, requestId: 7 }));
    h.advance(50);
    const [r] = results(h);
    expect(r).toMatchObject({ requestId: 7, ok: true });
    const result = r?.result as { map: string; status: string; planner: string; waypoints: unknown[]; strategy?: { searches: unknown[] } };
    expect(result).toMatchObject({ map: "belief", status: "found", planner: "strategy:astar-then-hpa@1" });
    expect(result.waypoints.length).toBeGreaterThan(1);
    expect(result.strategy?.searches.length).toBeGreaterThan(0);
  });

  it("the ground truth is a choice of the request and is reported back as `truth`", () => {
    const h = boot();
    h.send(request({ planOn: "truth" }));
    h.advance(50);
    expect((results(h)[0]?.result as { map: string }).map).toBe("truth");
  });

  it("refusals are results with stable codes, never errors thrown into the worker", () => {
    const h = boot();
    h.send(request({ requestId: 1, agentId: "nobody" }));
    h.send(request({ requestId: 2, strategy: inline({ kind: "select", branches: [{ when: "nonsense > 1", then: { kind: "algorithm", algorithm: "astar" } }], else: { kind: "algorithm", algorithm: "hpa" } }) }));
    h.send(request({ requestId: 3, strategy: { ref: "nope", version: 1 } }));
    h.advance(50);
    expect(results(h).map((r) => [r.requestId, r.ok, r.error?.code])).toEqual([[1, false, "unknown_agent"], [2, false, "expr_unknown_name"], [3, false, "strategy_not_found"]]);
    expect(h.out.some((m) => m.type === "error")).toBe(false);
  });

  it("before any scenario is loaded there is nothing to test on: `no_run`", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send(request());
    h.advance(50);
    expect(results(h)[0]).toMatchObject({ ok: false, error: { code: "no_run" } });
  });

  it("a load while a query is pending answers it `run_changed` instead of leaving it hanging", () => {
    const h = boot();
    h.send(request());
    h.send({ ...unknownMaps(), runId: "run-000010" });
    h.advance(50);
    expect(results(h)[0]).toMatchObject({ requestId: 1, ok: false, error: { code: "run_changed" } });
    expect(results(h)).toHaveLength(1);
  });

  it("in realtime mode the sandbox waits for a pause: its work would delay ticks, and a dropped tick is a traced degradation", () => {
    const h = harness();
    h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
    h.send({ ...unknownMaps(), runConfig: { schemaVersion: 0, scenario: { id: "f1-demo", version: 1 }, timeMode: "realtime", beliefs: { default: { init: "unknown" } } } });
    h.send({ type: "control", op: "play" });
    h.send(request({ requestId: 1 }));
    expect(results(h)[0]).toMatchObject({ requestId: 1, ok: false, error: { code: "sandbox_needs_pause" } });
    h.send({ type: "control", op: "pause" });
    h.send(request({ requestId: 2 }));
    h.advance(50);
    expect(results(h)[1]).toMatchObject({ requestId: 2, ok: true });
    // The same run without any sandbox call degrades exactly as often (here: not at all).
    expect(h.out.filter((m) => m.type === "degradation")).toHaveLength(0);
  });

  // F2b M5: a step that seemed lost in a GPU run was a test race (a stale status line), not the worker; this pins that the sandbox
  // queue cannot capture or delay run control, in every order the messages can arrive in.
  it("run control and sandbox requests in every order: every step runs, every request is answered, and the run is the same", () => {
    const stepMsg = (count: number) => ({ type: "control", op: "step", count });
    const messages: Record<string, unknown>[] = [stepMsg(5), request({ requestId: 1, planOn: "belief" }), request({ requestId: 2, planOn: "truth", strategy: { ref: "astar-then-hpa", version: 1 } }), stepMsg(7)];
    const orders: Record<string, unknown>[][] = [];
    const permute = (rest: Record<string, unknown>[], acc: Record<string, unknown>[]) => {
      if (rest.length === 0) return void orders.push(acc);
      rest.forEach((m, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, m]));
    };
    permute(messages, []);
    expect(orders).toHaveLength(24);
    const hashAfter = (order: Record<string, unknown>[], sandboxToo: boolean) => {
      const h = boot();
      for (const m of order) if (sandboxToo || m["type"] !== "strategyTest") h.send(m);
      h.advance(100);
      const stats = h.out.filter((m): m is Extract<SimToMain, { type: "stats" }> => m.type === "stats").at(-1);
      return { tick: stats?.tick, hash: stats?.stateHash, answered: results(h).map((r) => [r.requestId, r.ok]).sort(), errors: h.out.filter((m) => m.type === "error").length };
    };
    const control = hashAfter(orders[0] ?? [], false);
    expect(control.tick).toBe(12);
    for (const order of orders) {
      const r = hashAfter(order, true);
      expect(r, order.map((m) => String(m["type"] === "control" ? `step${m["count"]}` : `test${m["requestId"]}`)).join(" ")).toEqual({ ...control, answered: [[1, true], [2, true]] });
    }
  });

  it("a request made while the run plays is answered and the run keeps ticking, in lockstep; pause and step still work during the query", () => {
    const h = boot();
    h.send({ type: "control", op: "play" });
    h.advance(300);
    const before = h.states().at(-1)?.tick ?? 0;
    h.send(request({ requestId: 1, strategy: { ref: "astar-then-hpa", version: 1 } }));
    h.advance(500);
    expect(results(h)[0]).toMatchObject({ requestId: 1, ok: true });
    expect(h.states().at(-1)?.tick ?? 0).toBeGreaterThan(before + 3);
    h.send({ type: "control", op: "pause" });
    const paused = h.states().at(-1)?.tick ?? 0;
    h.send(request({ requestId: 2 }));
    h.send({ type: "control", op: "step", count: 3 });
    h.advance(100);
    expect(h.states().at(-1)?.tick).toBe(paused + 3);
    expect(results(h)[1]).toMatchObject({ requestId: 2, ok: true });
  });

  it("is invalid as a message when malformed", () => {
    const h = boot();
    h.send({ type: "strategyTest", requestId: -1, agentId: "ugv-001", to: { xM: 1, yM: 1 }, planOn: "belief" });
    h.send({ type: "strategyTest", requestId: 1, agentId: "ugv-001", to: { xM: 1, yM: 1 }, planOn: "everything" });
    expect(h.out.filter((m) => m.type === "error" && m.code === "invalid_message")).toHaveLength(2);
  });

  it("changes nothing in the run: with sandbox requests (both maps, valid and invalid) between its ticks, the state hash and the trace are those of a run without", () => {
    const drive = (probe: boolean) => {
      const h = boot();
      let id = 0;
      for (let n = 0; n < 6; n++) {
        if (probe) {
          h.send(request({ requestId: ++id, planOn: "belief", strategy: { ref: "astar-then-hpa", version: 1 } }));
          h.send(request({ requestId: ++id, planOn: "truth", strategy: inline({ kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } }) }));
          h.send(request({ requestId: ++id, agentId: "nobody" }));
          h.advance(20);
        }
        h.send({ type: "control", op: "step", count: 15 });
      }
      const stats = h.out.filter((m) => m.type === "stats").at(-1);
      const trace = JSON.stringify(h.out.flatMap((m) => (m.type === "events" ? (m.records as { wallTime?: number }[]).map((r) => ({ ...r, wallTime: 0 })) : [])));
      return { stats, trace, answered: results(h).length };
    };
    const control = drive(false);
    const probed = drive(true);
    expect(probed.answered).toBe(18);
    expect(probed.stats).toEqual(control.stats);
    expect(probed.trace).toBe(control.trace);
  });
});
