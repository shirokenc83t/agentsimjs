import { presetStrategy, strategyContentHash, type PlanningStrategy } from "@agentsim/algorithms";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { assembleRun, traceConfigs } from "../assemble/assemble.ts";
import { canonicalJson, hash32Hex } from "../canonical.ts";
import { loadScenario, type LoadedScenario } from "../load.ts";
import type { AgentSpec, ScenarioDocument } from "../schema.ts";
import { canonicalRunConfig, parseRunConfig, parseRunConfigValue, resolveRunConfig, withRuntimeChange } from "./resolve.ts";
import type { RunConfigDocument } from "./schema.ts";

// ADR-0037 (accepted 2026-10-13) and its additions to ADR-0028: a planning entry takes `algorithm` or `strategy`.

function scenarioDoc(agents: AgentSpec[]): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "planners",
    name: "Planners",
    defaultSeed: 11,
    world: { resolutionM: 1, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: { occupancy: { chunks: [] } } },
    zones: [],
    agents,
  };
}
const AGENTS: AgentSpec[] = [
  { kind: "uav", key: "scout", start: { xM: 5, yM: 5, zM: 20 } },
  { kind: "ugv", key: "rover", start: { xM: 6, yM: 6 } },
  { kind: "ugv", start: { xM: 8, yM: 8 } },
];
function loaded(): LoadedScenario {
  const r = loadScenario(scenarioDoc(AGENTS));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const base: RunConfigDocument = { schemaVersion: 0, scenario: { id: "planners", version: 3 } };
const resolve = (doc: RunConfigDocument, opts = {}) => resolveRunConfig(doc, { loaded: loaded(), version: 3 }, opts);
function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function failure(r: { ok: true } | { ok: false; error: { code: string; path?: string; message: string } }) {
  if (r.ok) throw new Error("expected a failure");
  return r.error;
}
const REF = { ref: "astar-then-hpa", version: 1 };
const inline = (root: unknown, id = "mine") => ({ schemaVersion: 0 as const, id, version: 1, root });
const entry = (e: Record<string, unknown>): RunConfigDocument => ({ ...base, planning: { default: e } } as RunConfigDocument);

describe("a planning entry names a strategy (ADR-0037 §4)", () => {
  it("parses a preset reference and an inline document, and rejects shapes that are neither", () => {
    expect(parseRunConfigValue(entry({ strategy: REF })).ok).toBe(true);
    expect(parseRunConfigValue(entry({ strategy: inline({ kind: "algorithm", algorithm: "astar" }) })).ok).toBe(true);
    expect(parseRunConfigValue(entry({ strategy: "astar-only" })).ok).toBe(false);
    expect(parseRunConfigValue(entry({ strategy: { ref: "x" } })).ok).toBe(false);
    expect(parseRunConfigValue(entry({ strategy: { ref: "astar-only", version: 1, extra: 1 } })).ok).toBe(false);
    expect(parseRunConfig(JSON.stringify(entry({ strategy: REF }))).ok).toBe(true);
  });

  it("resolves a preset reference into the agent's planning entry, content included", () => {
    const r = value(resolve(entry({ strategy: REF })));
    const preset = presetStrategy(REF) as PlanningStrategy;
    for (const a of r.agents) {
      expect(a.planning.strategy).toEqual({ id: "astar-then-hpa", version: 1, hash: strategyContentHash(preset), root: preset.root });
      expect(a.planningSources.algorithm).toBe("default");
      // The plain algorithm field is the built-in one, so two ways to the same behavior hash alike.
      expect(a.planning.algorithm).toBe("astar");
    }
  });

  it("resolves an inline strategy the same way", () => {
    const root = { kind: "select", branches: [{ when: "dist.m < 100", then: { kind: "algorithm", algorithm: "astar" } }], else: { kind: "algorithm", algorithm: "hpa" } };
    const r = value(resolve(entry({ strategy: inline(root) })));
    expect(r.agents[0]?.planning.strategy).toMatchObject({ id: "mine", version: 1, root });
  });

  it("leaves a plain algorithm configuration exactly as before: no strategy key, same effective hash", () => {
    const r = value(resolve(entry({ algorithm: "dijkstra" })));
    for (const a of r.agents) expect("strategy" in a.planning).toBe(false);
    const again = value(resolve(entry({ algorithm: "dijkstra" })));
    expect(again.effectiveConfigHash).toBe(r.effectiveConfigHash);
  });
});

describe("errors reach the user with their codes and paths", () => {
  it("strategy_not_found for an unknown id or version, never an inherited name", () => {
    for (const s of [{ ref: "nope", version: 1 }, { ref: "astar-only", version: 9 }, { ref: "__proto__", version: 1 }, { ref: "constructor", version: 1 }]) {
      const e = failure(resolve(entry({ strategy: s })));
      expect(e.code, JSON.stringify(s)).toBe("strategy_not_found");
      expect(e.path).toBe("/planning/default/strategy");
    }
  });

  it("strategy_and_algorithm_both_set only when one entry sets both", () => {
    const e = failure(resolve(entry({ algorithm: "astar", strategy: REF })));
    expect(e.code).toBe("strategy_and_algorithm_both_set");
    expect(e.path).toBe("/planning/default");
    // Different levels are fine: the later one replaces the planner.
    expect(resolve({ ...base, planning: { default: { algorithm: "astar" }, byKind: { ugv: { strategy: REF } } } }).ok).toBe(true);
  });

  it("an inline document's own errors are reported with the path inside the run configuration", () => {
    const bad = { kind: "select", branches: [{ when: "truth.cell.blocked", then: { kind: "algorithm", algorithm: "astar" } }], else: { kind: "algorithm", algorithm: "hpa" } };
    const e = failure(resolve({ ...base, planning: { byAgent: { rover: { strategy: inline(bad) } } } }));
    expect(e.code).toBe("expr_unknown_name");
    expect(e.path).toBe("/planning/byAgent/rover/strategy/root/branches/0/when");
    expect(failure(resolve(entry({ strategy: inline({ kind: "algorithm", algorithm: "bfs" }) }))).code).toBe("unknown_algorithm");
    expect(failure(resolve(entry({ strategy: inline({ kind: "select", branches: [{ when: "dist.m < 1", then: { kind: "algorithm", algorithm: "astar" } }] }) }))).code).toBe("select_missing_else");
  });

  it("a stage budget above the agent's totalBudget, and an hpa leaf under a turn-aware profile", () => {
    const e = failure(resolve(entry({ strategy: REF, onboardComputeExpansionsPerTick: 100, totalBudget: 4000 })));
    expect(e.code).toBe("stage_budget_exceeds_total");
    expect(e.message).toMatch(/uav-001/);
    expect(resolve(entry({ strategy: REF, onboardComputeExpansionsPerTick: 100, totalBudget: 5000 })).ok).toBe(true);
    const turn = failure(resolve(entry({ strategy: { ref: "hpa-only", version: 1 }, costProfile: { weights: { distance: 1, turn: 1 } } })));
    expect(turn.code).toBe("profile_feature_unsupported");
  });
});

describe("one precedence field for algorithm and strategy (ADR-0028 addition)", () => {
  it("a later level that sets either one replaces the planner of the earlier levels", () => {
    const r = value(
      resolve({
        ...base,
        planning: {
          default: { strategy: REF },
          byKind: { ugv: { algorithm: "dijkstra" } },
          byAgent: { rover: { strategy: { ref: "short-astar-long-hpa", version: 1 } } },
        },
      }),
    );
    const [scout, rover, other] = r.agents;
    expect(scout?.planning.strategy?.id).toBe("astar-then-hpa"); // uav: default
    expect(scout?.planningSources.algorithm).toBe("default");
    expect(rover?.planning.strategy?.id).toBe("short-astar-long-hpa"); // byAgent over byKind
    expect(rover?.planningSources.algorithm).toBe("byAgent");
    expect(other?.planning.algorithm).toBe("dijkstra"); // ugv without a key: byKind algorithm replaced the default strategy
    expect("strategy" in (other?.planning ?? {})).toBe(false);
    expect(other?.planningSources.algorithm).toBe("byKind");
  });

  it("applies to a world-scope runtime change, with the same checks", () => {
    const agent = value(resolve(entry({ algorithm: "dijkstra" }))).agents[0];
    if (!agent) throw new Error("no agent");
    const withStrategy = value(withRuntimeChange(agent, { strategy: { ref: "astar-only", version: 1 } }));
    expect(withStrategy.planning.strategy?.id).toBe("astar-only");
    expect(withStrategy.planningSources.algorithm).toBe("runtime");
    const back = value(withRuntimeChange(withStrategy, { algorithm: "hpa" }));
    expect("strategy" in back.planning).toBe(false);
    expect(back.planning.algorithm).toBe("hpa");
    expect(failure(withRuntimeChange(agent, { algorithm: "astar", strategy: REF })).code).toBe("strategy_and_algorithm_both_set");
    expect(failure(withRuntimeChange(agent, { strategy: { ref: "nope", version: 1 } })).code).toBe("strategy_not_found");
  });
});

describe("hashes (ADR-0037 §4)", () => {
  it("runConfigHash is the document as written; effectiveConfigHash follows the resolved content", () => {
    const doc = entry({ strategy: REF });
    const r = value(resolve(doc));
    expect(r.runConfigHash).toBe(hash32Hex(canonicalRunConfig(doc)));
    // The same reference resolving to different content (a registry change): same document hash, different effective hash.
    const preset = presetStrategy(REF) as PlanningStrategy;
    const changed: PlanningStrategy = { ...preset, root: { kind: "algorithm", algorithm: "dijkstra" } };
    const r2 = value(resolve(doc, { strategies: () => changed }));
    expect(r2.runConfigHash).toBe(r.runConfigHash);
    expect(r2.effectiveConfigHash).not.toBe(r.effectiveConfigHash);
  });

  it("an inline strategy is part of runConfigHash, a reference appears only as {ref, version}", () => {
    const refDoc = entry({ strategy: REF });
    expect(canonicalRunConfig(refDoc)).toContain(canonicalJson({ ref: "astar-then-hpa", version: 1 }));
    const a = entry({ strategy: inline({ kind: "algorithm", algorithm: "astar" }) });
    const b = entry({ strategy: inline({ kind: "algorithm", algorithm: "dijkstra" }) });
    expect(value(resolve(a)).runConfigHash).not.toBe(value(resolve(b)).runConfigHash);
  });

  it("metadata that does not change behavior does not change the effective hash", () => {
    const root = { kind: "algorithm", algorithm: "astar" };
    const x = value(resolve(entry({ strategy: { ...inline(root), description: "one" } })));
    const y = value(resolve(entry({ strategy: { ...inline(root), description: "two", origin: "llm" } })));
    expect(x.effectiveConfigHash).toBe(y.effectiveConfigHash);
  });
});

describe("every strategy node is executable (F2b M3 lifted the last refusal)", () => {
  const lazy = inline({ kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } });

  it("a lazy refine strategy resolves and assembles like any other, through a text run configuration too", () => {
    const parsed = value(parseRunConfig(JSON.stringify({ ...base, planning: { default: { strategy: lazy } } })));
    const r = value(resolve(parsed));
    expect(r.agents.every((a) => a.planning.strategy?.id === "mine")).toBe(true);
    expect(() => assembleRun(loaded(), r, new TraceBuffer("run-000001", () => 0, 1000), { dtS: 0.1 })).not.toThrow();
  });

  it("a plain configuration and a preset assemble too", () => {
    expect(() => assembleRun(loaded(), value(resolve(base)), new TraceBuffer("run-000002", () => 0, 1000), { dtS: 0.1 })).not.toThrow();
    expect(() => assembleRun(loaded(), value(resolve({ ...base, planning: { byAgent: { rover: { strategy: REF } } } })), new TraceBuffer("run-000003", () => 0, 1000), { dtS: 0.1 })).not.toThrow();
  });
});

