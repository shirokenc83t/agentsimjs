import { PlanningService, type PrepareTarget } from "@agentsim/algorithms";
import { ActionRuntime, defaultReflexes, type CodedError, type Reflex, type Result, type SimAgent } from "@agentsim/core";
import { applyPrior, BeliefGrid, missionOf, type GridSpace } from "@agentsim/spatial";
import type { TraceBuffer } from "@agentsim/trace";
import type { ResolvedUavBody, ResolvedUgvBody } from "../body-defaults.ts";
import type { LoadedScenario } from "../load.ts";
import { toPlanningConfig, type ResolvedRunConfig } from "../run-config/resolve.ts";
import { traversalFor } from "../traversal.ts";
import { GridSpatialAdapter, PlanningServiceAdapter, TraceBufferSink, toolsSchemaCapabilities } from "./adapters.ts";
import { SensingService } from "./sensing.ts";
import { MindViewService } from "./mind-view.ts";
import { TopologyService } from "./topology.ts";

export interface AssembleOptions {
  /** Simulation step (seconds). */
  readonly dtS: number;
  /** Disable planning caches (determinism tests: results must not change, ADR-0024). */
  readonly planningCachesEnabled?: boolean;
  /** Always-on reflexes (default: the F1 set: geofence, obstacle, critical battery). */
  readonly reflexes?: readonly Reflex[];
  /**
   * Genesis (default true): the `config` records of every agent at sim time 0, and (`createRun`) the `start` events and first
   * decision requests. `false` assembles the target of a restore (F3a M1): none of it is written, and `restoreRun`
   * puts the snapshot's state in place.
   */
  readonly genesis?: boolean;
}

/** The runtime pieces of one run, wired to the ground truth. */
export interface AssembledRun {
  /** Agents in ID order, with their effective (resolved) bodies. */
  readonly agents: readonly SimAgent[];
  readonly runtime: ActionRuntime;
  readonly planner: PlanningServiceAdapter;
  readonly spatial: GridSpatialAdapter;
  /** Sensors and beliefs (F2): the world's sensing phase, the reflex's proximity readings, contact bumps. */
  readonly sensing: SensingService;
  /** Each agent's topological layer (ADR-0039), updated after sensing. */
  readonly topology: TopologyService;
  /** The beliefs and space parts of a decision request (ADR-0005 addition of 2026-10-11). */
  readonly mindView: MindViewService;
  /**
   * Each non-ideal agent's planning map and the ground truth, for the researcher's strategy sandbox (ADR-0037 seventh
   * addition, item 16), which copies the former and reads the latter. Nothing in a run reads them through this.
   */
  readonly beliefGrids: ReadonlyMap<string, BeliefGrid>;
  readonly truthGrid: GridSpace;
}

/**
 * Wires the core action runtime to the spatial model, the planning service, tools-schema and the trace
 * (F1 d5). This module is the single place where those packages meet: core stays dependency-free and
 * talks only to its ports; everything here is adaptation, no simulation logic. The world loop (d7) drives
 * the result: planning phase (`planner.advance`), then `runtime.tick` per agent in ID order.
 */
export function assembleRun(loaded: LoadedScenario, resolved: ResolvedRunConfig, trace: TraceBuffer, opts: AssembleOptions): AssembledRun {
  const spatial = new GridSpatialAdapter(loaded.grid);
  const sink = new TraceBufferSink(trace);
  if (opts.genesis !== false) traceConfigs(resolved, trace);
  const byId = new Map(loaded.agents.map((a) => [a.id, a]));
  const agents: SimAgent[] = resolved.agents.map((cfg) => {
    const a = byId.get(cfg.agentId);
    if (!a) throw new Error(`resolved agent ${cfg.agentId} is not in the scenario`);
    const common = {
      id: a.id,
      ...(a.key === undefined ? {} : { key: a.key }),
      ...(a.base === undefined ? {} : { base: a.base }),
      odometerM: 0,
    };
    if (cfg.kind === "ugv") {
      const b = cfg.body as ResolvedUgvBody;
      return { ...common, kind: "ugv", body: b, battery: { soc: b.battery.initialSoc }, state: { x: a.start.xM, y: a.start.yM, heading: a.start.headingRad, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 } };
    }
    const b = cfg.body as ResolvedUavBody;
    return {
      ...common,
      kind: "uav",
      body: b,
      battery: { soc: b.battery.initialSoc },
      state: { x: a.start.xM, y: a.start.yM, z: a.start.zM, heading: a.start.headingRad, airborne: a.start.airborne, lastStepM: 0 },
    };
  });
  // Beliefs (ADR-0028 addition of 2026-10-09): `ideal` agents plan on the ground truth and their sensing does not
  // update their map; every other agent plans on its own belief grid, built from mission data only.
  const ideal = new Set(resolved.agents.filter((a) => a.beliefs.idealized).map((a) => a.agentId));
  const sensing = new SensingService(loaded.grid, agents, loaded.objects, resolved.seed, opts.dtS, sink, ideal);
  const mission = missionOf(loaded.grid);
  const beliefGrids = new Map<string, BeliefGrid>();
  const priors = new Map(loaded.priors.map((p) => [p.id, p]));
  for (const cfg of resolved.agents) {
    if (cfg.beliefs.idealized) continue;
    const belief = sensing.belief(cfg.agentId);
    // `prior` agents start from the scenario's map (resolution checked that it exists).
    const prior = typeof cfg.beliefs.init === "object" ? priors.get(cfg.beliefs.init.prior) : undefined;
    if (prior) applyPrior(belief, prior);
    beliefGrids.set(cfg.agentId, new BeliefGrid(mission, belief, prior));
  }
  const service = new PlanningService(loaded.grid, { cachesEnabled: opts.planningCachesEnabled ?? true, mapFor: (key) => beliefGrids.get(key) });
  const planner = new PlanningServiceAdapter(service, resolved.agents, spatial, { sink, dtS: opts.dtS }, beliefGrids);
  // Topology over each agent's own map; its frontier groups and unreachable marks serve explore and goTo.
  const positions = new Map(agents.map((a) => [a.id, a.state]));
  const topology = new TopologyService(
    resolved,
    (id) => beliefGrids.get(id) ?? loaded.grid,
    (id) => planner.liveView(id),
    { sink, dtS: opts.dtS },
    (id) => {
      const st = positions.get(id);
      return st ? { xM: st.x, yM: st.y } : undefined;
    },
  );
  const runtime = new ActionRuntime(
    {
      planner,
      spatial,
      capabilities: toolsSchemaCapabilities,
      trace: sink,
      reflexes: opts.reflexes ?? defaultReflexes(),
      proximity: sensing,
      contact: sensing,
      frontiers: topology,
    },
    opts.dtS,
  );
  const mindView = new MindViewService(agents, sensing, topology, planner);
  return { agents, runtime, planner, spatial, sensing, topology, mindView, beliefGrids, truthGrid: loaded.grid };
}

