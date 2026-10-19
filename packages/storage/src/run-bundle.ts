import { decodeValue, err, isValid, ok, readSnapshot, type CodedError, type Result } from "@agentsim/core";
import { firstNonMonotonicRecord, isValidTraceRecord, RunHeader, type TraceRecord } from "@agentsim/trace";
import type { BeliefFrame, StoragePorts, StoredBlob, StoredRunInput } from "./ports.ts";
import { checkBlobs, checkFrames, checkRunRecording, framesKeepOrder, checkSnapshot } from "./recording.ts";
import { checkRunInputs } from "./run-inputs.ts";
import { BELIEF_MANIFEST_FORMAT_STORED } from "./sql/recording-integrity.ts";

// One run as a file (ADR-0035 addition of 2026-10-17, item 11): everything a run owns, read through the ports and written through them, so the same code
// serves the memory adapter, the SQL adapter and the storage worker. A run imported from a file is ADDED to the database under a fresh run ID (IDs are
// never reused) and keeps the ID it had in `importedFrom`; its records, snapshots, blobs and belief frames come across as they were, apart from the run ID
// and the record IDs that contain it.

export const RUN_JSONL_FORMAT = "agentsim-run-jsonl";
export const RUN_JSONL_VERSION = 1;
/** Like a database import (ADR-0020). */
export const MAX_RUN_FILE_BYTES = 512 * 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024 * 1024;
const MAX_LINES = 8_000_000;
const PAGE = 10_000;

export interface BundleScenario {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly document: unknown;
  readonly contentHash: string;
  readonly createdAtWallMs: number;
}

export interface BundleSnapshot {
  readonly seq: number;
  readonly simTime: number;
  readonly tick: number;
  /** The container (`ASNP`); its large sections are among the bundle's blobs. */
  readonly bytes: Uint8Array;
}

export interface RunBundle {
  readonly header: RunHeader;
  /** The scenario version the run used: it travels with the run (ADR-0028: a run is reproducible from it). */
  readonly scenario?: BundleScenario;
  readonly inputs: readonly StoredRunInput[];
  readonly records: readonly TraceRecord[];
  readonly snapshots: readonly BundleSnapshot[];
  readonly blobs: readonly StoredBlob[];
  readonly frames: readonly BeliefFrame[];
}

export type RunFileErrorCode = "unknown_run" | "not_run_file" | "unsupported_version" | "too_large" | "corrupt" | "non_monotonic_trace" | "broken_recording" | "write_failed";
export type RunFileError = CodedError<RunFileErrorCode>;

// ---- bytes as base64, without a stack of arguments ---------------------------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- reading a run out of the ports ---------------------------------------------------------------------------------------------------------

/** Everything a run owns, as it is stored. */
export async function readRunBundle(ports: StoragePorts, runId: string): Promise<Result<RunBundle, RunFileError>> {
  const header = await ports.runs.get(runId);
  if (!header) return err({ code: "unknown_run", message: `unknown run ${runId}` });
  const scenarioDoc = header.scenarioId === undefined ? undefined : await ports.scenarios.get(header.scenarioId, header.scenarioVersion);
  const inputs = await ports.runs.inputs(runId);
  const records: TraceRecord[] = [];
  for (let after = -1; ; ) {
    const page = await ports.trace.query({ runId, afterSeq: after, limit: PAGE });
    records.push(...page);
    if (page.length < PAGE) break;
    after = (page[page.length - 1] as TraceRecord).seq;
  }
  const blobs = new Map<string, StoredBlob>();
  const snapshots: BundleSnapshot[] = [];
  for (const info of await ports.snapshots.list(runId)) {
    const loaded = await ports.snapshots.read(runId, info.id);
    if (!loaded) return err({ code: "broken_recording", message: `snapshot ${info.id} of ${runId} cannot be read` });
    snapshots.push({ seq: info.seq, simTime: info.simTime, tick: info.tick, bytes: loaded.container });
    for (const b of loaded.blobs) blobs.set(b.id, b);
  }
  // Belief frames: per agent, in seq order, a tick window at a time (the port pages by tick, not by seq).
  // The agents that have frames: those with a keyframe (every map starts with one), found without knowing the agents.
  const agents = new Set<string>();
  for (const k of await ports.beliefFrames.query({ runId, kind: "keyframe", limit: PAGE })) agents.add(k.agentId);
  const frames: BeliefFrame[] = [];
  for (const agentId of agents) {
    let fromTick = 0;
    let lastSeq = -1;
    for (;;) {
      const page = await ports.beliefFrames.query({ runId, agentId, fromTick, limit: PAGE });
      const fresh = page.filter((f) => f.seq > lastSeq);
      frames.push(...fresh);
      if (page.length < PAGE || fresh.length === 0) break;
      const last = page[page.length - 1] as BeliefFrame;
      fromTick = last.tick;
      lastSeq = last.seq;
    }
  }
  // Keyframe blobs: the manifest and the groups it names.
  for (const f of frames) {
    if (f.blobId === undefined || blobs.has(f.blobId)) continue;
    const manifest = await ports.snapshots.getBlob(runId, f.blobId);
    if (!manifest) return err({ code: "broken_recording", message: `belief frame ${f.agentId}#${f.seq} refers to blob ${f.blobId}, which is not stored` });
    blobs.set(manifest.id, manifest);
    for (const hash of manifestGroups(manifest.bytes) ?? []) {
      if (blobs.has(hash)) continue;
      const group = await ports.snapshots.getBlob(runId, hash);
      if (!group) return err({ code: "broken_recording", message: `keyframe ${f.agentId}#${f.seq} names group ${hash}, which is not stored` });
      blobs.set(group.id, group);
    }
  }
  return ok({
    header,
    ...(scenarioDoc ? { scenario: { id: scenarioDoc.id, version: scenarioDoc.version, name: scenarioDoc.name, document: scenarioDoc.document, contentHash: scenarioDoc.contentHash, createdAtWallMs: scenarioDoc.createdAtWallMs } } : {}),
    inputs,
    records,
    snapshots,
    blobs: [...blobs.values()],
    frames,
  });
}

