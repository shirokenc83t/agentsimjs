import { Scheduler, World, type AgentEvent, type Brain } from "@agentsim/core";
import { TRACE_SCHEMA_VERSION, type RunHeader, type TraceBuffer } from "@agentsim/trace";
import type { LoadedScenario } from "../load.ts";
import type { ResolvedRunConfig } from "../run-config/resolve.ts";
import { assembleRun, type AssembleOptions, type AssembledRun } from "./assemble.ts";
import { TraceBufferSink } from "./adapters.ts";
import { BeliefVsTruth } from "./belief-vs-truth.ts";

export interface CreateRunOptions extends AssembleOptions {
  /** Minds by agent key (or agent ID for agents without a key). */
  readonly brains?: Readonly<Record<string, Brain>>;
  /**
   * Observer-side beliefs-vs-truth metrics (ADR-0005 addition of 2026-10-11): `everyS` is the sim-time interval of the
   * trace samples (`world/sim`, op `belief-vs-truth`). Off by default: building it labels the ground truth once.
   */
  readonly beliefVsTruth?: { readonly everyS?: number };
}

export interface CreatedRun extends AssembledRun {
  readonly world: World;
  readonly scheduler: Scheduler;
  /** The minds of the run by agent ID (what a snapshot takes the positions of the scripts from). */
  readonly brains: ReadonlyMap<string, Brain>;
  /** Present when `beliefVsTruth` was requested. Not reachable from the world, the brains or the mind view. */
  readonly observer?: BeliefVsTruth;
}

/**
 * A ready-to-step run (F1 d7): the assembled runtime, the world loop over it and a scheduler with the
 * run's fixed step. Drive it with `runLockstep(world, scheduler, n)`.
 */
export function createRun(loaded: LoadedScenario, resolved: ResolvedRunConfig, trace: TraceBuffer, opts: CreateRunOptions): CreatedRun {
  const assembled = assembleRun(loaded, resolved, trace, opts);
  const brains = new Map<string, Brain>();
  for (const [ref, brain] of Object.entries(opts.brains ?? {})) {
    const agent = assembled.agents.find((a) => a.key === ref || a.id === ref);
    if (!agent) throw new Error(`brain for unknown agent "${ref}"`);
    if (brains.has(agent.id)) throw new Error(`two brains for ${agent.id}`);
    brains.set(agent.id, brain);
  }
  const observer = opts.beliefVsTruth
    ? new BeliefVsTruth(loaded.grid, assembled.agents, loaded.objects, assembled.sensing, resolved, new TraceBufferSink(trace), opts.beliefVsTruth.everyS)
    : undefined;
  const world = new World({
    agents: assembled.agents,
    runtime: assembled.runtime,
    planner: assembled.planner,
    trace: new TraceBufferSink(trace),
    brains,
    sensing: senseThenTopology(assembled, observer),
    minDecisionIntervalS: resolved.minDecisionIntervalS,
    mindView: assembled.mindView,
    ...(opts.genesis === false ? { genesis: false } : {}),
  });
  return { ...assembled, world, scheduler: new Scheduler(world, opts.dtS), brains, ...(observer ? { observer } : {}) };
}

/** The world's sensing phase: readings first, then each agent's topological layer from what changed (ADR-0039 §4). */
function senseThenTopology(a: AssembledRun, observer?: BeliefVsTruth): NonNullable<ConstructorParameters<typeof World>[0]["sensing"]> {
  return {
    sense: (tick, simTimeS) => {
      a.sensing.sense(tick, simTimeS);
      // Sync point after sensing (ADR-0024 addition of 2026-10-10), then the topological layer.
      a.planner.syncViews();
      a.topology.update(simTimeS);
      observer?.sample(tick, simTimeS);
    },
    takeEvents: () => [
      ...a.sensing.takeEvents(),
      ...a.topology.takeExhausted().map((agentId): AgentEvent => ({ agentId, event: { kind: "frontierExhausted" } })),
    ],
    hashInto: (h) => {
      a.sensing.hashInto(h);
      a.topology.hashInto(h); // unreachable marks (agent state); nothing when no agent has any
    },
  };
}

/** `<package version>+<short commit>`, with `-dirty` when the working tree had uncommitted changes (ADR-0028). */
export function formatSimulatorVersion(packageVersion: string, commit: string, dirty: boolean): string {
  return `${packageVersion}+${commit}${dirty ? "-dirty" : ""}`;
}

export interface RunHeaderInput {
  readonly runId: string;
  readonly label: string;
  readonly createdAtWallMs: number;
  readonly resolved: ResolvedRunConfig;
  readonly simulatorVersion: string;
}

/** The reproducibility header of a simulated run (ADR-0028): scenario version, run configuration, hashes, simulator. */
export function runHeader(i: RunHeaderInput): RunHeader {
  const r = i.resolved;
  return {
    runId: i.runId,
    schemaVersion: TRACE_SCHEMA_VERSION,
    createdAtWallMs: i.createdAtWallMs,
    label: i.label,
    scenario: r.scenario.id,
    seed: r.seed,
    status: "running",
    scenarioId: r.scenario.id,
    scenarioVersion: r.scenario.version,
    runConfig: r.document,
    runConfigHash: r.runConfigHash,
    effectiveConfigHash: r.effectiveConfigHash,
    simulatorVersion: i.simulatorVersion,
    idealAgents: idealAgentsOf(r),
  };
}

/** Agents with `ideal` beliefs as resolved for this run, sorted (ADR-0028 addition of 2026-10-10: the run header records them). */
export function idealAgentsOf(r: ResolvedRunConfig): string[] {
  return r.agents.filter((a) => a.beliefs.idealized).map((a) => a.agentId).sort();
}
