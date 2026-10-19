import { f1DemoRunConfig } from "@agentsim/scenarios";
import type { FlowControl, RecorderBatch, TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { demo, flush, harness, init, stored, type Harness } from "./sim-host-harness.ts";

// F3a M2: flow control and quota in the sim worker (ADR-0035 §6; ADR-0013 addition of 2026-10-17): above the high mark of the backlog the run
// waits at the end of the tick (wall time only in lockstep, a traced `storage_backpressure` degradation in realtime), and a storage quota near
// its limit pauses the run as `storage_quota`; neither changes what the run does, and no record is dropped or reordered.

// A recorded demo run writes a few records per second (pose samples, checkpoints, snapshots), so the marks are small.
const tight: FlowControl = { highRecords: 60, lowRecords: 30, highBytes: 100_000_000, lowBytes: 50_000_000 };

const ack = (h: Harness, b: RecorderBatch) => h.fromStorage({ type: "persisted", head: { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS } });
/** The storage worker saves every batch handed over so far (and not before). */
const saveAll = (h: Harness, from = 0) => h.batches().slice(from).forEach((b) => ack(h, b));
const recordingStates = (h: Harness) => h.out.filter((m) => m.type === "recording").map((m) => (m.type === "recording" ? m.state : ""));
const realtimeDemo = () => ({ ...demo(stored()), runConfig: { ...(f1DemoRunConfig(1) as object), timeMode: "realtime" } });

function started(options: { flow: FlowControl }, load: () => unknown = () => demo(stored())) {
  const h = harness(options);
  init(h);
  h.send({ type: "recorderPort", port: h.port });
  h.send(load());
  h.fromStorage({ type: "header", runId: "run-000007" });
  return h;
}

/** What a run wrote that does not depend on the clock or on when it was stopped: time, kind, source and payload of each record, in order. */
const written = (h: Harness) =>
  h
    .batches()
    .flatMap((b) => b.records)
    // Snapshots and checkpoints at a stop depend on when the run was stopped, which is not what is compared here.
    .filter((r) => r.kind !== "snapshot" && (r.payload as { op?: string } | undefined)?.op !== "checkpoint")
    .map((r: TraceRecord) => JSON.stringify([r.simTime, r.kind, r.source, r.payload]));

describe("flow control: lockstep", () => {
  it("waits at the end of the tick when the backlog is above the high mark, and goes on when it is at or below the low mark: wall time only", () => {
    const h = started({ flow: tight });
    h.send({ type: "control", op: "play" });
    h.advance(15000); // the writer saves nothing
    const stuck = h.states().at(-1)?.tick ?? 0;
    expect(stuck).toBeGreaterThan(0);
    expect(stuck).toBeLessThan(140); // free-running it would be at tick 150
    h.advance(3000);
    expect(h.states().at(-1)?.tick).toBe(stuck); // still waiting
    expect(recordingStates(h)).toEqual(["storage_backpressure"]);
    saveAll(h);
    expect(recordingStates(h)).toEqual(["storage_backpressure", "ok"]);
    h.advance(500);
    expect(h.states().at(-1)?.tick).toBeGreaterThan(stuck);
    // Lockstep: no degradation, in the run or in its trace.
    expect(h.out.some((m) => m.type === "degradation")).toBe(false);
    expect(h.trace().ofKind("degradation")).toEqual([]);
  });

  it("gives the same records, seqs, times, payloads and state hash as a run whose writer is never behind, and drops nothing", async () => {
    const slow = started({ flow: tight });
    const fast = started({ flow: { ...tight, highRecords: 1_000_000 } });
    for (const h of [slow, fast]) h.send({ type: "control", op: "play" });
    for (let t = 0; t < 30; t++) {
      slow.advance(100);
      saveAll(slow, Math.max(0, slow.batches().length - 1)); // the slow writer saves its latest batch only now and then
      fast.advance(100);
      saveAll(fast, fast.batches().length - 1);
    }
    // Let the slow one catch up completely, then run both to the same tick.
    for (let i = 0; i < 50 && (slow.states().at(-1)?.tick ?? 0) < 100; i++) {
      slow.advance(200);
      saveAll(slow);
    }
    for (const h of [slow, fast]) {
      h.send({ type: "control", op: "pause" });
      h.send({ type: "control", op: "step", count: Math.max(0, 100 - (h.states().at(-1)?.tick ?? 0)) });
    }
    await flush();
    const a = slow.out.filter((m) => m.type === "stats").at(-1);
    const b = fast.out.filter((m) => m.type === "stats").at(-1);
    expect(a?.type === "stats" && a.tick).toBe(100);
    expect(a?.type === "stats" && a.stateHash).toBe(b?.type === "stats" ? b.stateHash : undefined);
    expect(written(slow)).toEqual(written(fast)); // ids and seqs differ: the records of a stop (an end snapshot) fall at other places
    expect(written(slow).length).toBeGreaterThan(0);
    const seqs = slow.batches().flatMap((x) => x.records.map((r) => r.seq));
    expect(seqs).toEqual([...seqs].sort((p, q) => p - q));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("makes a step wait for the writer as well, and runs it when the backlog is down", async () => {
    const h = started({ flow: tight });
    h.send({ type: "control", op: "pause" });
    h.send({ type: "control", op: "step", count: 100 });
    await flush();
    const reached = h.states().at(-1)?.tick ?? 0;
    expect(reached).toBeLessThan(100);
    saveAll(h);
    await flush();
    saveAll(h);
    await flush();
    for (let i = 0; i < 20 && (h.states().at(-1)?.tick ?? 0) < 100; i++) {
      saveAll(h);
      await flush();
    }
    expect(h.states().at(-1)?.tick).toBe(100);
  });
});

describe("flow control: realtime", () => {
  it("traces the wait as a storage_backpressure degradation with the backlog and the wait, once it ends", () => {
    const h = started({ flow: tight }, realtimeDemo);
    h.send({ type: "control", op: "play" });
    h.advance(15000);
    expect(h.trace().ofKind("degradation").filter((r) => (r.payload as { reason?: string }).reason === "storage_backpressure")).toEqual([]); // still waiting
    saveAll(h);
    h.advance(100);
    const deg = h.trace().ofKind("degradation").filter((r) => (r.payload as { reason?: string }).reason === "storage_backpressure");
    expect(deg).toHaveLength(1);
    const p = deg[0]?.payload as { backlogRecords: number; backlogBytes: number; waitMs: number; tick: number };
    expect(p.backlogRecords).toBeGreaterThanOrEqual(60);
    expect(p.backlogBytes).toBeGreaterThan(0);
    expect(p.waitMs).toBeGreaterThan(1000);
    expect(deg[0]).toMatchObject({ source: "world/sim", kind: "degradation", detail: "full" });
  });

  it("hands the degradation record over like any other record", () => {
    const h = started({ flow: tight }, realtimeDemo);
    h.send({ type: "control", op: "play" });
    h.advance(15000);
    saveAll(h);
    h.advance(500);
    saveAll(h);
    h.advance(500);
    const handed = h.batches().flatMap((b) => b.records).filter((r) => r.kind === "degradation" && (r.payload as { reason?: string }).reason === "storage_backpressure");
    expect(handed).toHaveLength(1);
  });
});

describe("quota: the run pauses as storage_quota and goes on when space is free", () => {
  const paused = { type: "quota", state: "paused", usageBytes: 950, quotaBytes: 1000 };
  const ok = { type: "quota", state: "ok", usageBytes: 500, quotaBytes: 1000 };

  it("pauses a playing run, says so, and resumes it when the worker says the space is free", () => {
    const h = started({ flow: { ...tight, highRecords: 1_000_000 } });
    h.send({ type: "control", op: "play" });
    h.advance(500);
    const at = h.states().at(-1)?.tick ?? 0;
    h.fromStorage(paused);
    expect(recordingStates(h)).toEqual(["storage_quota"]);
    h.advance(2000);
    expect(h.states().at(-1)?.tick).toBe(at); // paused
    h.fromStorage(ok);
    expect(recordingStates(h)).toEqual(["storage_quota", "ok"]);
    h.advance(1000);
    expect(h.states().at(-1)?.tick).toBeGreaterThanOrEqual(at + 9);
  });

  it("does not start a run that was paused by hand when space is free again", () => {
    const h = started({ flow: { ...tight, highRecords: 1_000_000 } });
    h.send({ type: "control", op: "pause" });
    h.fromStorage(paused);
    h.fromStorage(ok);
    const n = h.states().length;
    h.advance(1000);
    expect(h.states()).toHaveLength(n);
  });

  it("hands over what the run produced up to the pause, whole and in order, with no gap, and nothing is lost on the way through", () => {
    const h = started({ flow: { ...tight, highRecords: 1_000_000 } });
    h.send({ type: "control", op: "play" });
    h.advance(700);
    h.fromStorage(paused);
    h.advance(500);
    h.fromStorage(ok);
    h.advance(700);
    const seqs = h.batches().flatMap((b) => b.records.map((r) => r.seq));
    expect(seqs).toEqual(h.trace().all().map((r) => r.seq).filter((s) => s <= (seqs.at(-1) ?? -1)));
    expect(seqs.length).toBeGreaterThan(0);
    expect(h.errors()).toEqual([]);
  });

  it("a step waits for the space as well", async () => {
    const h = started({ flow: { ...tight, highRecords: 1_000_000 } });
    h.send({ type: "control", op: "pause" });
    h.fromStorage(paused);
    h.send({ type: "control", op: "step", count: 5 });
    await flush();
    expect(h.states().at(-1)?.tick).toBe(0);
    h.fromStorage(ok);
    await flush();
    expect(h.states().at(-1)?.tick).toBe(5);
  });
});

