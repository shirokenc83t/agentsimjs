import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotWriter } from "@agentsim/core";
import { RECORDING_PRESETS, recordingProfileHash } from "@agentsim/trace";
import { describeStorageContract } from "../testing/contract.ts";
import { LATEST_SCHEMA_VERSION } from "../sql/migrations.ts";
import { createStorageClient, type StorageClient, type StorageClientOptions } from "./storage-client.ts";

const workers: { worker: Worker; client: StorageClient }[] = [];

function spawn(opts: Partial<StorageClientOptions> = {}): StorageClient {
  const worker = new Worker(new URL("../testing/storage-test.worker.ts", import.meta.url), { type: "module" });
  const client = createStorageClient(worker, { quotaThresholdBytes: 0, ...opts });
  workers.push({ worker, client });
  return client;
}

async function shutdown(client: StorageClient): Promise<void> {
  const i = workers.findIndex((w) => w.client === client);
  const entry = workers[i];
  if (!entry) return;
  workers.splice(i, 1);
  if (client.status().state === "ready") await client.admin.close();
  entry.worker.terminate();
}

afterEach(async () => {
  for (const w of [...workers]) await shutdown(w.client);
});

const header = (runId: string) => ({ runId, schemaVersion: 0, createdAtWallMs: 1, label: runId, status: "running" as const });
const rec = (runId: string, seq: number) => ({ id: `${runId}#${seq}`, runId, seq, simTime: seq, wallTime: 1, source: "world/sim", kind: "event" as const, payload: { seq } });

// The shared contract suite against the real storage worker (sqlite-wasm on opfs-sahpool).
describeStorageContract("sqlite-wasm storage worker (opfs-sahpool)", async () => {
  const client = spawn({ resetOnOpen: true });
  const ready = await client.ready();
  expect(ready.mode).toBe("opfs-sahpool");
  return { ports: client.ports, dispose: () => shutdown(client) };
});