/**
 * One `config` record per agent at sim time 0, in agent-ID order (ADR-0028; form from its addition of 2026-10-10):
 * kind `lifecycle`, `op: "config"`, from `<agent>/config`, with the effective configuration resolved for this run
 * and the level that supplied each part. `ideal` agents are labelled (`beliefs.idealized: true`). The log filter
 * finds them by source, `<agent>/config` or, for every agent, the owner wildcard (docs/ui/UI-SPEC.md §5.2).
 */
export function traceConfigs(resolved: ResolvedRunConfig, trace: TraceBuffer): void {
  for (const a of resolved.agents) {
    trace.for(`${a.agentId}/config`).append({
      simTime: 0,
      kind: "lifecycle",
      agentId: a.agentId,
      detail: "full",
      payload: {
        op: "config",
        ...(a.key === undefined ? {} : { key: a.key }),
        planning: a.planning,
        planningSources: a.planningSources,
        body: a.body,
        beliefs: a.beliefs,
        beliefsSource: a.beliefsSource,
        topology: a.topology,
        ...(a.mind === undefined ? {} : { mind: a.mind }),
        ...(a.s2 === undefined ? {} : { mindS2: a.s2 }),
      },
    });
  }
}

/**
 * Every agent's sensors read at most once per tick: a sensor whose rate exceeds the run's tick rate is an error
 * (`sensor_rate_above_tick_rate`, ADR-0012 addition of 2026-10-09), never silently capped.
 */
export function checkSensorRates(resolved: ResolvedRunConfig, dtS: number): Result<undefined, CodedError<"sensor_rate_above_tick_rate">> {
  const tickHz = 1 / dtS;
  for (const a of resolved.agents) {
    for (const s of (a.body as ResolvedUavBody | ResolvedUgvBody).sensors) {
      if (s.rateHz > tickHz + 1e-9) {
        return { ok: false, error: { code: "sensor_rate_above_tick_rate", message: `${a.agentId} sensor "${s.id}" reads at ${s.rateHz} Hz, above the run's tick rate of ${tickHz} Hz` } };
      }
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The abstract range sensor localizes hits at cell resolution (ADR-0012 clarification of 2026-10-10): range noise
 * affects free-space carving and detection, not the occupied cell. That holds only for noise small relative to a
 * cell, so a range sensor with `rangeSigmaM` above a quarter of the grid resolution is an error
 * (`sensor_noise_above_cell`). A measurement-only update mode for noisy-perception studies is planned (phase FE).
 */
export function checkSensorNoise(resolved: ResolvedRunConfig, resolutionM: number): Result<undefined, CodedError<"sensor_noise_above_cell">> {
  for (const a of resolved.agents) {
    for (const s of (a.body as ResolvedUavBody | ResolvedUgvBody).sensors) {
      if (s.type !== "camera" && s.rangeSigmaM > resolutionM / 4 + 1e-12) {
        return {
          ok: false,
          error: { code: "sensor_noise_above_cell", message: `${a.agentId} sensor "${s.id}" has range noise σ ${s.rangeSigmaM} m, above a quarter of the ${resolutionM} m cell` },
        };
      }
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The planning views each agent starts with: its traversal (UAVs at their body's cruise altitude) under its
 * effective planning configuration. Queries at other altitudes, or after a runtime configuration change,
 * still build their view on first use (ADR-0024).
 */
export function planningTargets(resolved: ResolvedRunConfig): (PrepareTarget & { readonly agentId: string })[] {
  // Belief agents plan on their own map, keyed by agent ID (the same key their queries use).
  return resolved.agents.map((cfg) => ({
    agentId: cfg.agentId,
    traversal: traversalFor(cfg),
    config: toPlanningConfig(cfg),
    ...(cfg.beliefs.idealized ? {} : { mapKey: cfg.agentId }),
  }));
}

/**
 * Builds every agent's starting planning views and HPA* graphs before tick 0 (ADR-0024 "at scenario load").
 * Wall time only: the run's results are the same as building them on first use.
 */
export function preparePlanning(
  run: AssembledRun,
  resolved: ResolvedRunConfig,
  onProgress?: (done: number, total: number) => void,
): Result<{ views: number; graphs: number }, CodedError> {
  return run.planner.service.prepare(planningTargets(resolved), onProgress);
}
