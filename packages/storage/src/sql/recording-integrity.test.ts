import { SnapshotWriter, contentHash128Bytes } from "@agentsim/core";
import { RECORDING_PRESETS, recordingProfileHash } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { migrate } from "./migrations.ts";
import { BELIEF_MANIFEST_FORMAT_STORED, firstRecordingProblem } from "./recording-integrity.ts";
import { createSqlPorts } from "./sql-storage.ts";

// The checks an import runs over the recording tables (the storage worker runs them on a file before it replaces the database).

const profile = RECORDING_PRESETS.minimal;

async function recordedRun() {
  const db = openNodeSqlDriver();
  migrate(db, () => 1);
  const p = createSqlPorts(db, () => 1);
  await p.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) });
  const external = new Map<string, Uint8Array>();
  const w = new SnapshotWriter({ external: (h, b) => external.set(h, b) });
  // A belief map is a manifest section naming group sections (ADR-0004 addition of 2026-10-18, second); the keyframe is the manifest.
  const group = w.section({ index: 0, chunks: [{ index: 0, logOdds: Int8Array.from([1, 2, 3]) }] });
  const manifest = w.section({ format: BELIEF_MANIFEST_FORMAT_STORED, groupChunks: 8, meta: {}, groups: [{ index: 0, hash: group.hash }] });
  const bytes = w.finish({ tick: 0, map: manifest });
  const blobs = [...external].map(([id, b]) => ({ id, bytes: b }));
  expect((await p.snapshots.write("run-000001", { seq: 0, simTime: 0, tick: 0, bytes, blobs })).ok).toBe(true);
  const kf = blobs.find((b) => b.id === manifest.hash);
  if (!kf) throw new Error("a blob was expected");
  const frames = [
    { agentId: "uav-001", seq: 0, tick: 0, simTime: 0, kind: "keyframe" as const, chunks: [0], blobId: kf.id },
    { agentId: "uav-001", seq: 1, tick: 5, simTime: 0.5, kind: "delta" as const, chunks: [0], data: Uint8Array.from([1]) },
  ];
  expect((await p.beliefFrames.append("run-000001", frames)).ok).toBe(true);
  return { db, blobId: kf.id, groupId: group.hash };
}

describe("recording integrity of a database", () => {
  it("finds nothing wrong in what the ports wrote", async () => {
    const { db } = await recordedRun();
    expect(firstRecordingProblem(db)).toBeUndefined();
    db.close();
  });

  it("finds a keyframe that is not a belief map manifest (a map stored whole, before chunk groups) and a manifest whose group is not stored", async () => {
    const whole = await recordedRun();
    // The keyframe's blob replaced by a whole map under its own content id.
    const old = await new Promise<Uint8Array>((resolve) => {
      const w = new SnapshotWriter({ external: (_h, b) => resolve(b) });
      w.section({ sizeX: 1, chunks: [] });
    });
    whole.db.exec("PRAGMA foreign_keys = OFF");
    whole.db.run("UPDATE blobs SET id = ?, data = ? WHERE id = ?", [contentHash128Bytes(old), old, whole.blobId]);
    whole.db.run("UPDATE belief_frames SET blob_id = ? WHERE blob_id = ?", [contentHash128Bytes(old), whole.blobId]);
    whole.db.run("DELETE FROM snapshots");
    expect(firstRecordingProblem(whole.db)).toMatch(/not a belief map manifest/);
    whole.db.close();
    const missing = await recordedRun();
    missing.db.exec("PRAGMA foreign_keys = OFF");
    missing.db.run("DELETE FROM snapshots");
    missing.db.run("DELETE FROM blobs WHERE id = ?", [missing.groupId]);
    expect(firstRecordingProblem(missing.db)).toMatch(/names a group section that is not stored/);
    missing.db.close();
  });

  it("finds a blob that does not match its id", async () => {
    const { db, blobId } = await recordedRun();
    db.run("UPDATE blobs SET data = x'00' WHERE id = ?", [blobId]);
    expect(firstRecordingProblem(db)).toMatch(/does not match its bytes/);
    db.close();
  });

  it("finds a snapshot that refers to a section that is not stored", async () => {
    const { db } = await recordedRun();
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM belief_frames");
    db.run("DELETE FROM blobs");
    expect(firstRecordingProblem(db)).toMatch(/refers to section .* not stored/);
    db.close();
  });

  it("finds a snapshot that is not what its id says, and one that does not open", async () => {
    const { db } = await recordedRun();
    const id = db.get<{ id: string }>("SELECT id FROM snapshots")?.id ?? "";
    db.run("UPDATE snapshots SET id = ? WHERE id = ?", [contentHash128Bytes(Uint8Array.from([9])), id]);
    expect(firstRecordingProblem(db)).toMatch(/content hash/);
    db.run("UPDATE snapshots SET data = x'0102'");
    expect(firstRecordingProblem(db)).toMatch(/does not open/);
    db.close();
  });

  it("finds a frame whose blob is missing and frames that go back in time", async () => {
    const { db } = await recordedRun();
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("UPDATE belief_frames SET tick = -1 WHERE seq = 1");
    expect(firstRecordingProblem(db)).toMatch(/go back in time/);
    db.run("UPDATE belief_frames SET tick = 5 WHERE seq = 1");
    db.run("UPDATE belief_frames SET blob_id = ? WHERE seq = 0", ["f".repeat(32)]);
    expect(firstRecordingProblem(db)).toMatch(/refers to a blob that is not stored/);
    db.close();
  });

  it("finds a recording header that does not agree with its profile", async () => {
    const { db } = await recordedRun();
    db.run("UPDATE runs SET recording_profile_hash = '00000000'");
    expect(firstRecordingProblem(db)).toMatch(/not the hash/);
    db.run("UPDATE runs SET recording = 'none'");
    expect(firstRecordingProblem(db)).toMatch(/only a stored run/);
    db.run("UPDATE runs SET recording = 'stored', recording_profile = '{}'");
    expect(firstRecordingProblem(db)).toMatch(/valid recording profile/);
    db.close();
  });
});
