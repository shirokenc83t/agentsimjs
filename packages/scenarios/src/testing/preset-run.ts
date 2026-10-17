import { ScriptBrain, type Brain, type DecisionEnvelope, type DecisionRequest, type ScriptStep, type TimerOp } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { createRun } from "../assemble/run.ts";
import { loadScenario } from "../load.ts";
import { f1DemoRunConfig, f1DemoScenario } from "../presets/f1-demo.ts";
import { F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2PriorReferenceScenario, f2PriorRunConfig, f2RunConfig, f2TwentyAgentsScenario } from "../presets/f2-presets.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { AgentSpec, ScenarioDocument } from "../schema.ts";
import type { ReferenceRun } from "./reference-run.ts";

// Runs of the shipped presets for the restore tests (F3a M1, T-003): the F1 demo, the F2 discovery demo, the 20-agent
// sensing demo and the 1 km² prior-map world, with ScriptBrains and a run configuration patched per test.

export const PRESET_DT_S = 0.1;

export type PresetId = "f1-demo" | "f2-discovery" | "f2-20-agents" | "f2-prior-1km";

interface PresetDef {
  readonly scenario: () => ScenarioDocument;
  readonly runConfig: (version: number) => RunConfigDocument;
}

const PRESETS: Readonly<Record<PresetId, PresetDef>> = {
  "f1-demo": { scenario: f1DemoScenario, runConfig: f1DemoRunConfig },
  "f2-discovery": { scenario: f2DiscoveryScenario, runConfig: (v) => f2RunConfig(F2_DISCOVERY_ID, v) },
  "f2-20-agents": { scenario: f2TwentyAgentsScenario, runConfig: (v) => f2RunConfig(F2_TWENTY_AGENTS_ID, v) },
  "f2-prior-1km": { scenario: f2PriorReferenceScenario, runConfig: f2PriorRunConfig },
};

/**
 * A ScriptBrain that also sets and cancels timers, as a pure function of the request (so its only state is the script's
 * cursor, which a restore puts back): on `start` it sets `watchdog` (4 s) and `tick` (1.5 s); every `tick` timer sets
 * `tick` again; a completed action cancels `watchdog` while it is still active. It exercises timers and the decision
 * requests they cause.
 */
export class TimedScriptBrain extends ScriptBrain {
  override async decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    const env = await super.decide(req);
    const timers: TimerOp[] = [];
    for (const e of req.events) {
      if (e.kind === "start") timers.push({ op: "set", tag: "watchdog", delayS: 4 }, { op: "set", tag: "tick", delayS: 1.5 });
      else if (e.kind === "timer" && e.tag === "tick") timers.push({ op: "set", tag: "tick", delayS: 1.5 });
      else if (e.kind === "actionCompleted" && req.self.timers.some((t) => t.tag === "watchdog")) timers.push({ op: "cancel", tag: "watchdog" });
    }
    return timers.length > 0 ? { ...env, timers } : env;
  }
}

export interface PresetRunOptions {
  readonly preset: PresetId;
  /** The script of each agent, by key. */
  readonly scripts: Readonly<Record<string, readonly ScriptStep[]>>;
  /** Keys of the agents whose brain is a `TimedScriptBrain` (timers). */
  readonly timed?: readonly string[];
  /** Fields merged over the preset's default run configuration. */
  readonly runConfig?: Partial<RunConfigDocument>;
  /** Body fields merged over the scenario's, by agent key (e.g. a faster vehicle). */
  readonly bodies?: Readonly<Record<string, Record<string, unknown>>>;
  /** Observer-side beliefs-vs-truth samples every `everyS` of sim time. */
  readonly beliefVsTruth?: { readonly everyS?: number };
  /** Trace buffer capacity (default: large enough that nothing is dropped). */
  readonly traceCapacity?: number;
}

/** What a run is built as: with genesis (the ordinary run), or as the target of a restore (no start events, asks or config records). */
export type RunMode = "genesis" | "restore-target";

/**
 * Builds a run of a preset. `genesis` is the ordinary run. `restore-target` is a freshly assembled run that skips genesis
 * (T-004's no-genesis World path, T-006's composition): until they exist it throws, so the restore tests are skipped.
 */
export function buildPresetRun(o: PresetRunOptions, mode: RunMode = "genesis"): ReferenceRun {
  if (mode === "restore-target") throw new Error("the no-genesis construction path of a run arrives with T-004 and T-006");
  const def = PRESETS[o.preset];
  const base = def.scenario();
  const doc: ScenarioDocument = {
    ...base,
    agents: base.agents.map((a) => (a.key !== undefined && o.bodies?.[a.key] ? ({ ...a, body: { ...a.body, ...o.bodies[a.key] } } as AgentSpec) : a)),
  };
  const loaded = loadScenario(doc);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const resolved = resolveRunConfig({ ...def.runConfig(1), ...o.runConfig }, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, o.traceCapacity ?? 5_000_000);
  const timed = new Set(o.timed ?? []);
  const brains: Record<string, Brain> = {};
  for (const [key, steps] of Object.entries(o.scripts)) brains[key] = timed.has(key) ? new TimedScriptBrain(`script-${key}`, steps) : new ScriptBrain(`script-${key}`, steps);
  const run = createRun(loaded.value, resolved.value, trace, { dtS: PRESET_DT_S, brains, ...(o.beliefVsTruth ? { beliefVsTruth: o.beliefVsTruth } : {}) });
  return { ...run, trace, resolved: resolved.value };
}