/** The group hashes a keyframe manifest names, or undefined when the bytes are not a manifest. */
function manifestGroups(bytes: Uint8Array): string[] | undefined {
  try {
    const m = decodeValue(bytes) as { format?: unknown; groups?: { hash?: unknown }[] } | null;
    if (m?.format !== BELIEF_MANIFEST_FORMAT_STORED || !Array.isArray(m.groups)) return undefined;
    return m.groups.map((g) => String(g.hash));
  } catch {
    return undefined;
  }
}

// ---- what a bundle must be -----------------------------------------------------------------------------------------------------------------

/**
 * The first thing wrong with a bundle, as a database import would find it (ADR-0035 addition of 2026-10-17, items 2, 8 and 9; ADR-0004 addition of
 * 2026-10-18, second): valid header and records in monotonic order, every blob what its ID says, every snapshot opening onto sections that are there, every
 * frame well formed with its blob and in order, every keyframe a manifest whose groups are there.
 */
export function bundleProblem(b: RunBundle): { readonly code: RunFileErrorCode; readonly message: string } | undefined {
  if (!isValid(RunHeader, b.header)) return { code: "corrupt", message: "the run header is not valid" };
  const rec = checkRunRecording(b.header);
  if (!rec.ok) return { code: "broken_recording", message: rec.error.message };
  for (const r of b.records) {
    if (!isValidTraceRecord(r) || r.runId !== b.header.runId || r.id !== `${b.header.runId}#${r.seq}`) return { code: "corrupt", message: `record ${String(r?.id)} is not a valid record of ${b.header.runId}` };
  }
  const sorted = [...b.records].sort((a, c) => a.seq - c.seq);
  if (sorted.some((r, i) => i > 0 && r.seq === (sorted[i - 1] as TraceRecord).seq)) return { code: "corrupt", message: "two records share a seq" };
  const back = firstNonMonotonicRecord(sorted);
  if (back) return { code: "non_monotonic_trace", message: `sim time goes backwards at seq ${back.seq}` };
  const inputs = checkRunInputs([], b.inputs);
  if (!inputs.ok) return { code: "corrupt", message: inputs.error.message };
  const blobs = checkBlobs(b.blobs);
  if (!blobs.ok) return { code: "broken_recording", message: blobs.error.message };
  const have = new Set(b.blobs.map((x) => x.id));
  for (const s of b.snapshots) {
    const checked = checkSnapshot({ seq: s.seq, simTime: s.simTime, tick: s.tick, bytes: s.bytes });
    if (!checked.ok) return { code: "broken_recording", message: checked.error.message };
    for (const hash of checked.value.external) if (!have.has(hash)) return { code: "broken_recording", message: `snapshot at tick ${s.tick} refers to section ${hash}, which is not in the file` };
    try {
      readSnapshot(s.bytes);
    } catch (e) {
      return { code: "broken_recording", message: `snapshot at tick ${s.tick} does not open: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const frames = checkFrames(b.frames);
  if (!frames.ok) return { code: "broken_recording", message: frames.error.message };
  if (!framesKeepOrder(b.frames, () => undefined)) return { code: "broken_recording", message: "belief frames go back in time" };
  for (const f of b.frames) {
    if (f.blobId === undefined) continue;
    if (!have.has(f.blobId)) return { code: "broken_recording", message: `belief frame ${f.agentId}#${f.seq} refers to a blob that is not in the file` };
    if (f.kind !== "keyframe") continue;
    const groups = manifestGroups((b.blobs.find((x) => x.id === f.blobId) as StoredBlob).bytes);
    if (groups === undefined) return { code: "broken_recording", message: `keyframe ${f.agentId}#${f.seq} is not a belief map manifest (recorded before keyframes were chunk groups)` };
    for (const hash of groups) if (!have.has(hash)) return { code: "broken_recording", message: `keyframe ${f.agentId}#${f.seq} names a group section that is not in the file` };
  }
  return undefined;
}

// ---- writing a bundle as a new run ---------------------------------------------------------------------------------------------------------

const rewrite = (id: string | undefined, from: string, to: string): string | undefined => (id !== undefined && id.startsWith(`${from}#`) ? `${to}#${id.slice(from.length + 1)}` : id);

/**
 * Adds the run of a bundle to the database as a new run: a fresh ID (never reused), `importedFrom` set to the ID it had (the earliest, for a run that was
 * imported before), its scenario version reused when the database has it with the same content, saved as a new version otherwise. Records and references
 * come across as they were, apart from the run ID and the record IDs that contain it. Nothing stays behind if a write fails.
 */
export async function writeRunBundle(ports: StoragePorts, b: RunBundle): Promise<Result<{ readonly runId: string; readonly importedFrom: string }, RunFileError>> {
  const problem = bundleProblem(b);
  if (problem) return err(problem);
  const origin = b.header.importedFrom ?? b.header.runId;
  let scenarioVersion = b.header.scenarioVersion;
  if (b.scenario && b.header.scenarioId !== undefined) {
    // The same content under the same ID is the same version, whatever its number was where the run was recorded.
    const known = await ports.scenarios.list();
    const latest = known.find((s) => s.id === b.scenario?.id)?.latestVersion ?? 0;
    let reuse: number | undefined;
    for (let v = 1; v <= latest && reuse === undefined; v++) if ((await ports.scenarios.get(b.scenario.id, v))?.contentHash === b.scenario.contentHash) reuse = v;
    if (reuse === undefined) {
      const saved = await ports.scenarios.saveVersion(b.scenario.document);
      if (!saved.ok) return err({ code: "write_failed", message: `the scenario of the run was refused: ${saved.error.message}` });
      reuse = saved.value.version;
    }
    scenarioVersion = reuse;
  }
  const runId = await ports.runs.allocateRunId();
  const from = b.header.runId;
  const header = { ...b.header, runId, importedFrom: origin, ...(scenarioVersion === undefined ? {} : { scenarioVersion }) };
  const created = await ports.runs.create(header);
  if (!created.ok) return err({ code: "write_failed", message: created.error.message });
  const fail = async (message: string): Promise<Result<never, RunFileError>> => {
    await ports.runs.delete(runId);
    return err({ code: "write_failed", message });
  };
  try {
    if (b.inputs.length > 0) {
      const r = await ports.runs.appendInputs(runId, b.inputs);
      if (!r.ok) return await fail(r.error.message);
    }
    const records = [...b.records].sort((a, c) => a.seq - c.seq).map((r) => ({ ...r, runId, id: rewrite(r.id, from, runId) as string, ...(r.parentId === undefined ? {} : { parentId: rewrite(r.parentId, from, runId) as string }), ...(r.causeIds === undefined ? {} : { causeIds: r.causeIds.map((c) => rewrite(c, from, runId) as string) }) }));
    for (let i = 0; i < records.length; i += PAGE) {
      const r = await ports.trace.append(records.slice(i, i + PAGE));
      if (!r.ok) return await fail(r.error.message);
    }
    const stored = await ports.snapshots.putBlobs(runId, b.blobs);
    if (!stored.ok) return await fail(stored.error.message);
    for (const s of [...b.snapshots].sort((a, c) => a.tick - c.tick)) {
      const r = await ports.snapshots.write(runId, { seq: s.seq, simTime: s.simTime, tick: s.tick, bytes: s.bytes });
      if (!r.ok && r.error.code !== "duplicate_snapshot") return await fail(r.error.message);
    }
    const frames = [...b.frames].sort((a, c) => (a.agentId < c.agentId ? -1 : a.agentId > c.agentId ? 1 : a.seq - c.seq));
    for (let i = 0; i < frames.length; i += PAGE) {
      const r = await ports.beliefFrames.append(runId, frames.slice(i, i + PAGE));
      if (!r.ok) return await fail(r.error.message);
    }
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e));
  }
  return ok({ runId, importedFrom: origin });
}