describe("the per-agent config record (ADR-0028 addition of 2026-10-10)", () => {
  it("carries the strategy id, version, hash and content", () => {
    const r = value(resolve({ ...base, planning: { byAgent: { rover: { strategy: REF } } } }));
    const trace = new TraceBuffer("run-000001", () => 0, 1000);
    traceConfigs(r, trace);
    const rec = (agentId: string) => trace.all().find((x) => x.agentId === agentId)?.payload as { planning: { strategy?: { id: string; version: number; hash: string } } };
    expect(rec("ugv-001").planning.strategy).toMatchObject({ id: "astar-then-hpa", version: 1, hash: strategyContentHash(presetStrategy(REF) as PlanningStrategy) });
    expect(rec("uav-001").planning.strategy).toBeUndefined();
  });
});

describe("run-configuration warnings (ADR-0037 seventh addition, item 15)", () => {
  const lazyDoc = inline({ kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } });
  const eagerDoc = inline({ kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } });

  it("a lazy refine on an agent with a belief map is warned about, per agent, in agent order; it is not an error", () => {
    const r = value(resolve({ ...base, planning: { default: { strategy: lazyDoc } } } as RunConfigDocument));
    expect(r.warnings.map((w) => [w.code, w.agentId])).toEqual([["lazy_refine_on_belief_map", "uav-001"], ["lazy_refine_on_belief_map", "ugv-001"], ["lazy_refine_on_belief_map", "ugv-002"]]);
    expect(r.warnings[0]?.message).toMatch(/belief map/);
    expect(r.warnings[0]?.message).toMatch(/interrupt/);
    expect(r.warnings[0]?.path).toBe("/agents/uav-001");
  });

  it("no warning for ideal agents, an eager refine, another strategy, or a plain algorithm", () => {
    const ideal = { beliefs: { default: { init: "ideal" } } };
    expect(value(resolve({ ...base, ...ideal, planning: { default: { strategy: lazyDoc } } } as RunConfigDocument)).warnings).toEqual([]);
    expect(value(resolve({ ...base, planning: { default: { strategy: eagerDoc } } } as RunConfigDocument)).warnings).toEqual([]);
    expect(value(resolve({ ...base, planning: { default: { strategy: REF } } })).warnings).toEqual([]);
    expect(value(resolve({ ...base, planning: { default: { algorithm: "hpa" } } })).warnings).toEqual([]);
    expect(value(resolve(base)).warnings).toEqual([]);
  });

  it("only the agents that use it are warned about, and the warnings are outside every hash", () => {
    const some = value(resolve({ ...base, planning: { byAgent: { rover: { strategy: lazyDoc } } } } as RunConfigDocument));
    expect(some.warnings.map((w) => w.agentId)).toEqual(["ugv-001"]);
    // Warnings are not configuration: resolving the same document twice gives the same hashes, and a warning-free document hashes by its content only.
    const again = value(resolve({ ...base, planning: { byAgent: { rover: { strategy: lazyDoc } } } } as RunConfigDocument));
    expect(again.effectiveConfigHash).toBe(some.effectiveConfigHash);
    expect(again.runConfigHash).toBe(some.runConfigHash);
  });
});
