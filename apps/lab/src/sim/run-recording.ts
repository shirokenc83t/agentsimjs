import { encodeValue, readSnapshot, SnapshotWriter, snapshotHash, type SimAgent } from "@agentsim/core";
import { snapshotRun, type SnapshotableRun } from "@agentsim/scenarios";
import type { RecorderFramesItem, RecordingProfile, RunRecorder, TraceBuffer, TraceRecord } from "@agentsim/trace";

// What a recorded run writes besides what its components trace (ADR-0035 addition of 2026-10-17, items 8 and 9; ADR-0029 addition of the
// same date): checkpoint records (the state hash every N ticks), snapshots at the start, every S sim seconds and at a stop, pose samples at
// the profile's rate and at every transition, and belief-map keyframes and deltas. All of it is observation: it reads the run between ticks
// and writes records and items for the recorder; nothing in it changes the run, so a recorded run has the hashes of one that is not.

/** What the recording reads of a run. */
export interface RecordingTarget {
  readonly run: SnapshotableRun;
  readonly trace: TraceBuffer;
  readonly dtS: number;
  /** Agents whose beliefs are the ground truth (`ideal`): they have no belief map of their own to record. */
  readonly idealAgents: ReadonlySet<string>;
}

type SnapshotReason = "start" | "periodic" | "end";
type PoseTrigger = "start" | "rate" | "action-start" | "action-end" | "reflex" | "lifecycle";

interface FramesDraft {
  frames: RecorderFramesItem["frames"][number][];
  blobs: { id: string; bytes: Uint8Array }[];
}

export class RunRecording {
  private readonly run: SnapshotableRun;
  private readonly trace: TraceBuffer;
  private readonly runId: string;
  private readonly checkpointEveryTicks: number;
  private readonly snapshotEveryTicks: number;
  private readonly keyframeEveryTicks: number;
  private readonly beliefFrames: boolean;
  private readonly agents: readonly SimAgent[];
  /** Blobs already handed to the recorder: a section that has not changed is sent once. */
  private readonly sentBlobs = new Set<string>();
  private lastSnapshotTick = -1;
  private lastKeyframeTick = -1;
  private readonly lastBeliefVersion = new Map<string, number>();
  private readonly frameSeq = new Map<string, number>();
  private readonly nextPoseDueS = new Map<string, number>();
  private poseCursor = 0;

  constructor(
    private readonly target: RecordingTarget,
    private readonly recorder: RunRecorder,
    private readonly profile: RecordingProfile,
  ) {
    this.run = target.run;
    this.trace = target.trace;
    this.runId = target.trace.runId;
    this.agents = target.run.agents;
    this.checkpointEveryTicks = profile.checkpoints.everyTicks;
    this.snapshotEveryTicks = Math.max(1, Math.round(profile.checkpoints.snapshotEveryS / target.dtS));
    this.keyframeEveryTicks = Math.max(1, Math.round(profile.channels.beliefs.keyframeEveryS / target.dtS));
    this.beliefFrames = profile.channels.beliefs.level === "chunks";
  }

  private get tick(): number {
    return this.run.world.tick;
  }

  /** The start of the run (after load, before the first step): the first snapshot, keyframes, checkpoint and pose samples. */
  start(): void {
    this.poseCursor = this.trace.nextSeq;
    const snap = this.snapshot("start");
    this.checkpoint(snap?.id);
    this.samplePoses("start");
    this.poseCursor = this.trace.nextSeq;
  }

  /** After each tick, between ticks: transitions and rate-based pose samples, deltas, then keyframe, snapshot and checkpoint when due. */
  afterTick(): void {
    const tick = this.tick;
    const transition = this.transitionsSince();
    this.samplePoses("rate", transition);
    const snapshotDue = tick % this.snapshotEveryTicks === 0;
    let snapshotId: string | undefined;
    const draft: FramesDraft = { frames: [], blobs: [] };
    if (snapshotDue) snapshotId = this.snapshot("periodic", draft)?.id;
    else if (this.beliefFrames) this.keyframesAndDeltas(draft);
    this.flushFrames(draft);
    if (snapshotDue || tick % this.checkpointEveryTicks === 0) this.checkpoint(snapshotId);
    this.poseCursor = this.trace.nextSeq;
  }

