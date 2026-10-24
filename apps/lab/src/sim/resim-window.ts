import { err, ok, type CodedError, type Result } from "@agentsim/core";
import { Scheduler } from "@agentsim/core";
import type { StoredRunInput } from "@agentsim/storage";
import { RunRecorder, type DerivedRun, type RecorderBatch, type RecorderItem, type RecordingProfile } from "@agentsim/trace";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { MAX_WINDOW_S, unresolvedReferences, type UnresolvedReferences } from "./resim-refs.ts";
import { SCENARIO_DT_S } from "./sim-constants.ts";
import { RunRecording } from "./run-recording.ts";

// Re-simulation of a window (ADR-0035 section 3 and its addition of 2026-10-17, item 10): a window [t0, t1] of a recorded run is executed again from the last snapshot at or
// before it, with a recording profile of its own (more detail), into a derived run. Nothing of the parent changes. The inputs that come from outside the simulator
// (today the world-scope commands of the run inputs) are taken from the record, never recomputed. At every checkpoint the parent recorded the state hash of the
// re-execution is compared with the parent's: the first that differs makes the derived run divergent (a determinism bug, or an input that is missing), otherwise it matches.
//
// This module is the execution, pure over what it is given (the documents, the snapshot with a way to read its sections, the inputs, the parent's checkpoints) so that
// it runs in a worker, in a test and over a fixture alike. Reading the parent from storage and writing the derived run to it are `resim-controller.ts`.

/** The state hash the parent recorded at a tick (a checkpoint record's payload). */
export interface RecordedCheckpoint {
  readonly tick: number;
  readonly stateHash: string;
}

export interface ResimWindowRequest {
  /** The derived run's ID (allocated by the caller): the trace it writes is its own. */
  readonly runId: string;
  readonly scenario: unknown;
  readonly scenarioVersion: number;
  /** The parent's run configuration, as the parent's header holds it. */
  readonly runConfig: unknown;
  /** The parent's run inputs, in input order (all of them: the ones the snapshot carried are told apart by their IDs). */
  readonly inputs: readonly StoredRunInput[];
  readonly window: { readonly t0S: number; readonly t1S: number };
  readonly profile: RecordingProfile;
  /** The last snapshot of the parent at or before the window's start tick; none means the window starts at the run's start. */
  readonly snapshot?: { readonly tick: number; readonly bytes: Uint8Array; readonly resolve: (hash: string) => Uint8Array | undefined };
  /** The parent's checkpoints, any order; those inside the re-executed span are compared. */
  readonly checkpoints: readonly RecordedCheckpoint[];
  readonly parentRunId: string;
  readonly nowWallMs: () => number;
}

export interface ResimWindowResult {
  /** What the derived run says of itself; `copies` is 0 here and is filled in when the references are resolved. */
  readonly derived: DerivedRun;
  /** What the recorder handed over, profile applied, in order: batches of records and the snapshot and belief-frame items they refer to. */
  readonly batches: readonly RecorderBatch[];
  readonly items: readonly RecorderItem[];
  readonly unresolved: UnresolvedReferences;
}

export type ResimError = CodedError<
  "window_invalid" | "window_too_long" | "scenario_invalid" | "snapshot_not_restorable" | "input_mismatch" | "run_failed"
>;

/**
 * Executes the window. Returns an error for a request that cannot be run (a window that does not run forward, too long, a scenario or snapshot that does not
 * open, an input that does not reproduce its recorded ID); a divergence is a result, not an error.
 */
