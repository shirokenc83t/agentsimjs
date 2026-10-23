import { f1DemoRunConfig } from "@agentsim/scenarios";
import type { FlowControl, RecorderBatch } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { demo, discovery, flush, harness, init, stored, type Harness } from "./sim-host-harness.ts";

// Headless runs (ADR-0029, ADR-0035 section 7): no render state, as fast as lockstep allows, realtime refused, always recorded, and the same state hashes as the same run in a live
// lockstep view. The storage worker's end of the recorder channel is played by the test.

const headlessLoad = (load: ReturnType<typeof demo>, untilS?: number) => ({ ...load, headless: untilS === undefined ? {} : { untilS } });
const progress = (h: Harness) => h.out.filter((m): m is Extract<(typeof h.out)[number], { type: "progress" }> => m.type === "progress");
const checkpoints = (h: Harness) =>
  h
    .trace()
    .all()
    .filter((r) => (r.payload as { op?: string } | undefined)?.op === "checkpoint")
    .map((r) => ({ tick: (r.payload as { tick: number }).tick, stateHash: (r.payload as { stateHash: string }).stateHash }))
    // An end snapshot at a tick that has a checkpoint writes another one (the same hash): one per tick.
    .filter((c, i, all) => all.findIndex((x) => x.tick === c.tick) === i);

function started(load: unknown, options?: { flow: FlowControl }) {
  const h = harness(options);
  init(h);
  h.send({ type: "recorderPort", port: h.port });
  h.send(load);
  h.fromStorage({ type: "header", runId: "run-000007" });
  return h;
}

const ack = (h: Harness, b: RecorderBatch) => h.fromStorage({ type: "persisted", head: { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS } });

describe("headless runs: no render state, and a stop of its own", () => {
  it("posts no render state (no state, no chunks, no grid), runs to its end condition without pacing, and reports it done with its end snapshot", () => {
    const h = started(headlessLoad(demo(stored()), 30));
    const before = h.states().length; // the dummy world's, before the load
    h.send({ type: "control", op: "play" });
    h.advance(50); // far less than the 30 s of sim time a paced run needs: it is not paced
    expect(h.states()).toHaveLength(before);
    expect(h.out.some((m) => m.type === "chunks")).toBe(false);
    expect(h.out.some((m) => m.type === "grid")).toBe(false);
    const p = progress(h);
    const last = p.at(-1);
    expect(last).toMatchObject({ headless: true, running: false, done: true, tick: 300, untilS: 30, waiting: "none" });
    expect(last?.simTimeS).toBeCloseTo(30);
    expect(last?.snapshotTicks[0]).toBe(0);
    expect(last?.snapshotTicks.at(-1)).toBe(300); // the end snapshot
    expect(last?.recordsHandedOver).toBeGreaterThan(0);
    expect(last?.stateHash).toMatch(/^[0-9a-f]{8}$/);
    // It does not go on once it is over.
    h.send({ type: "control", op: "play" });
    h.advance(500);
    expect(progress(h).at(-1)?.tick).toBe(300);
  });

  it("is one worker poll's worth of ticks at a time, so the worker stays responsive (a pause between polls stops it where it is)", () => {
    const h = started(headlessLoad(demo(stored())));
    h.send({ type: "control", op: "play" });
    h.advance(1); // one poll
    h.send({ type: "control", op: "pause" });
    const t1 = progress(h).at(-1)?.tick ?? 0;
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(400);
    expect(progress(h).at(-1)).toMatchObject({ running: false, done: false });
    h.advance(100);
    expect(progress(h).at(-1)?.tick).toBe(t1);
    h.send({ type: "control", op: "play" });
    h.advance(3);
    expect(progress(h).at(-1)?.tick).toBeGreaterThan(t1); // and it goes on from where it was
  });

  it("stops when asked, with its end snapshot written and the run reported done; a run that is not headless ignores the request", () => {
    const h = started(headlessLoad(demo(stored())));
    h.send({ type: "control", op: "play" });
    h.advance(1);
    h.send({ type: "control", op: "stop" });
    const last = progress(h).at(-1);
    expect(last).toMatchObject({ running: false, done: true });
    expect(last?.snapshotTicks.at(-1)).toBe(last?.tick); // the end snapshot is at the tick it stopped at
    h.send({ type: "control", op: "play" });
    h.advance(100);
    expect(progress(h).at(-1)?.tick).toBe(last?.tick); // over: it does not go on
    const live = started(demo(stored()));
    live.send({ type: "control", op: "stop" });
    expect(progress(live)).toEqual([]);
  });

  it("goes on with a live view when asked: the grid and the state follow from the next tick, paced at the tick rate", () => {
    const h = started(headlessLoad(demo(stored())));
    h.send({ type: "control", op: "play" });
    h.advance(1);
    const states = h.states().length;
    h.send({ type: "control", op: "liveView" });
    expect(h.out.some((m) => m.type === "grid")).toBe(true);
    expect(h.states().length).toBe(states + 1);
    const tick = h.states().at(-1)?.tick ?? 0;
    expect(tick).toBeGreaterThan(0);
    expect(progress(h).at(-1)).toMatchObject({ headless: false, tick });
    h.advance(1000);
    const last = h.states().at(-1)?.tick ?? 0;
    expect(last - tick).toBeGreaterThanOrEqual(9); // paced: about 10 ticks a second
    expect(last - tick).toBeLessThanOrEqual(11);
  });
});

