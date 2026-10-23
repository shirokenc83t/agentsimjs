import type { PresetId, SimLoadedMessage } from "@agentsim/core";
import { F1_DEMO_ID, F1_REFERENCE_WORLD_ID, F2_DISCOVERY_ID, F2_PRIOR_REFERENCE_ID, F2_TWENTY_AGENTS_ID, f1DemoRunConfig, f1ReferenceWorldRunConfig, f2PriorRunConfig, f2RunConfig } from "@agentsim/scenarios";
import type { StorageClient, StoredRunInput } from "@agentsim/storage";
import { recordingProfileHash, TRACE_SCHEMA_VERSION, type RunHeader } from "@agentsim/trace";
import { DEFAULT_RECORDING, takeHeadlessChoice, takeRecordingChoice, type RecordingChoice } from "./recording-choice.ts";
import type { SimClient } from "./sim-client.ts";
import { SIMULATOR_VERSION } from "./simulator-version.ts";

/** A run started from the lab: the worker's report plus the documents it was started from. */
export interface LabRun {
  readonly loaded: SimLoadedMessage;
  readonly header: RunHeader;
  readonly scenario: unknown;
  readonly runConfig: unknown;
  /** The run is headless (ADR-0029): no render state, always recorded, with an end condition in sim seconds when it has one. */
  readonly headless?: HeadlessOptions;
}

/** What a headless run is asked: the sim seconds after which it stops (absent: it runs until it is stopped). */
export interface HeadlessOptions {
  readonly untilS?: number;
}

/**
 * The reproducibility header of a run started from the lab (ADR-0028): scenario version, the run's own copy
 * of its run configuration, both hashes (computed by the worker that resolved them) and the simulator version.
 */
export function headerOf(
  loaded: SimLoadedMessage,
  runConfig: unknown,
  label: string,
  createdAtWallMs: number,
  simulatorVersion = SIMULATOR_VERSION,
  recording: RecordingChoice = DEFAULT_RECORDING,
): RunHeader {
  return {
    runId: loaded.runId,
    schemaVersion: TRACE_SCHEMA_VERSION,
    createdAtWallMs,
    label,
    scenario: loaded.scenarioId,
    seed: loaded.seed,
    status: "running",
    scenarioId: loaded.scenarioId,
    scenarioVersion: loaded.scenarioVersion,
    runConfig,
    runConfigHash: loaded.runConfigHash,
    effectiveConfigHash: loaded.effectiveConfigHash,
    simulatorVersion,
    // As resolved by the worker for this run, never re-derived later (ADR-0028 addition of 2026-10-10).
    idealAgents: [...loaded.idealAgents],
    // A recorded run records its resolved profile and the profile's hash, next to the run configuration's; an opted-out run says only that.
    recording: recording.mode,
    ...(recording.mode === "stored" ? { recordingProfile: recording.profile, recordingProfileHash: recordingProfileHash(recording.profile) } : {}),
  };
}

const PRESETS: Readonly<Record<PresetId, { id: string; label: string; runConfig: (version: number) => unknown }>> = {
  "f1-demo": { id: F1_DEMO_ID, label: "F1 demo", runConfig: f1DemoRunConfig },
  "f1-reference-1km": { id: F1_REFERENCE_WORLD_ID, label: "F1 reference world", runConfig: f1ReferenceWorldRunConfig },
  "f2-discovery": { id: F2_DISCOVERY_ID, label: "F2 discovery", runConfig: (v) => f2RunConfig(F2_DISCOVERY_ID, v) },
  "f2-prior-1km": { id: F2_PRIOR_REFERENCE_ID, label: "F2 prior map (1 km²)", runConfig: f2PriorRunConfig },
  "f2-20-agents": { id: F2_TWENTY_AGENTS_ID, label: "F2 20 agents", runConfig: (v) => f2RunConfig(F2_TWENTY_AGENTS_ID, v) },
};

/**
 * Stores a preset scenario as a new version only if the latest stored one differs (versions are never reused,
 * ADR-0025 / d2), and returns the version to run. The sim worker builds the document and its content hash; the
 * main thread compares hashes and passes the document on, never serializing or parsing it (F1 f1).
 */
