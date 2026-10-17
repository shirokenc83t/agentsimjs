import {
  ScriptBrain,
  SnapshotWriter,
  readSnapshot,
  type SectionRef,
  type ReadSnapshotOptions,
  type RuntimeSnapshot,
  type SnapshotWriterOptions,
  type WorldSnapshot,
} from "@agentsim/core";
import type { TraceBuffer, TraceCursor } from "@agentsim/trace";
import type { PlannerAdapterSnapshot } from "./adapters.ts";
import type { CreatedRun } from "./run.ts";
import type { SensingSnapshot } from "./sensing.ts";
import type { TopologySnapshot } from "./topology.ts";

/** The observer's snapshot, named through the run (ADR-0005: only its own module, its export and `createRun` name the observer's module). */
type ObserverSnapshot = ReturnType<NonNullable<CreatedRun["observer"]>["snapshot"]>;

// The snapshot of a whole run, composed here from the layers' own snapshots (F3a M1, T-006; ADR-0035 addition of 2026-10-17,
// item 8). Core reaches the services only through its ports, so the composition lives in assemble: it takes the world and
// the action runtime from core, the belief maps, sensing, topology, the planner and the observer from the services behind
// the ports, the trace's cursor and the script brains' positions. Each agent's belief map is stored as a content-addressed
// section (D-002 addition 1): an unchanged map is one section however many snapshots refer to it, and the writer's `external`
// option leaves the sections out of the container for the belief keyframe blobs of M2.

/** The format of a run snapshot's root value: the container is `ASNP` (packages/core/src/snapshot/codec.ts), this names what is in it. */
export const RUN_SNAPSHOT_FORMAT = "agentsim-run-1";

/** A run whose parts a snapshot reads: the created run and its trace buffer. */
export interface SnapshotableRun extends CreatedRun {
  readonly trace: TraceBuffer;
}

interface RunSnapshotRoot {
  readonly format: string;
  readonly tick: number;
  readonly simTimeS: number;
  readonly world: WorldSnapshot;
  readonly runtime: RuntimeSnapshot;
  /** Sensing with each agent's belief map replaced by a reference to its section. */
  readonly sensing: Omit<SensingSnapshot, "agents"> & { readonly agents: readonly (Omit<SensingSnapshot["agents"][number], "belief"> & { readonly belief: SectionRef })[] };
  readonly topology: TopologySnapshot;
  readonly planner: PlannerAdapterSnapshot;
  readonly observer: ObserverSnapshot | undefined;
  readonly trace: TraceCursor;
  /** The position of each script brain, by agent ID. */
  readonly brains: readonly { readonly agentId: string; readonly position: number }[];
}

/**
 * The run as snapshot container bytes. Taken between ticks (after a tick's events were collected and its topology updated), of
 * a run that has not failed. External minds are not covered until F4, where the response cache replaces their state: a run with a
 * brain that is not a script refuses.
 */
export function snapshotRun(run: SnapshotableRun, options: SnapshotWriterOptions = {}): Uint8Array {
  const brains = [...run.brains]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([agentId, brain]) => {
      if (!(brain instanceof ScriptBrain)) throw new Error(`cannot snapshot a run whose mind of ${agentId} (${brain.id}) is not a script: external minds are covered by the response cache from F4`);
      return { agentId, position: brain.position };
    });
  const w = new SnapshotWriter(options);
  const sensing = run.sensing.snapshot();
  const root: RunSnapshotRoot = {
    format: RUN_SNAPSHOT_FORMAT,
    tick: run.world.tick,
    simTimeS: run.world.simTimeS,
    world: run.world.snapshot(),
    runtime: run.runtime.snapshot(),
    sensing: { ...sensing, agents: sensing.agents.map(({ belief, ...rest }) => ({ ...rest, belief: w.section(belief) })) },
    topology: run.topology.snapshot(),
    planner: run.planner.snapshot(),
    observer: run.observer?.snapshot(),
    trace: run.trace.cursor(),
    brains,
  };
  return w.finish(root);
}

/**
 * Puts a snapshot into a freshly assembled run that skipped genesis (`createRun` with `genesis: false`), in place. The order
 * matters: the maps and sensing first, then the planner's views (they catch up with the restored maps) and topology, then the
 * planner's queries, the action runtime (a goTo takes the map of its plan from the planner) and last the world, which checks
 * the hash of everything it reads against the snapshot's.
 */
export function restoreRun(target: SnapshotableRun, bytes: Uint8Array, options: ReadSnapshotOptions = {}): void {
  const snap = readSnapshot(bytes, options);
  const root = snap.root as RunSnapshotRoot;
  if (root.format !== RUN_SNAPSHOT_FORMAT) throw new RangeError(`not a run snapshot: format ${String(root.format)}, expected ${RUN_SNAPSHOT_FORMAT}`);
  if (target.trace.all().length > 0) throw new Error("a restore target must have skipped genesis: its trace already holds records");
  if (target.world.tick !== 0) throw new Error("a restore target must be a fresh run");
  const sensing: SensingSnapshot = { ...root.sensing, agents: root.sensing.agents.map((a) => ({ ...a, belief: snap.section(a.belief) as SensingSnapshot["agents"][number]["belief"] })) };
  target.sensing.restore(sensing);
  target.planner.syncViews();
  target.topology.restore(root.topology);
  target.planner.restore(root.planner);
  target.observer?.restore(requireObserver(root.observer));
  if (!target.observer && root.observer) throw new RangeError("the snapshot has an observer the run does not");
  target.trace.restoreCursor(root.trace);
  for (const b of root.brains) {
    const brain = target.brains.get(b.agentId);
    if (!(brain instanceof ScriptBrain)) throw new RangeError(`snapshot has a script position for ${b.agentId}, which has no script brain in this run`);
    brain.restorePosition(b.position);
  }
  target.runtime.restore(root.runtime, target.agents);
  target.world.restore(root.world);
  target.scheduler.clock.setTick(root.tick);
}

function requireObserver(o: ObserverSnapshot | undefined): ObserverSnapshot {
  if (!o) throw new RangeError("the run has an observer the snapshot does not");
  return o;
}

/** How a run snapshot's bytes divide: the belief maps (one section each, shared when equal) and everything else. */
export interface SnapshotSize {
  readonly totalBytes: number;
  /** Each agent's belief map section, in agent order; sections stored outside the container count as 0 here and appear in `external`. */
  readonly beliefBytes: readonly { readonly agentId: string; readonly bytes: number }[];
  /** Everything but the inline sections: the world, runtime, services, planner, trace cursor, and the container's own bytes. */
  readonly restBytes: number;
}

/** Measures a run snapshot without decoding its sections. */
export function snapshotSize(bytes: Uint8Array): SnapshotSize {
  const s = readSnapshot(bytes);
  const root = s.root as RunSnapshotRoot;
  const byHash = new Map(s.sections.map((x) => [x.hash, x]));
  const beliefBytes = root.sensing.agents.map((a) => ({ agentId: a.agentId, bytes: byHash.get(a.belief.hash)?.length ?? 0 }));
  const inline = s.sections.reduce((n, x) => n + (x.bytes ? x.length : 0), 0);
  return { totalBytes: bytes.length, beliefBytes, restBytes: bytes.length - inline };
}
