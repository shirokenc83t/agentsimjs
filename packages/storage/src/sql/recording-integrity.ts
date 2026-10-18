import { contentHash128Bytes, decodeValue, readSnapshot, snapshotHash } from "@agentsim/core";
import { parseRecordingProfile, recordingProfileHash } from "@agentsim/trace";
import type { SqlDriver } from "./driver.ts";

/** The format name of a belief map manifest, as the spatial package writes it (BELIEF_MANIFEST_FORMAT; a lab test pins that they agree). */
export const BELIEF_MANIFEST_FORMAT_STORED = "agentsim-belief-groups-1";

/**
 * What an imported database must hold for the recording to be usable (ADR-0035 addition of 2026-10-17, items 2, 8 and 9): every
 * blob is what its id says, every snapshot opens and finds the sections it refers to, every frame finds its blob and keeps
 * tick order, and a run's recording header agrees with its profile. Returns the first problem, or undefined. A database written
 * through the ports satisfies all of it; a file from elsewhere may not.
 */
export function firstRecordingProblem(db: SqlDriver): string | undefined {
  for (const r of db.all<{ run_id: string; id: string; data: Uint8Array }>("SELECT run_id, id, data FROM blobs")) {
    if (contentHash128Bytes(new Uint8Array(r.data)) !== r.id) return `run ${r.run_id}: blob ${r.id} does not match its bytes`;
  }
  const hasBlob = (runId: string, id: string) => db.get("SELECT 1 AS x FROM blobs WHERE run_id = ? AND id = ?", [runId, id]) !== undefined;
  for (const r of db.all<{ run_id: string; id: string; data: Uint8Array }>("SELECT run_id, id, data FROM snapshots")) {
    try {
      const bytes = new Uint8Array(r.data);
      if (snapshotHash(bytes) !== r.id) return `run ${r.run_id}: snapshot ${r.id} does not match its content hash`;
      for (const s of readSnapshot(bytes).sections) {
        if (s.bytes === undefined && !hasBlob(r.run_id, s.hash)) return `run ${r.run_id}: snapshot ${r.id} refers to section ${s.hash}, which is not stored`;
      }
    } catch (e) {
      return `run ${r.run_id}: snapshot ${r.id} does not open: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const dangling = db.get<{ run_id: string; agent_id: string; seq: number }>(
    "SELECT f.run_id, f.agent_id, f.seq FROM belief_frames f WHERE f.blob_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.run_id = f.run_id AND b.id = f.blob_id) LIMIT 1",
  );
  if (dangling) return `run ${dangling.run_id}: belief frame ${dangling.agent_id}#${dangling.seq} refers to a blob that is not stored`;
  // A keyframe is a belief map manifest, and every group section it names is a stored blob (ADR-0004 addition of 2026-10-18, second).
  for (const r of db.all<{ run_id: string; agent_id: string; seq: number; data: Uint8Array }>(
    "SELECT f.run_id, f.agent_id, f.seq, b.data FROM belief_frames f JOIN blobs b ON b.run_id = f.run_id AND b.id = f.blob_id WHERE f.kind = 'keyframe'",
  )) {
    const where = `run ${r.run_id}: keyframe ${r.agent_id}#${r.seq}`;
    let manifest: { format?: unknown; groups?: unknown };
    try {
      manifest = decodeValue(new Uint8Array(r.data)) as typeof manifest;
    } catch (e) {
      return `${where} does not open: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (manifest?.format !== BELIEF_MANIFEST_FORMAT_STORED || !Array.isArray(manifest.groups)) return `${where} is not a belief map manifest (recorded before keyframes were chunk groups)`;
    for (const g of manifest.groups as { hash?: unknown }[]) {
      if (typeof g?.hash !== "string" || !hasBlob(r.run_id, g.hash)) return `${where} names a group section that is not stored`;
    }
  }
  const backwards = db.get<{ run_id: string; agent_id: string; seq: number }>(
    `SELECT run_id, agent_id, seq FROM (SELECT run_id, agent_id, seq, tick, lag(tick) OVER (PARTITION BY run_id, agent_id ORDER BY seq) AS prev FROM belief_frames)
     WHERE tick < prev LIMIT 1`,
  );
  if (backwards) return `run ${backwards.run_id}: belief frames of ${backwards.agent_id} go back in time at seq ${backwards.seq}`;
  for (const r of db.all<{ run_id: string; recording: string | null; recording_profile: string | null; recording_profile_hash: string | null }>(
    "SELECT run_id, recording, recording_profile, recording_profile_hash FROM runs",
  )) {
    if (r.recording === "stored") {
      const parsed = r.recording_profile === null ? undefined : parseRecordingProfile(r.recording_profile);
      if (!parsed?.ok) return `run ${r.run_id}: a stored run needs a valid recording profile`;
      if (recordingProfileHash(parsed.value) !== r.recording_profile_hash) return `run ${r.run_id}: recordingProfileHash is not the hash of its profile`;
    } else if (r.recording_profile !== null || r.recording_profile_hash !== null) {
      return `run ${r.run_id}: only a stored run has a recording profile`;
    }
  }
  return undefined;
}