  /** The run stops (a pause, a step ends, another run replaces it): a snapshot, unless the run is where the last one was taken. */
  end(): void {
    if (this.tick === this.lastSnapshotTick) return;
    const draft: FramesDraft = { frames: [], blobs: [] };
    const snap = this.snapshot("end", draft);
    this.flushFrames(draft);
    this.checkpoint(snap?.id);
    this.poseCursor = this.trace.nextSeq;
  }

  // ---- checkpoints ------------------------------------------------------------------------------------------------------

  private checkpoint(snapshotId: string | undefined): void {
    this.trace.for("world/sim").append({
      simTime: this.run.world.simTimeS,
      kind: "event",
      detail: "full",
      payload: { op: "checkpoint", tick: this.tick, stateHash: this.run.world.stateHash, ...(snapshotId === undefined ? {} : { snapshotHash: snapshotId }) },
    });
  }

  // ---- snapshots ----------------------------------------------------------------------------------------------------------

  /**
   * Takes a snapshot of the run (its belief maps as sections outside the container), writes its `snapshot` record, and hands the container
   * and the sections not yet sent to the recorder. A snapshot tick is also a keyframe tick: the belief sections are the keyframe blobs.
   */
  private snapshot(reason: SnapshotReason, draft?: FramesDraft): { id: string } | undefined {
    const external = new Map<string, Uint8Array>();
    const bytes = snapshotRun(this.run, { external: (id, b) => external.set(id, b) });
    const id = snapshotHash(bytes);
    const tick = this.tick;
    const record = this.trace.for("world/sim").append({
      simTime: this.run.world.simTimeS,
      kind: "snapshot",
      detail: "full",
      worldRef: id,
      payload: { op: "snapshot", reason, tick, id, bytes: bytes.length },
    });
    const fresh = [...external].filter(([h]) => !this.sentBlobs.has(h)).map(([h, b]) => ({ id: h, bytes: b }));
    for (const b of fresh) this.sentBlobs.add(b.id);
    this.lastSnapshotTick = tick;
    // The keyframes read the container's root: before it is handed over (the worker may take its buffer with it).
    const own = draft ?? { frames: [], blobs: [] };
    if (this.beliefFrames) this.keyframesFromSnapshot(bytes, own);
    this.recorder.enqueue({ type: "snapshot", runId: this.runId, seq: record.seq, simTimeS: this.run.world.simTimeS, tick, bytes, blobs: fresh });
    if (draft === undefined) this.flushFrames(own); // the frames follow the snapshot: its sections are the keyframes' blobs
    return { id };
  }

  // ---- belief keyframes and deltas ----------------------------------------------------------------------------------------

  private beliefAgents(): SimAgent[] {
    return this.agents.filter((a) => !this.target.idealAgents.has(a.id));
  }

  private nextSeq(agentId: string): number {
    const n = this.frameSeq.get(agentId) ?? 0;
    this.frameSeq.set(agentId, n + 1);
    return n;
  }

  /** The belief sections of a snapshot are keyframes of their agents, by the same content id: stored once for both. */
  private keyframesFromSnapshot(bytes: Uint8Array, draft: FramesDraft): void {
    const root = readSnapshot(bytes).root as { sensing: { agents: readonly { agentId: string; belief: { hash: string } }[] } };
    const byAgent = new Map(root.sensing.agents.map((a) => [a.agentId, a.belief.hash]));
    for (const a of this.beliefAgents()) {
      const blobId = byAgent.get(a.id);
      if (blobId === undefined) continue;
      this.addKeyframe(draft, a.id, blobId);
    }
    this.lastKeyframeTick = this.tick;
  }

  private addKeyframe(draft: FramesDraft, agentId: string, blobId: string): void {
    const belief = this.run.sensing.belief(agentId);
    draft.frames.push({ agentId, seq: this.nextSeq(agentId), tick: this.tick, simTime: this.run.world.simTimeS, kind: "keyframe", chunks: belief.materializedIndices(), blobId });
    this.lastBeliefVersion.set(agentId, belief.version);
  }

