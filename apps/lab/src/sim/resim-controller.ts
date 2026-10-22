import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { StoragePorts, StoredRunInput } from "@agentsim/storage";
import { recordingProfileHash, RECORDING_PRESETS, type DerivedRun, type RecordingProfile, type RunHeader, type TraceRecord } from "@agentsim/trace";
import { SCENARIO_DT_S } from "./sim-constants.ts";
import { toWire, type ResimWorkerReply } from "./resim-wire.ts";
import { completeReferences, MAX_WINDOW_S, type UnresolvedReferences } from "./resim-refs.ts";
import type { ResimError, ResimWindowRequest, ResimWindowResult } from "./resim-window.ts";

// Re-simulating a window of a stored run into a derived run (ADR-0035 section 3 and its addition of 2026-10-17, item 10), the part that reads the parent from storage and writes
// the derived run to it. The execution itself is `resim-window.ts`, run in a worker of its own so the live run in the sim worker is not touched; the parent is only read.

export type ResimFailure = CodedError<
  "unknown_run" | "run_not_recorded" | "not_resimulatable" | "scenario_version_not_found" | "window_not_recorded" | "no_snapshot" | "snapshot_unreadable" | "write_failed" | ResimError["code"]
>;

/** Runs the execution somewhere: a worker (`workerRunner`) or in place (tests). */
export type ResimRunner = (req: Omit<ResimWindowRequest, "nowWallMs">, sections: ReadonlyMap<string, Uint8Array>) => Promise<Result<ResimWindowResult, ResimError>>;

/** A worker of its own for one job: spawned, given the request (the large buffers moved, not copied), terminated when it has answered. */
export const workerRunner: ResimRunner = (req, sections) =>
  new Promise((resolve) => {
    const worker = new Worker(new URL("../workers/resim.worker.ts", import.meta.url), { type: "module", name: "resim" });
    const done = (r: Result<ResimWindowResult, ResimError>) => {
      worker.terminate();
      resolve(r);
    };
    worker.onmessage = (e: MessageEvent<ResimWorkerReply>) => done(e.data.type === "result" ? ok(e.data.result) : err(e.data.error));
    worker.onerror = (e) => done(err({ code: "run_failed", message: e.message || "the re-simulation worker failed" }));
    worker.postMessage({ type: "resim", request: toWire(req, sections) });
  });

export interface ResimOptions {
  /** The recording profile of the derived run (default `debug-full`: the point of a re-simulation is more detail). */
  readonly profile?: RecordingProfile;
  readonly runner?: ResimRunner;
  /** Wall time of the derived run's header (metadata only). */
  readonly nowWallMs?: () => number;
}

/** The sim time (s) a run is recorded up to for a re-simulation: its last checkpoint (0 when it has none). */
export async function recordedUpTo(ports: StoragePorts, runId: string): Promise<number> {
  let last = -1;
  await scan(ports, runId, { kinds: ["event"], op: "checkpoint", toS: Number.MAX_SAFE_INTEGER }, (r) => {
    const t = payloadOf(r)["tick"];
    if (typeof t === "number") last = Math.max(last, t);
  });
  return Math.max(0, last) * SCENARIO_DT_S;
}

/** Half the width of the window the palette command takes around the cursor (s). */
export const DEFAULT_HALF_WINDOW_S = 5;

/**
 * The window the palette command re-simulates: the cursor with `DEFAULT_HALF_WINDOW_S` either side, moved to fit in what is recorded ([0, upToS]) and no longer than
 * that is; undefined when nothing is recorded to speak of.
 */
export function defaultWindow(cursorS: number, upToS: number): { t0S: number; t1S: number } | undefined {
  if (!(upToS > 0)) return undefined;
  const width = Math.min(2 * DEFAULT_HALF_WINDOW_S, upToS);
  const t0 = Math.min(Math.max(0, cursorS - DEFAULT_HALF_WINDOW_S), upToS - width);
  return { t0S: Math.round(t0 * 10) / 10, t1S: Math.round((t0 + width) * 10) / 10 };
}

/** The window the palette command re-simulates for a run and a cursor, or why there is none: a run that was not recorded says so before anything else. */
export async function suggestWindow(ports: StoragePorts, runId: string, cursorS: number): Promise<Result<{ t0S: number; t1S: number }, ResimFailure>> {
  const header = await ports.runs.get(runId);
  if (!header) return err({ code: "unknown_run", message: `unknown run ${runId}` });
  if (header.recording !== "stored") return err({ code: "run_not_recorded", message: `${runId} was not recorded ("Don't record this run"): a window of it cannot be re-simulated; the whole run can, from its inputs` });
  const window = defaultWindow(cursorS, await recordedUpTo(ports, runId));
  return window ? ok(window) : err({ code: "window_not_recorded", message: `${runId} has nothing recorded to re-simulate yet` });
}

