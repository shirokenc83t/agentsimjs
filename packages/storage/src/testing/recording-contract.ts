import { contentHash128Bytes, readSnapshot, SnapshotWriter, snapshotHash } from "@agentsim/core";
import { RECORDING_PRESETS, recordingProfileHash, type RunHeader } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { BeliefFrame, StoragePorts, StoredBlob, StoredMetricSample } from "../ports.ts";

/** The recording ports and header fields (ADR-0004 additions of 2026-10-17 and 2026-10-18, ADR-0035 items 6, 8 and 9), for every adapter. */

const RUN = "run-000001";
const header = (runId: string, extra: Partial<RunHeader> = {}): RunHeader => ({ runId, schemaVersion: 0, createdAtWallMs: 1_700_000_000_000, label: `label ${runId}`, status: "running", ...extra });

const profile = RECORDING_PRESETS["default-research"];
const stored = (extra: Partial<RunHeader> = {}): RunHeader =>
  header(RUN, { recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile), ...extra });

const blobOf = (...bytes: number[]): StoredBlob => {
  const b = Uint8Array.from(bytes);
  return { id: contentHash128Bytes(b), bytes: b };
};

/** A container whose "belief" sections live outside it, and what the same snapshot is with them inside. */
function snapshotWith(tick: number, sections: readonly number[]): { bytes: Uint8Array; blobs: StoredBlob[]; inline: Uint8Array } {
  const root = (w: SnapshotWriter) => w.finish({ tick, maps: sections.map((n) => w.section({ chunk: Int8Array.from([n, n + 1, n + 2]), version: n })) });
  const external = new Map<string, Uint8Array>();
  const ow = new SnapshotWriter({ external: (hash, bytes) => external.set(hash, bytes) });
  return {
    bytes: root(ow),
    blobs: [...external].map(([id, bytes]) => ({ id, bytes })),
    inline: root(new SnapshotWriter()),
  };
}

const frame = (agentId: string, seq: number, tick: number, extra: Partial<BeliefFrame> = {}): BeliefFrame => ({
  agentId, seq, tick, simTime: tick * 0.1, kind: "delta", chunks: [seq, seq + 4], data: Uint8Array.from([seq, tick]), ...extra,
});

const sample = (source: string, name: string, tick: number, value: number): StoredMetricSample => ({ source, name, tick, simTime: tick * 0.1, value });

