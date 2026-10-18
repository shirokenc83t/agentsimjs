import { contentHash128Bytes, readSnapshot, SnapshotWriter, snapshotHash } from "@agentsim/core";
import { RECORDING_PRESETS, recordingProfileHash, type RunHeader } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { BeliefFrame, StoragePorts, StoredBlob } from "../ports.ts";

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
}