// ---- the file --------------------------------------------------------------------------------------------------------------------------------

/** A bundle as JSON lines: a versioned first line with the run header, then the scenario, inputs, records, blobs, snapshots and belief frames (bytes as base64). */
export function bundleToJsonl(b: RunBundle): Uint8Array {
  const lines: string[] = [JSON.stringify({ format: RUN_JSONL_FORMAT, version: RUN_JSONL_VERSION, header: b.header })];
  if (b.scenario) lines.push(JSON.stringify({ t: "scenario", v: b.scenario }));
  for (const v of b.inputs) lines.push(JSON.stringify({ t: "input", v }));
  for (const v of b.records) lines.push(JSON.stringify({ t: "record", v }));
  for (const x of b.blobs) lines.push(JSON.stringify({ t: "blob", id: x.id, data: bytesToBase64(x.bytes) }));
  for (const s of b.snapshots) lines.push(JSON.stringify({ t: "snapshot", seq: s.seq, simTime: s.simTime, tick: s.tick, data: bytesToBase64(s.bytes) }));
  for (const f of b.frames) lines.push(JSON.stringify({ t: "frame", v: { ...f, ...(f.data === undefined ? {} : { data: bytesToBase64(f.data) }) } }));
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/** Reads a run file; the format is checked before anything is trusted, and limits apply. The bundle is validated by `writeRunBundle`, or `bundleProblem`. */
export function bundleFromJsonl(bytes: Uint8Array): Result<RunBundle, RunFileError> {
  if (bytes.length > MAX_RUN_FILE_BYTES) return err({ code: "too_large", message: `file exceeds ${MAX_RUN_FILE_BYTES} bytes` });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) return err({ code: "too_large", message: `file has more than ${MAX_LINES} lines` });
  let first: { format?: unknown; version?: unknown; header?: unknown };
  try {
    first = JSON.parse(lines[0] ?? "") as typeof first;
  } catch {
    return err({ code: "not_run_file", message: "the first line is not a run file header" });
  }
  if (first?.format !== RUN_JSONL_FORMAT) return err({ code: "not_run_file", message: "not an agentsim run file" });
  if (first.version !== RUN_JSONL_VERSION) return err({ code: "unsupported_version", message: `run file version ${String(first.version)}, this lab reads version ${RUN_JSONL_VERSION}` });
  if (!isValid(RunHeader, first.header)) return err({ code: "corrupt", message: "the run header of the file is not valid" });
  const records: TraceRecord[] = [];
  const inputs: StoredRunInput[] = [];
  const blobs: StoredBlob[] = [];
  const snapshots: BundleSnapshot[] = [];
  const frames: BeliefFrame[] = [];
  let scenario: BundleScenario | undefined;
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n] as string;
    if (line === "") continue;
    if (line.length > MAX_LINE_BYTES) return err({ code: "too_large", message: `line ${n + 1} is larger than ${MAX_LINE_BYTES} bytes` });
    try {
      const x = JSON.parse(line) as { t?: string; v?: never; id?: string; data?: string; seq?: number; simTime?: number; tick?: number };
      switch (x.t) {
        case "scenario": scenario = x.v as unknown as BundleScenario; break;
        case "input": inputs.push(x.v as unknown as StoredRunInput); break;
        case "record": records.push(x.v as unknown as TraceRecord); break;
        case "blob": blobs.push({ id: String(x.id), bytes: base64ToBytes(String(x.data)) }); break;
        case "snapshot": snapshots.push({ seq: Number(x.seq), simTime: Number(x.simTime), tick: Number(x.tick), bytes: base64ToBytes(String(x.data)) }); break;
        case "frame": {
          const f = x.v as unknown as BeliefFrame & { data?: string };
          frames.push({ ...f, ...(f.data === undefined ? {} : { data: base64ToBytes(String(f.data)) }) } as BeliefFrame);
          break;
        }
        default:
          return err({ code: "corrupt", message: `line ${n + 1}: unknown line type ${String(x.t)}` });
      }
    } catch (e) {
      return err({ code: "corrupt", message: `line ${n + 1} does not parse: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return ok({ header: first.header as RunHeader, ...(scenario ? { scenario } : {}), inputs, records, snapshots, blobs, frames });
}

/** Reads a run out of the ports as a file. */
export async function exportRunJsonl(ports: StoragePorts, runId: string): Promise<Result<Uint8Array, RunFileError>> {
  const bundle = await readRunBundle(ports, runId);
  return bundle.ok ? ok(bundleToJsonl(bundle.value)) : bundle;
}

/** Adds the run of a file to the database as a new run. */
export async function importRunJsonl(ports: StoragePorts, bytes: Uint8Array): Promise<Result<{ readonly runId: string; readonly importedFrom: string }, RunFileError>> {
  const bundle = bundleFromJsonl(bytes);
  return bundle.ok ? writeRunBundle(ports, bundle.value) : bundle;
}