export function resimulateWindow(req: ResimWindowRequest): Result<ResimWindowResult, ResimError> {
  const { t0S, t1S } = req.window;
  if (!(Number.isFinite(t0S) && Number.isFinite(t1S)) || t0S < 0 || t1S < t0S) return err({ code: "window_invalid", message: `the window [${t0S}, ${t1S}] s does not run forward` });
  if (t1S - t0S > MAX_WINDOW_S) return err({ code: "window_too_long", message: `a window of ${(t1S - t0S).toFixed(1)} s is longer than ${MAX_WINDOW_S} s` });
  const dt = SCENARIO_DT_S;
  const endTick = Math.max(1, Math.round(t1S / dt));
  // The window's recording starts at the state just before its first tick, so that what the first tick emits is in it.
  const startTick = Math.max(0, Math.round(t0S / dt) - 1);
  if (startTick >= endTick) return err({ code: "window_invalid", message: "the window holds no tick" });
  // From the run's start the run is built with its genesis (the records of tick 0 come with it); from a later snapshot it is restored.
  const snap = req.snapshot && req.snapshot.tick > 0 && req.snapshot.tick <= startTick ? req.snapshot : undefined;

  const loaded = ScenarioHostedWorld.load(
    { runId: req.runId, scenario: req.scenario, scenarioVersion: req.scenarioVersion, runConfig: req.runConfig },
    req.nowWallMs,
    snap ? { restore: { bytes: snap.bytes, resolve: snap.resolve } } : {},
  );
  if (!loaded.ok) return err({ code: loaded.error.code === "snapshot_not_restorable" ? "snapshot_not_restorable" : "scenario_invalid", message: loaded.error.message });
  const world = loaded.value;
  if (snap && world.tick !== snap.tick) return err({ code: "snapshot_not_restorable", message: `the snapshot is of tick ${snap.tick}, the restored run is at tick ${world.tick}` });

  // The inputs the snapshot does not carry are applied again, at their recorded ticks and in their recorded order (a list with an input missing is applied as it is: the
  // checkpoints say whether the run is still the parent's).
  const carried = new Set(world.inputs.map((i) => i.inputId));
  for (const i of req.inputs) {
    if (carried.has(i.inputId) || i.tick > endTick) continue;
    const r = world.inject({ agentId: i.agentId, name: i.name, params: i.params }, i.tick);
    if (!r.ok) return err({ code: "input_mismatch", message: `input ${i.inputId} (${i.name} at tick ${i.tick}) cannot be applied again: ${r.error.message}` });
  }

  const wanted = new Map(req.checkpoints.map((c) => [c.tick, c.stateHash]));
  let checked = 0;
  let divergence: DerivedRun["divergence"];
  const compare = () => {
    const expected = wanted.get(world.tick);
    if (expected === undefined) return;
    checked++;
    if (divergence === undefined && world.stateHash !== expected) divergence = { tick: world.tick, expected, actual: world.stateHash };
  };
  if (world.tick > 0) compare(); // the state a restore starts from is the snapshot's own (checked by the restore), and a recorded checkpoint at that tick

  const scheduler = new Scheduler(world, world.dtS);
  scheduler.clock.setTick(world.tick); // a restored run is at its snapshot's tick: its clock is too
  const batches: RecorderBatch[] = [];
  const items: RecorderItem[] = [];
  try {
    // From the snapshot to the start of the window nothing is recorded.
    while (world.tick < startTick) {
      scheduler.step();
      compare();
    }
    // From there the run is recorded as any recorded run is, under the profile chosen for the window.
    const recorder = new RunRecorder({
      buffer: world.trace,
      profile: req.profile,
      send: (b) => batches.push(b),
      sendItem: (i) => items.push(i),
      fromSeq: world.trace.nextSeq,
    });
    const recording = new RunRecording(world.recordingTarget(), recorder, req.profile);
    world.setTickHook(() => recording.afterTick());
    recording.start();
    recorder.headerStored();
    recorder.collect(world.tick, world.simTimeS);
    // Everything handed over is kept here, so the cache is told it is saved: it never has to forget what it was holding.
    const saved = () => recorder.persisted({ runId: req.runId, throughSeq: world.trace.nextSeq - 1, tick: world.tick, simTimeS: world.simTimeS });
    saved();
    while (world.tick < endTick) {
      scheduler.step();
      compare();
      recorder.collect(world.tick, world.simTimeS);
      saved();
    }
    recording.end();
    recorder.collect(world.tick, world.simTimeS);
    saved();
  } catch (e) {
    return err({ code: "run_failed", message: e instanceof Error ? e.message : String(e) });
  }

  const records = batches.flatMap((b) => b.records);
  return ok({
    derived: {
      parentRunId: req.parentRunId,
      t0S,
      t1S,
      startTick,
      endTick,
      status: divergence === undefined ? "matches" : "divergent",
      checkpointsChecked: checked,
      ...(divergence === undefined ? {} : { divergence }),
      copies: 0,
    },
    batches,
    items,
    unresolved: unresolvedReferences(records),
  });
}

export { completeReferences, copiesOf, MAX_WINDOW_S, unresolvedReferences, type UnresolvedReferences } from "./resim-refs.ts";
