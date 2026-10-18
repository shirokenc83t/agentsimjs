import { contentHash128Bytes, err, ok, readSnapshot, snapshotHash, type CodedError, type Result } from "@agentsim/core";
import { parseRecordingProfile, recordingProfileHash, type RunHeader } from "@agentsim/trace";
import type { BeliefFrame, BeliefFrameQuery, SnapshotWrite, StoredBlob } from "./ports.ts";

// What the recording ports accept (ADR-0035 addition of 2026-10-17, items 6, 8 and 9; ADR-0004 addition of 2026-10-18): checks shared by
// every adapter, so that all of them refuse the same inputs with the same codes.

export const RECORDING_LIMITS = {
  /** One blob: a snapshot section or a belief keyframe (a fully materialized 1 km² map is about 16 MiB). */
  maxBlobBytes: 64 * 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxFrameBytes: 16 * 1024 * 1024,
  maxFrameChunks: 1_000_000,
  maxFramesPerAppend: 10_000,
  maxFrameQueryLimit: 10_000,
} as const;

const HASH = /^[0-9a-f]{32}$/;
const AGENT = /^[a-z][a-z0-9-]{0,63}$/;

/** The recording fields of a run header: `stored` carries a valid profile and its hash; `none` and absent carry neither. */
export function checkRunRecording(h: RunHeader): Result<void, CodedError<"invalid_header">> {
  const bad = (message: string) => err({ code: "invalid_header" as const, message });
  if (h.recording === "stored") {
    if (h.recordingProfile === undefined || h.recordingProfileHash === undefined) return bad("a stored run records its recording profile and its hash");
    // Through the trace package's strict parser, so the header and the profile library agree on what a profile is.
    const parsed = parseRecordingProfile(JSON.stringify(h.recordingProfile));
    if (!parsed.ok) return bad("the recording profile of the run is not a valid profile");
    if (recordingProfileHash(parsed.value) !== h.recordingProfileHash) return bad("recordingProfileHash is not the hash of the recording profile");
    return ok(undefined);
  }
  if (h.recordingProfile !== undefined || h.recordingProfileHash !== undefined) return bad("only a stored run has a recording profile");
  return ok(undefined);
}

/** A blob is named by the 128-bit content hash of its bytes and must carry that name. */
export function checkBlobs(blobs: readonly StoredBlob[]): Result<void, CodedError<"invalid_blob">> {
  for (const b of blobs) {
    if (!(b.bytes instanceof Uint8Array) || !HASH.test(b.id)) return err({ code: "invalid_blob", message: `invalid blob ${String(b.id).slice(0, 40)}` });
    if (b.bytes.length > RECORDING_LIMITS.maxBlobBytes) return err({ code: "invalid_blob", message: `blob ${b.id} is larger than ${RECORDING_LIMITS.maxBlobBytes} bytes` });
    if (contentHash128Bytes(b.bytes) !== b.id) return err({ code: "invalid_blob", message: `blob ${b.id} does not match its bytes` });
  }
  return ok(undefined);
}

export interface CheckedSnapshot {
  /** The snapshot's content hash, its id. */
  readonly id: string;
  /** Hashes of the sections the container refers to without holding them. */
  readonly external: readonly string[];
}

/** A snapshot container opens, and says which sections it holds outside itself. */
export function checkSnapshot(s: SnapshotWrite): Result<CheckedSnapshot, CodedError<"invalid_snapshot">> {
  const bad = (message: string) => err({ code: "invalid_snapshot" as const, message });
  if (!(s.bytes instanceof Uint8Array) || s.bytes.length > RECORDING_LIMITS.maxSnapshotBytes) return bad("snapshot bytes missing or too large");
  if (!Number.isInteger(s.seq) || s.seq < 0 || !Number.isInteger(s.tick) || s.tick < 0 || !(Number.isFinite(s.simTime) && s.simTime >= 0)) return bad("snapshot seq, tick and simTime must be non-negative numbers");
  try {
    const opened = readSnapshot(s.bytes);
    return ok({ id: snapshotHash(s.bytes), external: opened.sections.filter((x) => x.bytes === undefined).map((x) => x.hash) });
  } catch (e) {
    return bad(`not a snapshot container: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Shape of a belief frame; ordering against stored frames is checked by the adapter. */
export function checkFrames(frames: readonly BeliefFrame[]): Result<void, CodedError<"invalid_frame">> {
  const bad = (message: string) => err({ code: "invalid_frame" as const, message });
  if (frames.length > RECORDING_LIMITS.maxFramesPerAppend) return bad(`at most ${RECORDING_LIMITS.maxFramesPerAppend} frames per append`);
  for (const f of frames) {
    if (!AGENT.test(f.agentId)) return bad(`invalid agent id ${String(f.agentId).slice(0, 40)}`);
    if (!Number.isInteger(f.seq) || f.seq < 0 || !Number.isInteger(f.tick) || f.tick < 0) return bad("frame seq and tick must be non-negative integers");
    if (!(Number.isFinite(f.simTime) && f.simTime >= 0)) return bad("frame simTime must be a non-negative number");
    if (f.kind !== "keyframe" && f.kind !== "delta") return bad(`unknown frame kind ${String(f.kind)}`);
    if (!Array.isArray(f.chunks) || f.chunks.length > RECORDING_LIMITS.maxFrameChunks) return bad("frame chunks must be a list of chunk indices");
    for (let i = 0; i < f.chunks.length; i++) {
      const c = f.chunks[i];
      if (!Number.isInteger(c) || (c as number) < 0 || (i > 0 && (c as number) <= (f.chunks[i - 1] as number))) return bad("frame chunks must be non-negative integers in ascending order");
    }
    const hasBlob = f.blobId !== undefined;
    const hasData = f.data !== undefined;
    if (hasBlob === hasData) return bad("a frame holds its bytes either inline or as a blob, one of them");
    if (hasBlob && !HASH.test(f.blobId as string)) return bad("invalid blob id");
    if (hasData && (!(f.data instanceof Uint8Array) || f.data.length > RECORDING_LIMITS.maxFrameBytes)) return bad("frame data must be bytes, not too large");
  }
  const seen = new Set<string>();
  for (const f of frames) {
    const key = `${f.agentId}\u0000${f.seq}`;
    if (seen.has(key)) return err({ code: "invalid_frame", message: `frame ${f.agentId}#${f.seq} appears twice in the batch` });
    seen.add(key);
  }
  return ok(undefined);
}

/** Per agent, seq order is tick order (and so sim-time order), as for trace records. */
export function framesKeepOrder(frames: readonly BeliefFrame[], lastOfAgent: (agentId: string) => { seq: number; tick: number } | undefined): boolean {
  const byAgent = new Map<string, BeliefFrame[]>();
  for (const f of frames) byAgent.set(f.agentId, [...(byAgent.get(f.agentId) ?? []), f]);
  for (const [agentId, list] of byAgent) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < list.length; i++) if ((list[i] as BeliefFrame).tick < (list[i - 1] as BeliefFrame).tick) return false;
    const last = lastOfAgent(agentId);
    const first = list[0] as BeliefFrame;
    if (last && first.seq > last.seq && first.tick < last.tick) return false;
  }
  return true;
}

export function checkFrameQuery(q: BeliefFrameQuery): BeliefFrameQuery {
  return { ...q, limit: Math.max(0, Math.min(Math.trunc(q.limit), RECORDING_LIMITS.maxFrameQueryLimit)) };
}