async function presetVersion(storage: StorageClient, id: string, document: unknown, hash: string): Promise<number> {
  const latest = await storage.ports.scenarios.get(id);
  if (latest && latest.contentHash === hash) return latest.version;
  const saved = await storage.ports.scenarios.saveVersion(document);
  if (!saved.ok) throw new Error(`${saved.error.code}: ${saved.error.message}`);
  return saved.value.version;
}

/**
 * Stores the run inputs of the current run as the worker records them (ADR-0015 clarification): like the seed
 * and the run configuration, they are part of what the run ran, so a run reloaded after a restart is re-simulated
 * identically. Inputs reported before the run header exists are buffered; appends are chained so they stay in
 * order. A failed append is reported, never dropped silently.
 */
class InputRecorder {
  private headerStored = false;
  private buffer: StoredRunInput[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly stop: () => void;
  error: string | undefined;

  constructor(
    private readonly storage: StorageClient,
    sim: SimClient,
    private readonly runId: string,
  ) {
    this.stop = sim.onInput((m) => {
      if (m.runId !== this.runId) return;
      if (this.headerStored) this.append([m.input]);
      else this.buffer.push(m.input);
    });
  }

  /** The run header is stored: flush what arrived before it. */
  headerCreated(): Promise<void> {
    this.headerStored = true;
    const pending = this.buffer;
    this.buffer = [];
    if (pending.length > 0) this.append(pending);
    return this.chain;
  }

  private append(inputs: StoredRunInput[]): void {
    this.chain = this.chain.then(async () => {
      const r = await this.storage.ports.runs.appendInputs(this.runId, inputs);
      if (!r.ok) this.error = `${r.error.code}: ${r.error.message}`;
    });
  }

  /** Waits for every append issued so far (tests, run switch). */
  flushed(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.stop();
  }
}

let recorder: InputRecorder | undefined;

/** Run inputs of the current run are stored; resolves when every one recorded so far is (tests, diagnostics). */
export function inputsStored(): Promise<string | undefined> {
  return (recorder?.flushed() ?? Promise.resolve()).then(() => recorder?.error);
}

/**
 * Starts a run: a new run ID from storage, the documents loaded and validated by the sim worker, then the
 * run header stored, then its run inputs as they are recorded. Runs need storage (memory fallback included);
 * if storage failed, nothing starts. `inputs` re-simulates a stored run: its inputs are applied again.
 */
export async function startRun(
  storage: StorageClient,
  sim: SimClient,
  scenario: unknown,
  scenarioVersion: number,
  runConfig: unknown,
  label: string,
  inputs: readonly StoredRunInput[] = [],
  recording: RecordingChoice = takeRecordingChoice(),
  headless?: HeadlessOptions,
): Promise<LabRun> {
  if (storage.status().state !== "ready") throw new Error("storage_unavailable: runs need storage (see the status line)");
  // A recorded run needs the direct channel between the sim worker and the storage worker; there is no silent fallback to "not recorded".
  if (recording.mode === "stored" && !sim.recorderAttached) throw new Error("recorder_unavailable: the recorder channel between the workers is not set up");
  const runId = await storage.ports.runs.allocateRunId();
  await recorder?.flushed();
  recorder?.dispose();
  recorder = new InputRecorder(storage, sim, runId);
  const loaded = await sim.load({ runId, scenario, scenarioVersion, runConfig, ...(inputs.length > 0 ? { inputs: [...inputs] } : {}), recording, ...(headless === undefined ? {} : { headless: headless.untilS === undefined ? {} : { untilS: headless.untilS } }) });
  // Wall time is run metadata only; it never reaches the simulation (ADR-0002).
  const header = headerOf(loaded, runConfig, label, Date.now(), SIMULATOR_VERSION, recording);
  const created = await storage.ports.runs.create(header);
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
  await recorder.headerCreated();
  if (headless !== undefined) markWhenDone(storage, sim, runId);
  return { loaded, header, scenario, runConfig, ...(headless === undefined ? {} : { headless }) };
}

/**
 * A headless run ends by itself (its end condition) or is stopped: the worker reports it done, and the run's status follows: `completed` when it reached its end
 * (or had none), `aborted` when it was stopped before its end condition.
 */
function markWhenDone(storage: StorageClient, sim: SimClient, runId: string): void {
  const off = sim.subscribe("progress", (m) => {
    if (m.runId !== runId || !m.done) return;
    off();
    const early = m.untilS !== undefined && m.simTimeS < m.untilS - 1e-6;
    void storage.ports.runs.setStatus(runId, early ? "aborted" : "completed");
  });
}

/**
 * Re-simulates a stored run as a new run, run again from its inputs (after a reload, a browser restart or an import): its scenario version,
 * its own copy of the run configuration and its recorded inputs. Deterministic runs reach the same state hashes.
 */
export async function resimulateRun(storage: StorageClient, sim: SimClient, runId: string): Promise<LabRun> {
  const header = await storage.ports.runs.get(runId);
  if (!header) throw new Error(`unknown_run: ${runId}`);
  if (header.scenarioId === undefined || header.scenarioVersion === undefined) throw new Error(`not_resimulatable: ${runId} has no scenario`);
  const stored = await storage.ports.scenarios.get(header.scenarioId, header.scenarioVersion);
  if (!stored) throw new Error(`scenario_version_not_found: ${header.scenarioId} v${header.scenarioVersion}`);
  const inputs = await storage.ports.runs.inputs(runId);
  return startRun(storage, sim, stored.document, header.scenarioVersion, header.runConfig, `re-simulation of ${runId}`, inputs);
}

/** Stored runs that can be re-simulated (they name a scenario version), newest first. */
export async function resimulatableRuns(storage: StorageClient): Promise<{ runId: string; label: string; inputs: number }[]> {
  const runs = (await storage.ports.runs.list()).filter((r) => r.scenarioId !== undefined).reverse();
  return Promise.all(runs.slice(0, 8).map(async (r) => ({ runId: r.runId, label: r.label, inputs: (await storage.ports.runs.inputs(r.runId)).length })));
}

/** Loads a built-in preset (built in the sim worker) with its default run configuration, as a new run. */
export async function startPresetRun(storage: StorageClient, sim: SimClient, preset: PresetId): Promise<LabRun> {
  if (storage.status().state !== "ready") throw new Error("storage_unavailable: runs need storage (see the status line)");
  const p = PRESETS[preset];
  const built = await sim.buildPreset(preset);
  const version = await presetVersion(storage, p.id, built.document, built.contentHash);
  return startRun(storage, sim, built.document, version, p.runConfig(version), p.label);
}

/** Loads the built-in F1 demo scenario with its default run configuration. */
export function startDemoRun(storage: StorageClient, sim: SimClient): Promise<LabRun> {
  return startPresetRun(storage, sim, "f1-demo");
}

/**
 * The run configuration with only its time mode changed. Lockstep is the default, so it is written by omission:
 * the canonical document (and its runConfigHash) is then the same as a configuration that never named a mode.
 */
export function withTimeMode(runConfig: unknown, mode: "lockstep" | "realtime"): unknown {
  const { timeMode: _old, ...rest } = (runConfig ?? {}) as Record<string, unknown>;
  return mode === "realtime" ? { ...rest, timeMode: "realtime" } : rest;
}

/**
 * Re-runs in another time mode (2026-10-09): the mode is part of the run, so it is never switched mid-run;
 * a new run of the same scenario version starts with the run configuration's `timeMode` changed (new ID, header
 * and hashes).
 */
export function rerunInMode(storage: StorageClient, sim: SimClient, run: LabRun, mode: "lockstep" | "realtime"): Promise<LabRun> {
  return startRun(storage, sim, run.scenario, run.loaded.scenarioVersion, withTimeMode(run.runConfig, mode), run.header.label);
}

/**
 * Runs the same scenario version and run configuration again, headless (ADR-0029): as a new run, in lockstep (a headless run never takes realtime: a run
 * configuration that asks for it is run in lockstep, and the new run's header says so), always recorded with the chosen profile, until `untilS` sim seconds.
 */
export function rerunHeadless(storage: StorageClient, sim: SimClient, run: LabRun, choice = takeHeadlessChoice(), runConfig: unknown = run.runConfig): Promise<LabRun> {
  return startRun(storage, sim, run.scenario, run.loaded.scenarioVersion, withTimeMode(runConfig, "lockstep"), run.header.label, [], choice.recording, { untilS: choice.untilS });
}

/** Re-runs: the same scenario version and run configuration, as a new run (new ID, new header). */
export function rerun(storage: StorageClient, sim: SimClient, run: LabRun): Promise<LabRun> {
  return startRun(storage, sim, run.scenario, run.loaded.scenarioVersion, run.runConfig, run.header.label);
}

export type { RecordingChoice } from "./recording-choice.ts";