describe("storage worker (browser)", () => {
  it("persists data across close and reopen", async () => {
    const a = spawn({ resetOnOpen: true });
    await a.ready();
    await a.ports.runs.create(header("run-000001"));
    await a.ports.trace.append([rec("run-000001", 0), rec("run-000001", 1)]);
    await shutdown(a);
    const b = spawn();
    await b.ready();
    expect(await b.ports.trace.count("run-000001")).toBe(2);
  });

  it("rejects requests queued behind close or sent after it, instead of hanging", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    // Sent back to back: append (before close), close, append (queued behind close).
    const before = c.ports.trace.append([rec("run-000001", 0)]);
    const closed = c.admin.close();
    const after = c.ports.trace.append([rec("run-000001", 1)]);
    expect((await before).ok).toBe(true);
    await closed;
    await expect(after).rejects.toMatchObject({ code: "closed" });
    await expect(c.ports.runs.list()).rejects.toMatchObject({ code: "closed" });
    // The committed append is durable.
    const reopened = spawn();
    await reopened.ready();
    expect(await reopened.ports.trace.count("run-000001")).toBe(1);
  });

  it("enforces one connection per database file", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    expect(await c.probeSecondConnection()).toBe("second_connection");
  });

  it("queues a second owner on the Web Lock until the first closes", async () => {
    const a = spawn({ resetOnOpen: true });
    await a.ready();
    const b = spawn();
    // Polled, not a fixed sleep: on slow CI runners the second worker may still be loading sqlite-wasm at 500 ms.
    await expect.poll(() => b.status().state, { timeout: 10_000 }).toBe("waiting-lock");
    await shutdown(a);
    expect((await b.ready()).mode).toBe("opfs-sahpool");
  });

  it("exports, then imports a validated file replacing the current database", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    const goTo = { inputId: "inp-000001", tick: 6, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } };
    expect((await c.ports.runs.appendInputs("run-000001", [goTo])).ok).toBe(true);
    const snapshot = await c.admin.exportDb();
    expect(new TextDecoder().decode(snapshot.subarray(0, 15))).toBe("SQLite format 3");
    await c.ports.runs.create(header("run-000002"));
    const r = await c.admin.importDb(snapshot);
    expect(r.ok).toBe(true);
    expect((await c.ports.runs.list()).map((x) => x.runId)).toEqual(["run-000001"]);
    // Run inputs travel with the database (they are part of what the run ran).
    expect(await c.ports.runs.inputs("run-000001")).toEqual([goTo]);
  });

  it("exports and imports a run with snapshots, blobs and belief frames, and exports one run alone", async () => {
    const profile = RECORDING_PRESETS["default-research"];
    const recorded = { ...header("run-000001"), recording: "stored" as const, recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) };
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(recorded);
    await c.ports.runs.create(header("run-000002"));
    const external = new Map<string, Uint8Array>();
    const w = new SnapshotWriter({ external: (h, b) => external.set(h, b) });
    const container = w.finish({ tick: 0, map: w.section({ chunk: Int8Array.from([1, 2, 3]) }) });
    const blobs = [...external].map(([id, bytes]) => ({ id, bytes }));
    const written = await c.ports.snapshots.write("run-000001", { seq: 0, simTime: 0, tick: 0, bytes: container, blobs });
    expect(written.ok).toBe(true);
    const kf = blobs[0];
    if (!kf) throw new Error("a blob was expected");
    const frames = [
      { agentId: "uav-001", seq: 0, tick: 0, simTime: 0, kind: "keyframe" as const, chunks: [0], blobId: kf.id },
      { agentId: "uav-001", seq: 1, tick: 5, simTime: 0.5, kind: "delta" as const, chunks: [0], data: Uint8Array.from([7, 8]) },
    ];
    expect((await c.ports.beliefFrames.append("run-000001", frames)).ok).toBe(true);
    const whole = await c.admin.exportDb();
    const one = await c.admin.exportRun("run-000001");
    expect(one.ok).toBe(true);
    await c.ports.snapshots.putBlobs("run-000002", [kf]);
    expect((await c.admin.importDb(whole)).ok).toBe(true);
    expect(await c.ports.snapshots.getBlob("run-000002", kf.id)).toBeUndefined(); // the import replaced the database
    expect(await c.ports.runs.get("run-000001")).toEqual(recorded);
    const loaded = written.ok ? await c.ports.snapshots.read("run-000001", written.value.id) : undefined;
    expect(loaded?.container).toEqual(container);
    expect(loaded?.blobs).toEqual(blobs);
    expect(await c.ports.beliefFrames.query({ runId: "run-000001", limit: 10 })).toEqual(frames);
    // A run exported alone is a database of its own that imports and keeps its recording.
    if (!one.ok) return;
    await shutdown(c); // one connection per database file: release it for the second worker
    const d = spawn({ resetOnOpen: true });
    await d.ready();
    expect((await d.admin.importDb(one.value)).ok).toBe(true);
    expect(await d.ports.beliefFrames.query({ runId: "run-000001", limit: 10 })).toEqual(frames);
    expect((await d.ports.snapshots.list("run-000001")).map((s) => s.tick)).toEqual([0]);
    expect((await d.ports.snapshots.getBlob("run-000001", kf.id))?.bytes).toEqual(kf.bytes);
  });

  it("takes recorder batches over a direct port: header first, records stored, the persisted head reported to both ends", async () => {
    const profile = RECORDING_PRESETS["default-research"];
    const recorded = { ...header("run-000001"), recording: "stored" as const, recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) };
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const channel = new MessageChannel();
    const simEnd = channel.port1;
    const fromStorage: { type: string; head?: { tick: number; throughSeq: number } }[] = [];
    simEnd.onmessage = (ev) => fromStorage.push(ev.data as (typeof fromStorage)[number]);
    const mainSaw: { tick: number; throughSeq: number }[] = [];
    c.onPersisted((h) => mainSaw.push({ tick: h.tick, throughSeq: h.throughSeq }));
    c.attachRecorderPort(channel.port2);
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    // The run header is stored by the main thread's client; the storage worker tells the recorder.
    expect((await c.ports.runs.create(recorded)).ok).toBe(true);
    await until(() => fromStorage.some((m) => m.type === "header"));
    simEnd.postMessage({ type: "batch", batch: { runId: "run-000001", records: [rec("run-000001", 0), rec("run-000001", 1)], throughSeq: 1, tick: 1, simTimeS: 0.1 } });
    simEnd.postMessage({ type: "batch", batch: { runId: "run-000001", records: [rec("run-000001", 2)], throughSeq: 3, tick: 2, simTimeS: 0.2 } });
    await until(() => fromStorage.some((m) => m.type === "persisted" && m.head?.tick === 2) && mainSaw.some((h) => h.tick === 2));
    expect((await c.ports.trace.query({ runId: "run-000001", limit: 10 })).map((r) => r.seq)).toEqual([0, 1, 2]);
    const heads = fromStorage.filter((m) => m.type === "persisted").map((m) => m.head?.tick);
    expect(heads.at(-1)).toBe(2);
    expect(heads).toEqual([...heads].sort((a, b) => (a ?? 0) - (b ?? 0))); // heads never go back
    expect(mainSaw.at(-1)).toEqual({ tick: 2, throughSeq: 3 });
    // A batch the store refuses (a seq already stored) is reported to the recorder, not lost silently, and moves no head.
    simEnd.postMessage({ type: "batch", batch: { runId: "run-000001", records: [rec("run-000001", 2)], throughSeq: 2, tick: 3, simTimeS: 0.3 } });
    await until(() => fromStorage.some((m) => m.type === "rejected"));
    expect(fromStorage.filter((m) => m.type === "persisted").at(-1)?.head?.tick).toBe(2);
    simEnd.close();
  });

  it("flow control: a slow writer saves every batch, in order, only later (nothing is dropped, nothing reordered)", async () => {
    const profile = RECORDING_PRESETS["default-research"];
    const recorded = { ...header("run-000001"), recording: "stored" as const, recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) };
    const c = spawn({ resetOnOpen: true, simulateSlowWriterMs: 80 });
    await c.ready();
    const channel = new MessageChannel();
    const heads: { tick: number; at: number }[] = [];
    let headerSeen = false;
    channel.port1.onmessage = (ev) => {
      const m = ev.data as { type: string; head?: { tick: number } };
      if (m.type === "header") headerSeen = true;
      if (m.type === "persisted") heads.push({ tick: m.head?.tick ?? -1, at: performance.now() });
    };
    c.attachRecorderPort(channel.port2);
    await c.ports.runs.create(recorded);
    for (let i = 0; i < 100 && !headerSeen; i++) await new Promise((r) => setTimeout(r, 10));
    expect(headerSeen).toBe(true);
    const t0 = performance.now();
    for (let b = 0; b < 6; b++) {
      channel.port1.postMessage({ type: "batch", batch: { runId: "run-000001", records: [rec("run-000001", b * 2), rec("run-000001", b * 2 + 1)], throughSeq: b * 2 + 1, tick: b + 1, simTimeS: (b + 1) * 0.1 } });
    }
    for (let i = 0; i < 300 && heads.at(-1)?.tick !== 6; i++) await new Promise((r) => setTimeout(r, 10));
    expect(heads.at(-1)?.tick).toBe(6);
    expect(heads[0]?.at ?? 0).toBeGreaterThanOrEqual(t0 + 70); // the first commit took its time
    expect(heads.map((h) => h.tick)).toEqual([...heads.map((h) => h.tick)].sort((a, b) => a - b));
    expect((await c.ports.trace.query({ runId: "run-000001", limit: 100 })).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    channel.port1.close();
  });

  it("quota: near the quota the worker holds the run's batches (saved prefix stays consistent), tells both ends, and stores them in order when space is free", async () => {
    const profile = RECORDING_PRESETS["default-research"];
    const recorded = { ...header("run-000001"), recording: "stored" as const, recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) };
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const base = (await c.admin.info()).dbFileBytes;
    await c.setSimulatedQuota(base * 2 + 400_000);
    const channel = new MessageChannel();
    const fromStorage: { type: string; state?: string; head?: { tick: number } }[] = [];
    channel.port1.onmessage = (ev) => fromStorage.push(ev.data as (typeof fromStorage)[number]);
    const mainQuota: string[] = [];
    c.onQuota((q) => mainQuota.push(q.state));
    c.attachRecorderPort(channel.port2);
    await c.ports.runs.create(recorded);
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond(), what).toBe(true);
    };
    await until(() => fromStorage.some((m) => m.type === "header"), "header");
    const big = (seq: number) => ({ ...rec("run-000001", seq), payload: { seq, pad: "x".repeat(30_000) } });
    let sent = 0;
    // Send batches of ten large records until the worker says the quota is near; it takes a few, never an unbounded number.
    for (let b = 0; b < 60 && !fromStorage.some((m) => m.type === "quota"); b++) {
      const records = Array.from({ length: 10 }, (_, i) => big(b * 10 + i));
      channel.port1.postMessage({ type: "batch", batch: { runId: "run-000001", records, throughSeq: b * 10 + 9, tick: b + 1, simTimeS: (b + 1) * 0.1 } });
      sent = b + 1;
      await new Promise((r) => setTimeout(r, 40));
    }
    await until(() => fromStorage.some((m) => m.type === "quota" && m.state === "paused"), "quota paused, to the recorder");
    expect(mainQuota).toContain("paused");
    // Two more batches after the pause are held, not stored and not lost.
    for (let b = sent; b < sent + 2; b++) {
      const records = Array.from({ length: 10 }, (_, i) => big(b * 10 + i));
      channel.port1.postMessage({ type: "batch", batch: { runId: "run-000001", records, throughSeq: b * 10 + 9, tick: b + 1, simTimeS: (b + 1) * 0.1 } });
    }
    sent += 2;
    // Wait until the stored count stops moving (the worker may still be working through what it had already queued when the quota was reached).
    let storedWhilePaused = await c.ports.trace.count("run-000001");
    for (let stable = 0; stable < 5; ) {
      await new Promise((r) => setTimeout(r, 100));
      const now = await c.ports.trace.count("run-000001");
      stable = now === storedWhilePaused ? stable + 1 : 0;
      storedWhilePaused = now;
    }
    expect(storedWhilePaused).toBeLessThan(sent * 10);
    expect(storedWhilePaused % 10).toBe(0); // whole batches only: a consistent prefix
    const prefix = await c.ports.trace.query({ runId: "run-000001", limit: 10_000 });
    expect(prefix.map((r) => r.seq)).toEqual([...Array(storedWhilePaused).keys()]);
    const headAtPause = fromStorage.filter((m) => m.type === "persisted").at(-1)?.head?.tick ?? 0;
    expect(headAtPause).toBe(storedWhilePaused / 10);
    // Space is free again: the held batches are stored in order, the head catches up, and both ends are told.
    await c.setSimulatedQuota(1_000_000_000);
    await until(() => fromStorage.some((m) => m.type === "quota" && m.state === "ok") && mainQuota.includes("ok"), "quota ok");
    await until(() => fromStorage.filter((m) => m.type === "persisted").at(-1)?.head?.tick === sent, "head caught up");
    expect(await c.ports.trace.count("run-000001")).toBe(sent * 10);
    const all = await c.ports.trace.query({ runId: "run-000001", limit: 10_000 });
    expect(all.map((r) => r.seq)).toEqual([...Array(sent * 10).keys()]);
    channel.port1.close();
  });

  it("stores snapshots and belief frames from the recorder in order with the batches, and reports a refusal", async () => {
    const profile = RECORDING_PRESETS["default-research"];
    const recorded = { ...header("run-000001"), recording: "stored" as const, recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) };
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const channel = new MessageChannel();
    const fromStorage: { type: string; code?: string; head?: { tick: number } }[] = [];
    channel.port1.onmessage = (ev) => fromStorage.push(ev.data as (typeof fromStorage)[number]);
    c.attachRecorderPort(channel.port2);
    await c.ports.runs.create(recorded);
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond(), what).toBe(true);
    };
    await until(() => fromStorage.some((m) => m.type === "header"), "header");
    const external = new Map<string, Uint8Array>();
    const w = new SnapshotWriter({ external: (h, b) => external.set(h, b) });
    const container = w.finish({ tick: 0, map: w.section({ chunk: Int8Array.from([1, 2, 3]) }) });
    const blobs = [...external].map(([id, bytes]) => ({ id, bytes }));
    const kf = blobs[0];
    if (!kf) throw new Error("a blob was expected");
    const post = (m: unknown) => channel.port1.postMessage(m);
    post({ type: "snapshot", runId: "run-000001", seq: 0, simTimeS: 0, tick: 0, bytes: container, blobs });
    post({
      type: "frames",
      runId: "run-000001",
      frames: [
        { agentId: "uav-001", seq: 0, tick: 0, simTime: 0, kind: "keyframe", chunks: [0], blobId: kf.id },
        { agentId: "uav-001", seq: 1, tick: 1, simTime: 0.1, kind: "delta", chunks: [0], data: Uint8Array.from([9]) },
      ],
      blobs: [],
    });
    post({ type: "batch", batch: { runId: "run-000001", records: [rec("run-000001", 0)], throughSeq: 0, tick: 1, simTimeS: 0.1 } });
    await until(() => fromStorage.some((m) => m.type === "persisted" && m.head?.tick === 1), "persisted head");
    // The head moved only after the items before the batch were stored.
    const infos = await c.ports.snapshots.list("run-000001");
    expect(infos).toHaveLength(1);
    expect((await c.ports.snapshots.read("run-000001", infos[0]?.id ?? ""))?.blobs).toEqual(blobs);
    expect((await c.ports.beliefFrames.query({ runId: "run-000001", limit: 10 })).map((f) => f.seq)).toEqual([0, 1]);
    // The same snapshot again (nothing ran since) is not a refusal; frames that name a blob that is not stored are.
    post({ type: "snapshot", runId: "run-000001", seq: 0, simTimeS: 0, tick: 0, bytes: container, blobs });
    post({ type: "frames", runId: "run-000001", frames: [{ agentId: "uav-001", seq: 2, tick: 2, simTime: 0.2, kind: "keyframe", chunks: [0], blobId: "f".repeat(32) }], blobs: [] });
    await until(() => fromStorage.some((m) => m.type === "rejected"), "refusal");
    expect(fromStorage.filter((m) => m.type === "rejected")).toHaveLength(1);
    expect(fromStorage.find((m) => m.type === "rejected")?.code).toBe("missing_blob");
    channel.port1.close();
  });

  it("does not tell a recorder about a run header that is not recorded", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const channel = new MessageChannel();
    const got: string[] = [];
    channel.port1.onmessage = (ev) => got.push((ev.data as { type: string }).type);
    c.attachRecorderPort(channel.port2);
    expect((await c.ports.runs.create({ ...header("run-000001"), recording: "none" as const })).ok).toBe(true);
    await c.ports.runs.get("run-000001");
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
    channel.port1.close();
  });

  it("rejects bad imports with stable codes and leaves the database untouched", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    const good = await c.admin.exportDb();

    const sqlite3 = await sqlite3InitModule();
    const craft = (sql: string): Uint8Array => {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const p = sqlite3.wasm.allocFromTypedArray(good);
      const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
      sqlite3.capi.sqlite3_deserialize(db, "main", p, good.byteLength, good.byteLength, flags);
      db.exec(sql);
      const out = sqlite3.capi.sqlite3_js_db_export(db);
      db.close();
      return out;
    };
    const corrupt = good.slice();
    corrupt.fill(0xff, 1024);

    const cases: [Uint8Array, string][] = [
      [new TextEncoder().encode("definitely not a database".padEnd(200, ".")), "not_sqlite"],
      [corrupt, "corrupt|integrity_failed"],
      [craft("CREATE TABLE evil (x)"), "unknown_tables"],
      [craft("CREATE TRIGGER t AFTER INSERT ON runs BEGIN DELETE FROM runs; END"), "unexpected_objects"],
      [craft("CREATE VIEW v AS SELECT 1"), "unexpected_objects"],
      [craft("INSERT INTO schema_migrations VALUES (99, 'future', 0)"), "unknown_schema_version"],
      [craft("INSERT INTO blobs (run_id, id, data) VALUES ('run-000001', '00000000000000000000000000000000', x'01')"), "broken_recording"],
      [
        craft(
          "INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000009', 0, 0, 'x', 'completed');" +
            "INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, kind, payload) VALUES ('run-000009', 0, 'a', 2, 0, 'event', '{}'), ('run-000009', 1, 'b', 1, 0, 'event', '{}')",
        ),
        "non_monotonic_trace",
      ],
    ];
    for (const [bytes, code] of cases) {
      const r = await c.admin.importDb(bytes);
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.error.code).toMatch(new RegExp(`^(${code})$`));
    }
    expect((await c.ports.runs.list()).map((x) => x.runId)).toEqual(["run-000001"]);
  });

  it("exports a single run as a standalone database", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.scenarios.saveVersion({ schemaVersion: 0, id: "alpha", name: "Alpha" });
    await c.ports.scenarios.saveVersion({ schemaVersion: 0, id: "alpha", name: "Alpha 2" });
    await c.ports.runs.create(header("run-000001"));
    await c.ports.runs.create({ ...header("run-000002"), scenarioId: "alpha", scenarioVersion: 2 });
    await c.ports.trace.append([rec("run-000001", 0), rec("run-000002", 0), rec("run-000002", 1)]);
    await c.ports.runs.appendInputs("run-000001", [{ inputId: "inp-000001", tick: 3, agentId: "ugv-001", name: "hold", params: {} }]);
    await c.ports.runs.appendInputs("run-000002", [{ inputId: "inp-000001", tick: 6, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } }]);
    const r = await c.admin.exportRun("run-000002");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    const p = sqlite3.wasm.allocFromTypedArray(r.value);
    sqlite3.capi.sqlite3_deserialize(db, "main", p, r.value.byteLength, r.value.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE);
    expect(db.selectValues("SELECT run_id FROM runs")).toEqual(["run-000002"]);
    expect(db.selectValue("SELECT count(*) FROM trace_records")).toBe(2);
    // The run's inputs travel with it, and only its own.
    expect(db.selectValues("SELECT run_id || ':' || input_id || ':' || name FROM run_inputs")).toEqual(["run-000002:inp-000001:goTo"]);
    // The scenario version the run used travels with it, and only that version.
    expect(db.selectValues("SELECT id || ':' || version FROM scenarios")).toEqual(["alpha:2"]);
    db.close();
    const missing = await c.admin.exportRun("run-000404");
    expect(missing.ok ? null : missing.error.code).toBe("unknown_run");
  });

  it("falls back to memory with a warning when OPFS is unavailable", async () => {
    const c = spawn({ simulateNoOpfs: true, lockName: "agentsim-db-fallback-test" });
    const s = await c.ready();
    expect(s.mode).toBe("memory-fallback");
    expect(s.warning).toMatch(/OPFS unavailable/);
    await c.ports.runs.create(header("run-000001"));
    expect((await c.admin.exportDb()).byteLength).toBeGreaterThan(0);
    expect((await c.admin.info()).mode).toBe("memory-fallback");
  });

  it("falls back to memory when the quota is below the threshold", async () => {
    const c = spawn({ quotaThresholdBytes: Number.MAX_SAFE_INTEGER, lockName: "agentsim-db-quota-test" });
    const s = await c.ready();
    expect(s.mode).toBe("memory-fallback");
    expect(s.warning).toMatch(/below the .* threshold/);
  });

  it("reports storage info", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const info = await c.admin.info();
    expect(info.mode).toBe("opfs-sahpool");
    expect(info.sqliteVersion).toBe("3.53.4");
    expect(info.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(info.dbFileBytes).toBeGreaterThan(0);
  });
});