export interface ResimOutcome {
  readonly runId: string;
  readonly derived: DerivedRun;
}

const PAGE = 2000;
const WRITE_CHUNK = 2000;

/** Everything of a kind of the parent's trace up to a sim time, paged. */
async function scan(ports: StoragePorts, runId: string, q: { kinds: string[]; op?: string; toS: number }, visit: (r: TraceRecord) => void): Promise<void> {
  let after: number | undefined;
  for (;;) {
    const page = await ports.trace.query({ runId, kinds: q.kinds, ...(q.op === undefined ? {} : { op: q.op }), simTime: { to: q.toS }, limit: PAGE, ...(after === undefined ? {} : { afterSeq: after }) });
    for (const r of page) visit(r);
    const last = page[page.length - 1];
    if (page.length < PAGE || !last) return;
    after = last.seq;
  }
}

const payloadOf = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

/**
 * Re-simulates [t0S, t1S] of `parentRunId` under a profile of its own and stores the result as a new run linked to its parent. The parent is only read. The window must lie
 * in what the parent recorded (a run still being recorded can be re-simulated up to its last checkpoint); a run that opted out of recording cannot be.
 */
export async function resimulateWindowToRun(ports: StoragePorts, parentRunId: string, window: { t0S: number; t1S: number }, options: ResimOptions = {}): Promise<Result<ResimOutcome, ResimFailure>> {
  const profile = options.profile ?? RECORDING_PRESETS["debug-full"];
  const runner = options.runner ?? workerRunner;
  const parent = await ports.runs.get(parentRunId);
  if (!parent) return err({ code: "unknown_run", message: `unknown run ${parentRunId}` });
  if (parent.recording !== "stored") return err({ code: "run_not_recorded", message: `${parentRunId} was not recorded ("Don't record this run"): a window of it cannot be re-simulated; the whole run can, from its inputs` });
  if (parent.scenarioId === undefined || parent.scenarioVersion === undefined) return err({ code: "not_resimulatable", message: `${parentRunId} has no scenario` });
  const scenario = await ports.scenarios.get(parent.scenarioId, parent.scenarioVersion);
  if (!scenario) return err({ code: "scenario_version_not_found", message: `scenario ${parent.scenarioId} v${parent.scenarioVersion} is not stored` });
  if (!(Number.isFinite(window.t0S) && Number.isFinite(window.t1S)) || window.t0S < 0 || window.t1S < window.t0S) return err({ code: "window_invalid", message: `the window [${window.t0S}, ${window.t1S}] s does not run forward` });
  if (window.t1S - window.t0S > MAX_WINDOW_S) return err({ code: "window_too_long", message: `a window of ${(window.t1S - window.t0S).toFixed(1)} s is longer than ${MAX_WINDOW_S} s` });

  // What the parent recorded: its checkpoints (the window is compared against them and cannot run past the last one) and its snapshots.
  const checkpoints: { tick: number; stateHash: string }[] = [];
  await scan(ports, parentRunId, { kinds: ["event"], op: "checkpoint", toS: Number.MAX_SAFE_INTEGER }, (r) => {
    const p = payloadOf(r);
    if (typeof p["tick"] === "number" && typeof p["stateHash"] === "string") checkpoints.push({ tick: p["tick"], stateHash: p["stateHash"] });
  });
  const dt = SCENARIO_DT_S;
  const endTick = Math.max(1, Math.round(window.t1S / dt));
  const startTick = Math.max(0, Math.round(window.t0S / dt) - 1);
  const lastTick = checkpoints.reduce((n, c) => Math.max(n, c.tick), -1);
  if (lastTick < endTick) return err({ code: "window_not_recorded", message: `${parentRunId} is recorded up to ${(Math.max(0, lastTick) * dt).toFixed(1)} s: the window ends at ${window.t1S} s` });
  const snaps = (await ports.snapshots.list(parentRunId)).filter((s) => s.tick <= startTick).sort((a, b) => b.tick - a.tick);
  const chosen = snaps[0];
  if (!chosen && startTick > 0) return err({ code: "no_snapshot", message: `${parentRunId} has no snapshot at or before ${(startTick * dt).toFixed(1)} s to start from` });
  let snapshot: ResimWindowRequest["snapshot"];
  const sections = new Map<string, Uint8Array>();
  if (chosen) {
    const loaded = await ports.snapshots.read(parentRunId, chosen.id);
    if (!loaded) return err({ code: "snapshot_unreadable", message: `snapshot ${chosen.id} of ${parentRunId} cannot be read` });
    for (const b of loaded.blobs) sections.set(b.id, b.bytes);
    snapshot = { tick: loaded.tick, bytes: loaded.container, resolve: (h) => sections.get(h) };
  }
  const inputs: StoredRunInput[] = await ports.runs.inputs(parentRunId);
  const runId = await ports.runs.allocateRunId();

  const ran = await runner(
    { runId, scenario: scenario.document, scenarioVersion: scenario.version, runConfig: parent.runConfig, inputs, window, profile, ...(snapshot ? { snapshot } : {}), checkpoints, parentRunId },
    sections,
  );
  if (!ran.ok) return ran;
  const { derived, batches, items } = ran.value;
  const records = batches.flatMap((b) => b.records);
  const firstSeq = records.reduce((n, r) => Math.min(n, r.seq), Number.MAX_SAFE_INTEGER);

  // Self-contained: what the window refers to and that happened before it is read from the parent and re-emitted as copies (ADR-0035 item 2(b)).
  const startS = startTick * dt;
  const find = async (need: UnresolvedReferences): Promise<TraceRecord[]> => {
    const found: TraceRecord[] = [];
    if (need.spaces.size > 0) await scan(ports, parentRunId, { kinds: ["thought"], op: "space", toS: startS }, (r) => need.spaces.has(String(payloadOf(r)["hash"])) && found.push(r));
    if (need.queries.size > 0) await scan(ports, parentRunId, { kinds: ["compute"], toS: startS }, (r) => need.queries.has(String(payloadOf(r)["queryId"])) && found.push(r));
    for (const id of need.records) {
      const seq = Number(id.slice(id.indexOf("#") + 1));
      if (!Number.isInteger(seq) || seq < 0) continue;
      const [r] = await ports.trace.query({ runId: parentRunId, afterSeq: seq - 1, limit: 1 });
      if (r && r.seq === seq) found.push(r);
    }
    // They come before the window's first record, or they would break the run's order.
    return found.filter((r) => r.seq < firstSeq);
  };
  const completed = await completeReferences(parentRunId, runId, records, find);
  const finalDerived: DerivedRun = { ...derived, copies: completed.copies.length };

  const header: RunHeader = {
    runId,
    schemaVersion: parent.schemaVersion,
    createdAtWallMs: (options.nowWallMs ?? Date.now)(),
    label: `window ${window.t0S.toFixed(1)}–${window.t1S.toFixed(1)} s of ${parentRunId}`,
    ...(parent.scenario === undefined ? {} : { scenario: parent.scenario }),
    ...(parent.seed === undefined ? {} : { seed: parent.seed }),
    status: "completed",
    scenarioId: parent.scenarioId,
    scenarioVersion: parent.scenarioVersion,
    ...(parent.runConfig === undefined ? {} : { runConfig: parent.runConfig }),
    ...(parent.runConfigHash === undefined ? {} : { runConfigHash: parent.runConfigHash }),
    ...(parent.effectiveConfigHash === undefined ? {} : { effectiveConfigHash: parent.effectiveConfigHash }),
    ...(parent.simulatorVersion === undefined ? {} : { simulatorVersion: parent.simulatorVersion }),
    ...(parent.idealAgents === undefined ? {} : { idealAgents: parent.idealAgents }),
    recording: "stored",
    recordingProfile: profile,
    recordingProfileHash: recordingProfileHash(profile),
    derived: finalDerived,
  };
  const created = await ports.runs.create(header);
  if (!created.ok) return err({ code: "write_failed", message: `${created.error.code}: ${created.error.message}` });
  const fail = async (what: string): Promise<Result<ResimOutcome, ResimFailure>> => {
    await ports.runs.delete(runId); // nothing of a half-written derived run stays
    return err({ code: "write_failed", message: what });
  };
  for (const item of items) {
    if (item.type === "snapshot") {
      const w = await ports.snapshots.write(runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
      if (!w.ok) return fail(`${w.error.code}: ${w.error.message}`);
    } else {
      const b = await ports.snapshots.putBlobs(runId, item.blobs);
      if (!b.ok) return fail(`${b.error.code}: ${b.error.message}`);
      const f = await ports.beliefFrames.append(runId, item.frames);
      if (!f.ok) return fail(`${f.error.code}: ${f.error.message}`);
    }
  }
  const all = [...completed.copies, ...records];
  for (let i = 0; i < all.length; i += WRITE_CHUNK) {
    const a = await ports.trace.append(all.slice(i, i + WRITE_CHUNK));
    if (!a.ok) return fail(`${a.error.code}: ${a.error.message}`);
  }
  await ports.trace.flush();
  return ok({ runId, derived: finalDerived });
}