  /** A keyframe every K seconds, deltas (the chunks changed since the last frame) at every other sync point. */
  private keyframesAndDeltas(draft: FramesDraft): void {
    if (this.tick - this.lastKeyframeTick >= this.keyframeEveryTicks) {
      for (const a of this.beliefAgents()) {
        const external = new Map<string, Uint8Array>();
        const w = new SnapshotWriter({ external: (id, b) => external.set(id, b) });
        const ref = w.section(this.run.sensing.belief(a.id).snapshot());
        for (const [id, b] of external) {
          if (this.sentBlobs.has(id)) continue;
          this.sentBlobs.add(id);
          draft.blobs.push({ id, bytes: b });
        }
        this.addKeyframe(draft, a.id, ref.hash);
      }
      this.lastKeyframeTick = this.tick;
      return;
    }
    this.deltas(draft);
  }

  private deltas(draft: FramesDraft): void {
    for (const a of this.beliefAgents()) {
      const belief = this.run.sensing.belief(a.id);
      const since = this.lastBeliefVersion.get(a.id) ?? 0;
      if (belief.version === since) continue;
      const changed = belief.chunksChangedSince(since);
      this.lastBeliefVersion.set(a.id, belief.version);
      if (changed.length === 0) continue;
      const data = encodeValue({ chunks: belief.chunksSnapshot(changed) });
      draft.frames.push({ agentId: a.id, seq: this.nextSeq(a.id), tick: this.tick, simTime: this.run.world.simTimeS, kind: "delta", chunks: changed, data });
    }
  }

  private flushFrames(draft: FramesDraft): void {
    if (draft.frames.length === 0 && draft.blobs.length === 0) return;
    this.recorder.enqueue({ type: "frames", runId: this.runId, frames: draft.frames, blobs: draft.blobs });
    draft.frames = [];
    draft.blobs = [];
  }

  // ---- pose samples ---------------------------------------------------------------------------------------------------------

  /** Transitions of the agents in what the tick traced since the last look: an action starts or ends, a reflex, a lifecycle operation. */
  private transitionsSince(): Map<string, PoseTrigger> {
    const out = new Map<string, PoseTrigger>();
    for (const r of this.trace.since(this.poseCursor)) {
      const trigger = triggerOf(r);
      if (trigger && r.agentId !== undefined && !out.has(r.agentId)) out.set(r.agentId, trigger);
    }
    return out;
  }

  private rateHz(a: SimAgent): number {
    const poses = this.profile.channels.poses;
    return poses.perKindRateHz?.[a.kind as "uav" | "ugv" | "ev"] ?? poses.rateHz;
  }

  /** One sample per agent when its next sample is due in sim time, or when it had a transition this tick (never two in one tick). */
  private samplePoses(base: PoseTrigger, transitions: ReadonlyMap<string, PoseTrigger> = new Map()): void {
    const t = this.run.world.simTimeS;
    for (const a of this.agents) {
      const period = 1 / this.rateHz(a);
      const due = this.nextPoseDueS.get(a.id) ?? 0;
      const rateDue = t + 1e-9 >= due;
      const transition = transitions.get(a.id);
      if (!rateDue && !transition) continue;
      if (rateDue) this.nextPoseDueS.set(a.id, (Math.floor((t + 1e-9) / period) + 1) * period);
      const trigger = base === "start" ? "start" : (transition ?? "rate");
      this.trace.for(`${a.id}/body`).append({
        simTime: t,
        kind: "observation",
        agentId: a.id,
        detail: "sampled",
        payload: poseOf(a, this.target.dtS, trigger),
      });
    }
  }
}

function triggerOf(r: TraceRecord): PoseTrigger | undefined {
  const op = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown }).op : undefined;
  if (r.kind === "action" && op === "start") return "action-start";
  if (r.kind === "action" && op === "end") return "action-end";
  if (r.kind === "reflex") return "reflex";
  if (r.kind === "lifecycle" && op !== "config") return "lifecycle";
  return undefined;
}

/** What the Explorer and the Inspector show of an agent: where it is, how it moves, its battery, odometer and whether it flies. */
function poseOf(a: SimAgent, dtS: number, trigger: PoseTrigger) {
  return {
    op: "pose",
    x: a.state.x,
    y: a.state.y,
    z: a.kind === "uav" ? a.state.z : 0,
    heading: a.state.heading,
    speedMps: a.kind === "ugv" ? Math.abs(a.state.speed) : a.state.lastStepM / dtS,
    soc: a.battery.soc,
    odometerM: a.odometerM,
    airborne: a.kind === "uav" && a.state.airborne,
    trigger,
  };
}