export function describeRecordingContract(getPorts: () => StoragePorts): void {
  const code = <T>(r: { ok: boolean; error?: { code: string } } & T): string | null => (r.ok ? null : (r.error?.code ?? "?"));

  describe("recording: run header", () => {
    it("stores the recording state and the resolved profile with its hash, and returns them as they were", async () => {
      const p = getPorts();
      expect((await p.runs.create(stored())).ok).toBe(true);
      expect(await p.runs.get(RUN)).toEqual(stored());
      expect((await p.runs.create(header("run-000002", { recording: "none" }))).ok).toBe(true);
      expect(await p.runs.get("run-000002")).toEqual(header("run-000002", { recording: "none" }));
      expect((await p.runs.create(header("run-000003"))).ok).toBe(true); // a run without the fields, as before recording existed
      expect((await p.runs.list()).map((r) => [r.runId, r.recording ?? null, r.recordingProfileHash ?? null])).toEqual([
        [RUN, "stored", recordingProfileHash(profile)],
        ["run-000002", "none", null],
        ["run-000003", null, null],
      ]);
    });

    it("refuses a stored run without its profile or hash, with a hash that is not the profile's, or with a profile that is not one", async () => {
      const p = getPorts();
      const { recordingProfile: _p, ...noProfile } = stored();
      const { recordingProfileHash: _h, ...noHash } = stored();
      for (const bad of [
        noProfile,
        noHash,
        stored({ recordingProfileHash: "00000000" }),
        stored({ recordingProfile: { ...profile, name: "" } }),
        stored({ recordingProfile: { schemaVersion: 0 } }),
        stored({ recordingProfile: "default-research" }),
        header(RUN, { recording: "stored" }),
      ]) {
        expect(code(await p.runs.create(bad as RunHeader)), JSON.stringify(bad).slice(0, 80)).toBe("invalid_header");
      }
      expect(await p.runs.list()).toEqual([]);
    });

    it("refuses profile fields on a run that is not recorded, or on one that says nothing about recording", async () => {
      const p = getPorts();
      expect(code(await p.runs.create(header(RUN, { recording: "none", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) })))).toBe("invalid_header");
      expect(code(await p.runs.create(header(RUN, { recordingProfileHash: recordingProfileHash(profile) })))).toBe("invalid_header");
      expect(code(await p.runs.create(header(RUN, { recording: "maybe" as never })))).toBe("invalid_header");
    });
  });

  describe("recording: blobs", () => {
    it("stores a blob once per run under its content id and reads it back exactly", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      await p.runs.create(header("run-000002", { recording: "none" }));
      const a = blobOf(1, 2, 3);
      expect((await p.snapshots.putBlobs(RUN, [a, blobOf(255, 0, 7)])).ok).toBe(true);
      expect((await p.snapshots.putBlobs(RUN, [a])).ok).toBe(true); // idempotent
      expect(await p.snapshots.getBlob(RUN, a.id)).toEqual(a);
      expect(await p.snapshots.getBlob(RUN, "0".repeat(32))).toBeUndefined();
      expect(await p.snapshots.getBlob("run-000002", a.id)).toBeUndefined(); // blobs belong to a run
      expect(await p.snapshots.getBlob("run-000009", a.id)).toBeUndefined();
    });

    it("refuses a blob that is not what its id says, an invalid id and an unknown run, all or nothing", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const good = blobOf(9, 9);
      const lie = { id: blobOf(1).id, bytes: Uint8Array.from([2]) };
      expect(code(await p.snapshots.putBlobs(RUN, [good, lie]))).toBe("invalid_blob");
      expect(await p.snapshots.getBlob(RUN, good.id)).toBeUndefined(); // the good one was not kept
      expect(code(await p.snapshots.putBlobs(RUN, [{ id: "xyz", bytes: Uint8Array.from([1]) }]))).toBe("invalid_blob");
      expect(code(await p.snapshots.putBlobs("run-000009", [good]))).toBe("unknown_run");
    });
  });

  describe("recording: snapshots", () => {
    it("stores a container whose sections are blobs, under the snapshot's content hash, and reads it back with its blobs", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const s = snapshotWith(600, [1, 2]);
      expect(s.blobs).toHaveLength(2);
      const w = await p.snapshots.write(RUN, { seq: 41, simTime: 60, tick: 600, bytes: s.bytes, blobs: s.blobs });
      expect(w).toEqual({ ok: true, value: { id: snapshotHash(s.bytes) } });
      // The same snapshot with its sections inline has the same id: where the sections live does not change it.
      expect(snapshotHash(s.inline)).toBe(snapshotHash(s.bytes));
      const loaded = await p.snapshots.read(RUN, snapshotHash(s.bytes));
      expect(loaded?.container).toEqual(s.bytes);
      expect([loaded?.seq, loaded?.simTime, loaded?.tick, loaded?.bytes]).toEqual([41, 60, 600, s.bytes.length]);
      expect([...(loaded?.blobs ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([...s.blobs].sort((a, b) => (a.id < b.id ? -1 : 1)));
      const byId = new Map((loaded?.blobs ?? []).map((b) => [b.id, b.bytes]));
      const opened = readSnapshot(loaded?.container ?? new Uint8Array(), { resolve: (h) => byId.get(h) });
      expect(opened.sections.map((x) => x.bytes)).toEqual([undefined, undefined]);
      expect(await p.snapshots.read(RUN, "0".repeat(32))).toBeUndefined();
    });

    it("lists snapshots in tick order, shares a blob between snapshots, and takes blobs stored earlier", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const early = snapshotWith(0, [1]);
      const late = snapshotWith(1200, [1, 5]); // shares the section of 1 with the first
      const shared = early.blobs[0] as StoredBlob;
      expect(late.blobs.map((b) => b.id)).toContain(shared.id);
      expect((await p.snapshots.write(RUN, { seq: 90, simTime: 120, tick: 1200, bytes: late.bytes, blobs: late.blobs })).ok).toBe(true);
      await p.snapshots.putBlobs(RUN, early.blobs);
      expect((await p.snapshots.write(RUN, { seq: 1, simTime: 0, tick: 0, bytes: early.bytes })).ok).toBe(true); // blob stored before: none given
      const list = await p.snapshots.list(RUN);
      expect(list.map((s) => [s.tick, s.seq, s.simTime, s.id])).toEqual([
        [0, 1, 0, snapshotHash(early.bytes)],
        [1200, 90, 120, snapshotHash(late.bytes)],
      ]);
      expect(list.map((s) => s.bytes)).toEqual([early.bytes.length, late.bytes.length]);
      expect(await p.snapshots.list("run-000009")).toEqual([]);
    });

    it("accepts a snapshot with all its sections inline", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const s = snapshotWith(5, [3]);
      expect((await p.snapshots.write(RUN, { seq: 2, simTime: 0.5, tick: 5, bytes: s.inline })).ok).toBe(true);
      expect((await p.snapshots.read(RUN, snapshotHash(s.inline)))?.blobs).toEqual([]);
    });

    it("refuses a snapshot whose sections are not stored, storing nothing of it", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const s = snapshotWith(600, [1, 2]);
      const [first] = s.blobs;
      expect(code(await p.snapshots.write(RUN, { seq: 1, simTime: 60, tick: 600, bytes: s.bytes, blobs: first ? [first] : [] }))).toBe("missing_blob");
      expect(await p.snapshots.list(RUN)).toEqual([]);
      expect(first && (await p.snapshots.getBlob(RUN, first.id))).toBeFalsy(); // the blob given with the refused snapshot was not kept
    });

    it("refuses a duplicate, a container that does not open, bad numbers, a bad blob and an unknown run", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const s = snapshotWith(600, [1]);
      const at = { seq: 1, simTime: 60, tick: 600 };
      expect((await p.snapshots.write(RUN, { ...at, bytes: s.bytes, blobs: s.blobs })).ok).toBe(true);
      expect(code(await p.snapshots.write(RUN, { ...at, bytes: s.bytes, blobs: s.blobs }))).toBe("duplicate_snapshot");
      expect(code(await p.snapshots.write(RUN, { ...at, bytes: Uint8Array.from([1, 2, 3]) }))).toBe("invalid_snapshot");
      const other = snapshotWith(601, [2]);
      expect(code(await p.snapshots.write(RUN, { ...at, tick: -1, bytes: other.bytes, blobs: other.blobs }))).toBe("invalid_snapshot");
      expect(code(await p.snapshots.write(RUN, { ...at, bytes: other.bytes, blobs: [{ id: other.blobs[0]?.id ?? "", bytes: Uint8Array.from([9]) }] }))).toBe("invalid_blob");
      expect(code(await p.snapshots.write("run-000009", { ...at, bytes: other.bytes, blobs: other.blobs }))).toBe("unknown_run");
      expect(await p.snapshots.list(RUN)).toHaveLength(1);
    });
  });

  describe("recording: belief frames", () => {
    it("appends keyframes (as blobs) and deltas (inline) and returns them in agent and seq order, exactly", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const kf = blobOf(7, 7, 7);
      await p.snapshots.putBlobs(RUN, [kf]);
      const frames = [
        frame("uav-002", 0, 0, { kind: "keyframe", chunks: [0, 1, 2], data: undefined as never, blobId: kf.id }),
        frame("uav-001", 1, 5),
        frame("uav-001", 0, 0, { kind: "keyframe", chunks: [3], blobId: kf.id, data: undefined as never }),
        frame("uav-001", 2, 9, { chunks: [] }),
      ].map((f) => (f.data === undefined ? ((): BeliefFrame => { const { data: _d, ...rest } = f; return rest; })() : f));
      expect((await p.beliefFrames.append(RUN, frames)).ok).toBe(true);
      const all = await p.beliefFrames.query({ runId: RUN, limit: 100 });
      expect(all.map((f) => `${f.agentId}#${f.seq}`)).toEqual(["uav-001#0", "uav-001#1", "uav-001#2", "uav-002#0"]);
      expect(all[1]).toEqual(frame("uav-001", 1, 5));
      expect(all[0]).toMatchObject({ kind: "keyframe", chunks: [3], blobId: kf.id });
      expect("data" in (all[0] ?? {})).toBe(false);
      expect(all[2]?.chunks).toEqual([]);
      expect((await p.snapshots.getBlob(RUN, kf.id))?.bytes).toEqual(kf.bytes);
    });

    it("filters by agent, tick window and kind, and finds the keyframe a rebuild starts from", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const k1 = blobOf(1);
      const k2 = blobOf(2);
      await p.snapshots.putBlobs(RUN, [k1, k2]);
      const key = (seq: number, tick: number, blobId: string): BeliefFrame => {
        const { data: _d, ...rest } = frame("uav-001", seq, tick, { kind: "keyframe", chunks: [0], blobId });
        return rest;
      };
      await p.beliefFrames.append(RUN, [key(0, 0, k1.id), frame("uav-001", 1, 10), frame("uav-001", 2, 20), key(3, 30, k2.id), frame("uav-001", 4, 40), frame("uav-002", 0, 15)]);
      const seqs = async (q: Partial<Parameters<typeof p.beliefFrames.query>[0]>) => (await p.beliefFrames.query({ runId: RUN, limit: 100, ...q })).map((f) => `${f.agentId}#${f.seq}`);
      expect(await seqs({ agentId: "uav-001", fromTick: 10, toTick: 30 })).toEqual(["uav-001#1", "uav-001#2", "uav-001#3"]);
      expect(await seqs({ agentId: "uav-001", kind: "keyframe" })).toEqual(["uav-001#0", "uav-001#3"]);
      expect(await seqs({ fromTick: 15, toTick: 15 })).toEqual(["uav-002#0"]);
      expect(await seqs({ limit: 2 })).toEqual(["uav-001#0", "uav-001#1"]);
      expect(await seqs({ runId: "run-000009" })).toEqual([]);
      expect((await p.beliefFrames.keyframeAtOrBefore(RUN, "uav-001", 29))?.blobId).toBe(k1.id);
      expect((await p.beliefFrames.keyframeAtOrBefore(RUN, "uav-001", 30))?.blobId).toBe(k2.id);
      expect((await p.beliefFrames.keyframeAtOrBefore(RUN, "uav-001", 1000))?.seq).toBe(3);
      expect(await p.beliefFrames.keyframeAtOrBefore(RUN, "uav-002", 100)).toBeUndefined();
      expect(await p.beliefFrames.keyframeAtOrBefore(RUN, "uav-009", 100)).toBeUndefined();
    });

    it("refuses what is not a frame, a blob that is not stored, a repeated frame and frames out of tick order, all or nothing", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      await p.beliefFrames.append(RUN, [frame("uav-001", 0, 10)]);
      const count = async () => (await p.beliefFrames.query({ runId: RUN, limit: 100 })).length;
      const { data: _d, ...noBytes } = frame("uav-001", 1, 11);
      const cases: [string, unknown[], string][] = [
        ["no bytes and no blob", [noBytes], "invalid_frame"],
        ["bytes and a blob", [frame("uav-001", 1, 11, { blobId: "0".repeat(32) })], "invalid_frame"],
        ["chunks not ascending", [frame("uav-001", 1, 11, { chunks: [4, 2] })], "invalid_frame"],
        ["negative chunk", [frame("uav-001", 1, 11, { chunks: [-1] })], "invalid_frame"],
        ["bad agent id", [frame("UAV 1", 1, 11)], "invalid_frame"],
        ["bad kind", [frame("uav-001", 1, 11, { kind: "full" as never })], "invalid_frame"],
        ["the same frame twice in a batch", [frame("uav-001", 1, 11), frame("uav-001", 1, 12)], "invalid_frame"],
        ["a blob that is not stored", [{ ...noBytes, kind: "keyframe", blobId: "f".repeat(32) }], "missing_blob"],
        ["a frame already stored", [frame("uav-001", 0, 10)], "duplicate_frame"],
        ["a tick before the last stored", [frame("uav-001", 1, 9)], "non_monotonic_frame"],
        ["ticks going back inside a batch", [frame("uav-001", 1, 20), frame("uav-001", 2, 19)], "non_monotonic_frame"],
      ];
      for (const [name, batch, expected] of cases) expect(code(await p.beliefFrames.append(RUN, batch as BeliefFrame[])), name).toBe(expected);
      expect(code(await p.beliefFrames.append(RUN, [frame("uav-001", 1, 11), frame("uav-001", 0, 12)]))).toBe("duplicate_frame"); // the good one is not kept
      expect(await count()).toBe(1);
      expect(code(await p.beliefFrames.append("run-000009", [frame("uav-001", 5, 50)]))).toBe("unknown_run");
      // Another agent has its own order.
      expect((await p.beliefFrames.append(RUN, [frame("uav-002", 0, 1)])).ok).toBe(true);
    });
  });

  describe("recording: metrics", () => {
    it("appends samples of registered series and returns them in series and tick order, exactly", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const list = [
        sample("world/sim", "sim.tickMs", 20, 1.5),
        sample("uav-001/body", "agent.soc", 10, 0.9),
        sample("world/sim", "sim.tickMs", 10, 1.25),
        sample("uav-001/body", "agent.soc", 20, 0.8),
      ];
      expect((await p.metrics.append(RUN, list)).ok).toBe(true);
      expect(await p.metrics.query({ runId: RUN, limit: 100 })).toEqual([
        sample("uav-001/body", "agent.soc", 10, 0.9),
        sample("uav-001/body", "agent.soc", 20, 0.8),
        sample("world/sim", "sim.tickMs", 10, 1.25),
        sample("world/sim", "sim.tickMs", 20, 1.5),
      ]);
      expect((await p.metrics.append(RUN, [sample("world/sim", "sim.tickMs", 30, 2)])).ok).toBe(true); // a later batch continues the series
    });

    it("filters by source, name and sim-time window, limits, and pages with a cursor", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      const all: StoredMetricSample[] = [];
      for (let t = 10; t <= 50; t += 10) all.push(sample("world/sim", "sim.tickMs", t, t), sample("world/sim", "sim.senseMs", t, t / 2), sample("ugv-001/body", "agent.soc", t, 1 - t / 100));
      await p.metrics.append(RUN, all);
      expect((await p.metrics.query({ runId: RUN, name: "agent.soc", limit: 100 })).length).toBe(5);
      expect((await p.metrics.query({ runId: RUN, source: "world/sim", limit: 100 })).length).toBe(10);
      expect((await p.metrics.query({ runId: RUN, source: "world/sim", name: "sim.tickMs", fromS: 2, toS: 4, limit: 100 })).map((s) => s.tick)).toEqual([20, 30, 40]);
      expect((await p.metrics.query({ runId: RUN, limit: 4 })).length).toBe(4);
      const seen: StoredMetricSample[] = [];
      for (let after: StoredMetricSample | undefined; ; ) {
        const page = await p.metrics.query({ runId: RUN, ...(after === undefined ? {} : { after: { source: after.source, name: after.name, tick: after.tick } }), limit: 4 });
        seen.push(...page);
        if (page.length < 4) break;
        after = page[page.length - 1];
      }
      expect(seen).toEqual(await p.metrics.query({ runId: RUN, limit: 100 }));
      expect(seen.length).toBe(15);
      expect(await p.metrics.query({ runId: "run-000404", limit: 10 })).toEqual([]);
    });

    it("refuses an unregistered name, a source that is not the series', bad numbers, a repeat and samples out of tick order, all or nothing", async () => {
      const p = getPorts();
      await p.runs.create(stored());
      expect((await p.metrics.append(RUN, [sample("world/sim", "sim.tickMs", 10, 1)])).ok).toBe(true);
      const cases: [string, StoredMetricSample[], string][] = [
        ["unregistered name", [sample("world/sim", "sim.madeUp", 11, 1)], "invalid_metric"],
        ["source of another component", [sample("uav-001/planner", "agent.soc", 11, 1)], "invalid_metric"],
        ["world source for an agent series", [sample("world/sim", "agent.soc", 11, 1)], "invalid_metric"],
        ["invalid source", [sample("not a source", "sim.tickMs", 11, 1)], "invalid_metric"],
        ["NaN value", [sample("world/sim", "sim.tickMs", 11, Number.NaN)], "invalid_metric"],
        ["fractional tick", [sample("world/sim", "sim.tickMs", 11.5, 1)], "invalid_metric"],
        ["negative sim time", [{ ...sample("world/sim", "sim.tickMs", 11, 1), simTime: -1 }], "invalid_metric"],
        ["twice in the batch", [sample("world/sim", "sim.tickMs", 12, 1), sample("world/sim", "sim.tickMs", 12, 2)], "invalid_metric"],
        ["already stored", [sample("world/sim", "sim.tickMs", 10, 5)], "duplicate_metric"],
        ["before the last stored tick of its series", [sample("world/sim", "sim.tickMs", 5, 5)], "non_monotonic_metric"],
        ["sim time going backwards inside the batch", [sample("world/sim", "sim.tickMs", 20, 1), { ...sample("world/sim", "sim.tickMs", 21, 1), simTime: 0.5 }], "non_monotonic_metric"],
      ];
      for (const [what, list, expected] of cases) {
        expect(code(await p.metrics.append(RUN, [sample("world/sim", "sim.senseMs", 99, 1), ...list])), what).toBe(expected);
      }
      expect(code(await p.metrics.append("run-000404", [sample("world/sim", "sim.tickMs", 1, 1)]))).toBe("unknown_run");
      // Nothing of a refused batch was stored.
      expect((await p.metrics.query({ runId: RUN, limit: 100 })).map((s) => `${s.name}@${s.tick}`)).toEqual(["sim.tickMs@10"]);
    });
  });

  describe("recording: sizes and deleting a run", () => {
    /** A run with everything a recorded run owns: records and causes, inputs, a snapshot with its blobs, belief frames. */
    async function fullRun(p: StoragePorts, runId: string) {
      await p.runs.create({ ...stored(), runId, label: runId });
      await p.trace.append([
        { id: `${runId}#0`, runId, seq: 0, simTime: 0, wallTime: 1, source: "world/sim", kind: "event", payload: { op: "x", pad: "y".repeat(100) } },
        { id: `${runId}#1`, runId, seq: 1, simTime: 0.1, wallTime: 1, source: "world/sim", kind: "event", causeIds: [`${runId}#0`], payload: { op: "z" } },
      ]);
      await p.runs.appendInputs(runId, [{ inputId: "inp-000001", tick: 3, agentId: "ugv-001", name: "goTo", params: { xM: 1, yM: 2 } }]);
      const s = snapshotWith(0, [1, 2]);
      await p.snapshots.write(runId, { seq: 0, simTime: 0, tick: 0, bytes: s.bytes, blobs: s.blobs });
      const kf = s.blobs[0] as StoredBlob;
      const { data: _d, ...kfFrame } = frame("uav-001", 0, 0, { kind: "keyframe", chunks: [0], blobId: kf.id });
      await p.beliefFrames.append(runId, [kfFrame, frame("uav-001", 1, 1, { data: new Uint8Array(40) })]);
      await p.metrics.append(runId, [sample("world/sim", "sim.tickMs", 10, 1), sample("world/sim", "sim.tickMs", 20, 2), sample("uav-001/body", "agent.soc", 10, 0.5)]);
      return { snapshot: s, kf };
    }

    it("reports what a run holds: records, blobs, snapshots and belief frames, with counts and bytes", async () => {
      const p = getPorts();
      await p.runs.create(header("run-000009"));
      expect(await p.runs.sizes("run-000009")).toEqual({ records: { count: 0, bytes: 0 }, blobs: { count: 0, bytes: 0 }, snapshots: { count: 0, bytes: 0 }, beliefFrames: { count: 0, bytes: 0 }, metrics: { count: 0, bytes: 0 } });
      const { snapshot } = await fullRun(p, RUN);
      const sz = await p.runs.sizes(RUN);
      expect(sz?.records.count).toBe(2);
      expect(sz?.records.bytes).toBeGreaterThan(100);
      expect(sz?.blobs).toEqual({ count: snapshot.blobs.length, bytes: snapshot.blobs.reduce((n, b) => n + b.bytes.length, 0) });
      expect(sz?.snapshots).toEqual({ count: 1, bytes: snapshot.bytes.length });
      expect(sz?.beliefFrames.count).toBe(2);
      expect(sz?.beliefFrames.bytes).toBeGreaterThanOrEqual(40);
      expect(sz?.metrics.count).toBe(3);
      expect(sz?.metrics.bytes).toBeGreaterThan(0);
      expect(await p.runs.sizes("run-000404")).toBeUndefined();
    });

    it("deletes a run and everything it owns, and nothing of another run", async () => {
      const p = getPorts();
      await fullRun(p, RUN);
      const other = await fullRun(p, "run-000002"); // the later run is the one being recorded (a storage worker refuses to delete that one)
      expect((await p.runs.delete(RUN)).ok).toBe(true);
      expect(await p.runs.get(RUN)).toBeUndefined();
      expect((await p.runs.list()).map((r) => r.runId)).toEqual(["run-000002"]);
      expect(await p.trace.count(RUN)).toBe(0);
      expect(await p.trace.query({ runId: RUN, limit: 10 })).toEqual([]);
      expect(await p.runs.inputs(RUN)).toEqual([]);
      expect(await p.snapshots.list(RUN)).toEqual([]);
      expect(await p.snapshots.getBlob(RUN, other.kf.id)).toBeUndefined();
      expect(await p.beliefFrames.query({ runId: RUN, limit: 10 })).toEqual([]);
      expect(await p.metrics.query({ runId: RUN, limit: 10 })).toEqual([]);
      expect(await p.runs.sizes(RUN)).toBeUndefined();
      // The other run is whole.
      expect(await p.trace.count("run-000002")).toBe(2);
      expect((await p.snapshots.list("run-000002")).length).toBe(1);
      expect((await p.beliefFrames.query({ runId: "run-000002", limit: 10 })).length).toBe(2);
      expect((await p.metrics.query({ runId: "run-000002", limit: 10 })).length).toBe(3);
      expect((await p.snapshots.getBlob("run-000002", other.kf.id))?.bytes).toEqual(other.kf.bytes);
      // A deleted run's id is not reused: the next run gets a new one.
      expect(await p.runs.allocateRunId()).toBe("run-000003");
    });

    it("refuses an unknown run, and a deleted run can be deleted no more", async () => {
      const p = getPorts();
      const unknown = await p.runs.delete("run-000404");
      expect(unknown.ok ? null : unknown.error.code).toBe("unknown_run");
      await p.runs.create(header(RUN));
      expect((await p.runs.delete(RUN)).ok).toBe(true);
      const again = await p.runs.delete(RUN);
      expect(again.ok ? null : again.error.code).toBe("unknown_run");
      // The deleted run's ID is not handed out again, even though no stored run holds it.
      expect(await p.runs.allocateRunId()).toBe("run-000002");
    });
  });
}