describe("headless runs: what they refuse", () => {
  it("rejects realtime: a run configuration that asks for it is refused with a stable code before anything changes, and so is a switch to it", () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send({ ...headlessLoad(demo(stored())), runConfig: { ...(f1DemoRunConfig(1) as object), timeMode: "realtime" } });
    expect(h.errors().at(-1)).toMatchObject({ code: "headless_realtime" });
    expect(h.out.some((m) => m.type === "loaded")).toBe(false);
    // A headless run loaded in lockstep: realtime cannot be switched on.
    h.send(headlessLoad(demo(stored())));
    h.send({ type: "control", op: "setMode", mode: "realtime" });
    expect(h.errors().at(-1)).toMatchObject({ code: "headless_realtime" });
  });

  it("has no opt-out: a headless run is always recorded (neither `none` nor no recording at all)", () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(headlessLoad(demo({ mode: "none" })));
    expect(h.errors().at(-1)).toMatchObject({ code: "headless_needs_recording" });
    h.send(headlessLoad(demo()));
    expect(h.errors().at(-1)).toMatchObject({ code: "headless_needs_recording" });
    expect(h.out.some((m) => m.type === "loaded")).toBe(false);
  });
});

describe("headless runs: the same simulation", () => {
  // The state hash at every checkpoint, headless against the same scenario version, run configuration and seed in a live lockstep view (ADR-0029 equivalence).
  for (const [name, load] of [["the F1 demo", demo], ["F2 discovery (unknown maps)", discovery]] as const) {
    it(`${name}: a headless run and a live lockstep run have the same state hash at every checkpoint, and the same final one`, async () => {
      const headless = started(headlessLoad(load(stored()), 40));
      headless.send({ type: "control", op: "play" });
      headless.advance(50);
      expect(progress(headless).at(-1)).toMatchObject({ done: true, tick: 400 });
      const live = started(load(stored()));
      live.send({ type: "control", op: "step", count: 400 });
      await flush();
      expect(live.states().at(-1)?.tick).toBe(400);
      // The headless run also wrote its end snapshot and the checkpoint with it (a stop is not where a live run is paused): compare the checkpoints both have.
      const b = checkpoints(live);
      const a = checkpoints(headless).filter((c) => b.some((x) => x.tick === c.tick));
      expect(a.length).toBeGreaterThanOrEqual(5);
      expect(a).toEqual(b);
      const hashOf = (h: Harness) => progressOrStats(h);
      expect(hashOf(headless)).toBe(hashOf(live));
    });
  }

  it("a researcher command at a tick is applied the same way: the same hashes after it", async () => {
    const run = (headless: boolean) => {
      const h = started(headless ? headlessLoad(demo(stored()), 40) : demo(stored()));
      h.send({ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 40, yM: 10 } });
      return h;
    };
    const a = run(true);
    a.send({ type: "control", op: "play" });
    a.advance(50);
    const b = run(false);
    b.send({ type: "control", op: "step", count: 400 });
    await flush();
    const live = checkpoints(b);
    const head = checkpoints(a).filter((c) => live.some((x) => x.tick === c.tick));
    expect(head.length).toBeGreaterThanOrEqual(5);
    expect(head).toEqual(live);
  });
});

function progressOrStats(h: Harness): string | undefined {
  const stats = h.out.filter((m) => m.type === "stats").at(-1);
  return stats?.type === "stats" ? stats.stateHash : undefined;
}

describe("headless runs: the writer", () => {
  const tight: FlowControl = { highRecords: 60, lowRecords: 30, highBytes: 100_000_000, lowBytes: 50_000_000 };

  it("waits for the writer like any recorded run (wall time only): progress says what it waits for, and it goes on when the backlog falls", () => {
    const h = started(headlessLoad(demo(stored()), 60), { flow: tight });
    h.send({ type: "control", op: "play" });
    h.advance(200); // the writer saves nothing
    const stuck = progress(h).at(-1);
    expect(stuck).toMatchObject({ waiting: "storage_backpressure", running: true, done: false });
    expect(stuck?.backlogRecords).toBeGreaterThanOrEqual(60);
    const tick = stuck?.tick ?? 0;
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThan(600);
    h.advance(500);
    expect(progress(h).at(-1)?.tick).toBe(tick); // still waiting, not skipping ahead
    for (const b of h.batches()) ack(h, b);
    h.advance(200);
    expect(progress(h).at(-1)?.tick).toBeGreaterThan(tick);
    // No degradation record: only wall time was lost.
    expect(h.trace().ofKind("degradation")).toEqual([]);
  });

  it("waits for the run header before it steps at all", () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(headlessLoad(demo(stored()), 10));
    h.send({ type: "control", op: "play" });
    h.advance(100);
    expect(progress(h).at(-1)).toMatchObject({ tick: 0, waiting: "header" });
    h.fromStorage({ type: "header", runId: "run-000007" });
    h.advance(100);
    expect(progress(h).at(-1)).toMatchObject({ done: true, tick: 100 });
  });
});
