import { RECORDING_PRESETS, type RecorderBatch } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { demo, flush, harness, init, stored } from "./sim-host-harness.ts";

// F3a M2: the recorder in the sim worker (ADR-0035 addition of 2026-10-17, items 6 and 12): header first, batches over a direct port,
// the panel stream fed from what the recorder gathered, and a run that is the same whether or not it is recorded.

describe("sim host: recording (header first)", () => {
  it("holds the run at tick 0 until the storage worker has the run header, then runs and hands over everything from the start", () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(demo(stored()));
    expect(h.states().at(-1)).toMatchObject({ tick: 0 });
    h.send({ type: "control", op: "play" });
    h.advance(1000);
    expect(h.states().at(-1)?.tick).toBe(0); // the header is not stored: no tick
    expect(h.batches()).toEqual([]); // and nothing is sent
    h.fromStorage({ type: "header", runId: "run-000007" });
    expect(h.batches()).toHaveLength(1); // what genesis emitted, in one batch
    expect(h.batches()[0]?.records[0]?.seq).toBe(0);
    h.advance(1000);
    expect(h.states().at(-1)?.tick).toBeGreaterThanOrEqual(9); // paced from the moment the header arrived, no burst of catch-up ticks
    expect(h.states().at(-1)?.tick).toBeLessThanOrEqual(11);
  });

  it("does not step on request before the header is stored, and steps once it is", async () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(demo(stored()));
    h.send({ type: "control", op: "pause" });
    h.send({ type: "control", op: "step", count: 3 });
    await flush();
    expect(h.states().at(-1)?.tick).toBe(0);
    h.fromStorage({ type: "header", runId: "run-000007" });
    await flush();
    expect(h.states().at(-1)?.tick).toBe(3);
  });

  it("refuses a recorded run when no recorder port was given, with a stable code, and keeps the current world", () => {
    const h = harness();
    init(h);
    h.send(demo(stored()));
    expect(h.errors().at(-1)).toMatchObject({ code: "recording_unavailable" });
    expect(h.out.some((m) => m.type === "loaded")).toBe(false);
  });

  it("refuses a recorded run whose profile is not a recording profile", () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(demo({ mode: "stored", profile: { schemaVersion: 0, name: "x" } }));
    expect(h.errors().at(-1)).toMatchObject({ code: "invalid_recording_profile" });
    expect(h.out.some((m) => m.type === "loaded")).toBe(false);
  });
});

describe("sim host: recording (batches and the panel stream)", () => {
  async function recorded(ticks: number, profile: keyof typeof RECORDING_PRESETS = "default-research") {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(demo(stored(profile)));
    h.fromStorage({ type: "header", runId: "run-000007" });
    h.send({ type: "control", op: "step", count: ticks });
    await flush();
    return h;
  }

  it("hands over every record of the run once, in order, and the panel stream shows the same records", async () => {
    const h = await recorded(60);
    const sent = h.batches().flatMap((b) => b.records);
    expect(sent.map((r) => r.seq)).toEqual(h.trace().all().map((r) => r.seq));
    expect(sent.length).toBeGreaterThan(0);
    expect(h.events().map((r) => r.id)).toEqual(sent.map((r) => r.id));
    expect(h.batches().at(-1)).toMatchObject({ runId: "run-000007", tick: 60 });
  });

  it("applies the profile to what it hands over and to the panel stream, and a persisted head frees the cache", async () => {
    const h = await recorded(60, "minimal");
    const kinds = new Set(h.batches().flatMap((b) => b.records).map((r) => (r.payload as { op?: string } | undefined)?.op));
    expect(kinds.has("belief-vs-truth")).toBe(false);
    expect(h.trace().all().some((r) => (r.payload as { op?: string } | undefined)?.op === "belief-vs-truth")).toBe(true); // emitted, dropped by the profile
    const last = h.batches().at(-1) as RecorderBatch;
    h.fromStorage({ type: "persisted", head: { runId: last.runId, throughSeq: last.throughSeq, tick: last.tick, simTimeS: last.simTimeS } });
    expect(h.errors()).toEqual([]);
  });

  it("stops the run and says why when the storage worker refuses a batch", async () => {
    const h = await recorded(5);
    h.send({ type: "control", op: "play" });
    h.fromStorage({ type: "rejected", runId: "run-000007", code: "duplicate_seq", message: "dup" });
    expect(h.errors().at(-1)).toMatchObject({ code: "recording_failed" });
    const n = h.states().length;
    h.advance(1000);
    expect(h.states()).toHaveLength(n); // paused
  });
});

describe("sim host: a run is the same whether or not it is recorded, and an opted-out run runs without a recorder", () => {
  async function hashAfter(ticks: number, recording: unknown, withPort: boolean): Promise<{ hash: string | undefined; batches: number; events: number }> {
    const h = harness();
    init(h);
    if (withPort) h.send({ type: "recorderPort", port: h.port });
    h.send(demo(recording));
    if (recording !== undefined && (recording as { mode: string }).mode === "stored") h.fromStorage({ type: "header", runId: "run-000007" });
    h.send({ type: "control", op: "step", count: ticks });
    await flush();
    const stats = h.out.filter((m) => m.type === "stats").at(-1);
    return { hash: stats?.type === "stats" ? stats.stateHash : undefined, batches: h.batches().length, events: h.events().length };
  }

  it("gives the same state hash after 100 ticks recorded under any preset, opted out, and not asked about at all", async () => {
    const plain = await hashAfter(100, undefined, false);
    expect(plain.hash).toMatch(/^[0-9a-f]{8}$/);
    for (const name of Object.keys(RECORDING_PRESETS) as (keyof typeof RECORDING_PRESETS)[]) {
      const r = await hashAfter(100, stored(name), true);
      expect(r.hash, name).toBe(plain.hash);
      expect(r.batches, name).toBeGreaterThan(0);
    }
    const none = await hashAfter(100, { mode: "none" }, true);
    expect(none.hash).toBe(plain.hash);
    expect(none.batches).toBe(0);
  });

  it("an opted-out run starts at once, sends nothing to the storage worker, and its panel stream still shows every record", async () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(demo({ mode: "none" }));
    h.send({ type: "control", op: "step", count: 30 });
    await flush();
    expect(h.states().at(-1)?.tick).toBe(30);
    expect(h.toStorage).toEqual([]);
    expect(h.events().map((r) => r.seq)).toEqual(h.trace().all().map((r) => r.seq));
  });
});
