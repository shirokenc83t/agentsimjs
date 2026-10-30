import { Scheduler, SequenceBrain, World, type AgentEvent, type Brain } from "@agentsim/core";
import { LlmBrain, type InferenceQueue, type LlmBrainHooks, type MindCache, type Prices, type ProviderPort } from "@agentsim/minds";
import { TRACE_SCHEMA_VERSION, type RunHeader, type TraceBuffer } from "@agentsim/trace";
import type { LoadedScenario } from "../load.ts";
import type { ResolvedRunConfig } from "../run-config/resolve.ts";
import { assembleRun, type AssembleOptions, type AssembledRun } from "./assemble.ts";
import { TraceBufferSink } from "./adapters.ts";
import { BeliefVsTruth } from "./belief-vs-truth.ts";

/**
 * What the System 2 minds of a run need besides its configuration (F4): the providers by id (the lab hands the adapter its Settings entry gives; a test hands a scripted one), the response cache, the run's
 * inference queue, the prices of a provider entry when the user entered some, and the host's hooks (the limit notices and the pause). None of it is configuration, so none of it is in a hash.
 */
export interface MindsOptions {
  readonly providers: (providerId: string) => ProviderPort | undefined;
  readonly cache: MindCache;
  readonly queue?: InferenceQueue;
  readonly prices?: (providerId: string) => Prices | undefined;
  readonly now?: () => number;
  /** The hooks of one agent's mind (the pause at a limit is per agent). */
  readonly hooks?: (agentId: string) => LlmBrainHooks | undefined;
  /** A `replay-then-live` run made its first call that missed the cache, at this tick (the run is not reproducible from it). */
  readonly onNotReproducible?: (agentId: string, tick: number) => void;
}

export interface CreateRunOptions extends AssembleOptions {
  /** The System 2 minds' providers, cache and hooks: needed when the run configuration gives an agent an `s2` mind. */
  readonly minds?: MindsOptions;
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
  // The minds the run configuration gives (a mission, ADR-0036 addition of 2026-10-26): a brain of the options for the same agent would be a second mind.
  for (const a of resolved.agents) {
    if (a.mind === undefined) continue;
    if (brains.has(a.agentId)) throw new Error(`${a.agentId} has a mind in the run configuration and a brain in the options`);
    brains.set(a.agentId, new SequenceBrain(`mission-${a.agentId}`, a.mind.s1.script.params.steps));
  }
  // The System 2 minds the run configuration gives (F4): an LLM mind over the provider and the cache the host gave.
  for (const a of resolved.agents) {
    if (a.s2 === undefined) continue;
    if (brains.has(a.agentId)) throw new Error(`${a.agentId} has a mind in the run configuration and a brain in the options`);
    const m = opts.minds;
    const provider = m?.providers(a.s2.provider.id);
    if (m === undefined || provider === undefined) throw new Error(`provider_not_configured: ${a.agentId}'s mind uses provider "${a.s2.provider.id}", which the host did not give`);
    const prices = m.prices?.(a.s2.provider.id);
    const hooks = m.hooks?.(a.agentId);
    brains.set(
      a.agentId,
      new LlmBrain({
        id: `llm-${a.agentId}`,
        effective: a.s2.effective,
        template: a.s2.template.content,
        mission: a.s2.mission,
        provider,
        cache: m.cache,
        mode: resolved.mindsRunMode,
        ...(m.now === undefined ? {} : { now: m.now }),
        ...(prices === undefined ? {} : { prices }),
        ...(hooks === undefined ? {} : { hooks }),
        ...(m.queue === undefined ? {} : { queue: m.queue }),
        ...(m.onNotReproducible === undefined ? {} : { onNotReproducible: (tick: number) => m.onNotReproducible?.(a.agentId, tick) }),
      }),
    );
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
    compute: assembled.compute,
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
    ...(r.mindsRunMode !== "live" || r.agents.some((a) => a.s2 !== undefined) ? { mindsRunMode: r.mindsRunMode } : {}),
  };
}

/** Agents with `ideal` beliefs as resolved for this run, sorted (ADR-0028 addition of 2026-10-10: the run header records them). */
export function idealAgentsOf(r: ResolvedRunConfig): string[] {
  return r.agents.filter((a) => a.beliefs.idealized).map((a) => a.agentId).sort();
}
