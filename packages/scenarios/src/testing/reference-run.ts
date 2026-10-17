import { runLockstep, ScriptBrain, type Brain, type ScriptStep } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { preparePlanning } from "../assemble/assemble.ts";
import { createRun, type CreatedRun } from "../assemble/run.ts";
import { loadScenario } from "../load.ts";
import { f1EmptyDocument, paintF1Obstacles } from "../presets/f1-demo.ts";
import { resolveRunConfig, type ResolvedRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { AgentSpec, ObjectSpec, ScenarioDocument } from "../schema.ts";

export const REFERENCE_DT_S = 0.1;

/**
 * F1 reference scenario (d7): the F1 demo layout (see presets/f1-demo.ts), painted after loading.
 * Agents: `rover` (UGV), `low` (UGV starting just above critical battery), `scout` (UAV).
 */
export function referenceScenario(): ScenarioDocument {
  return f1EmptyDocument("f1-reference", "F1 reference");
}

/** Default scripts: rover drives behind the wall, then into the closed box; low drives far; scout flies over the wall and back. */
export function referenceScripts(): Record<string, readonly ScriptStep[]> {
  return {
    rover: [
      { name: "goTo", params: { xM: 50, yM: 10 } },
      { name: "goTo", params: { xM: 50, yM: 40 } },
    ],
    low: [{ name: "goTo", params: { xM: 25, yM: 60 } }],
    scout: [
      { name: "takeoff", params: { altitudeM: 20 } },
      { name: "goTo", params: { xM: 50, yM: 20 } },
      { name: "returnToBase", params: {} },
    ],
  };
}

export interface ReferenceRunOptions {
  readonly runConfig?: Partial<RunConfigDocument>;
  readonly scripts?: Record<string, readonly ScriptStep[]>;
  /** Extra minds by agent key; they replace that agent's script. */
  readonly brains?: Record<string, Brain>;
  readonly planningCachesEnabled?: boolean;
  /** Trace recorder (default: a full in-memory buffer). */
  readonly trace?: TraceBuffer;
  /** Build the planning views and graphs before tick 0, as the lab does at load (ADR-0024). */
  readonly preparePlanning?: boolean;
  /** Scenario objects to add (F2: what cameras can see). */
  readonly objects?: readonly ObjectSpec[];
  /** Body fields to set per agent key (merged over the scenario's), e.g. sensors. */
  readonly bodies?: Readonly<Record<string, Record<string, unknown>>>;
  /** Observer-side beliefs-vs-truth metrics (sampled into the trace every `everyS` of sim time). */
  readonly beliefVsTruth?: { readonly everyS?: number };
}

export type ReferenceRun = CreatedRun & {
  readonly trace: TraceBuffer;
  readonly resolved: ResolvedRunConfig;
  /** What `preparePlanning` built, when it ran. */
  readonly prepared?: { readonly views: number; readonly graphs: number };
};

export function buildReferenceRun(o: ReferenceRunOptions = {}): ReferenceRun {
  const base = referenceScenario();
  const doc: ScenarioDocument = {
    ...base,
    ...(o.objects ? { objects: [...o.objects] } : {}),
    agents: base.agents.map((a) => (a.key !== undefined && o.bodies?.[a.key] ? ({ ...a, body: { ...a.body, ...o.bodies[a.key] } } as AgentSpec) : a)),
  };
  const loaded = loadScenario(doc);
  if (!loaded.ok) throw new Error(loaded.error.message);
  paintF1Obstacles(loaded.value.grid);
  // F1 reference run: `ideal` agents unless the caller says otherwise (ADR-0028 addition of 2026-10-09).
  const resolved = resolveRunConfig(
    { schemaVersion: 0, scenario: { id: "f1-reference", version: 1 }, beliefs: { default: { init: "ideal" } }, ...o.runConfig },
    { loaded: loaded.value, version: 1 },
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = o.trace ?? new TraceBuffer("run-000001", () => 0, 1_000_000);
  const brains: Record<string, Brain> = {};
  for (const [key, steps] of Object.entries(o.scripts ?? referenceScripts())) brains[key] = new ScriptBrain(`script-${key}`, steps);
  Object.assign(brains, o.brains);
  const run = createRun(loaded.value, resolved.value, trace, {
    dtS: REFERENCE_DT_S,
    brains,
    ...(o.beliefVsTruth ? { beliefVsTruth: o.beliefVsTruth } : {}),
    ...(o.planningCachesEnabled === undefined ? {} : { planningCachesEnabled: o.planningCachesEnabled }),
  });
  if (!o.preparePlanning) return { ...run, trace, resolved: resolved.value };
  const prepared = preparePlanning(run, resolved.value);
  if (!prepared.ok) throw new Error(prepared.error.message);
  return { ...run, trace, resolved: resolved.value, prepared: prepared.value };
}

export const REFERENCE_TICKS = 3000;

/** Runs the reference scenario in lockstep; returns the final state hash and one hash every 100 ticks. */
export async function runReference(o: ReferenceRunOptions = {}, ticks = REFERENCE_TICKS): Promise<{ readonly hash: string; readonly checkpoints: readonly string[]; readonly run: ReturnType<typeof buildReferenceRun> }> {
  const run = buildReferenceRun(o);
  const checkpoints: string[] = [];
  for (let done = 0; done < ticks; done += 100) {
    await runLockstep(run.world, run.scheduler, Math.min(100, ticks - done));
    checkpoints.push(run.world.stateHash);
  }
  return { hash: run.world.stateHash, checkpoints, run };
}
