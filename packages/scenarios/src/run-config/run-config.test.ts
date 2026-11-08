import { compileCostProfile, DEFAULT_PLANNING_CONFIG, PlanningService, SearchSpace, type PlanOutcome, type PlanRequest } from "@agentsim/algorithms";
import { traversalFor } from "../traversal.ts";
import { describe, expect, it } from "vitest";
import { BUILTIN_BODY_DEFAULTS } from "../body-defaults.ts";
import { loadScenario, scenarioAgents, type LoadedScenario } from "../load.ts";
import type { AgentSpec, ScenarioDocument } from "../schema.ts";
import { parseRunConfig, parseRunConfigValue, resolveRunConfig, toPlanningConfig, withRuntimeChange, type RunConfigErrorCode } from "./resolve.ts";
import type { RunConfigDocument } from "./schema.ts";

/** 128 × 128 m at 1 m, 32-cell chunks, two blocked chunks between the corners so planners differ. */
function scenarioDoc(agents: AgentSpec[]): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "planners",
    name: "Planners",
    defaultSeed: 11,
    world: {
      resolutionM: 1,
      sizeCells: { x: 128, y: 128 },
      chunkSize: 32,
      altitudeLimitsM: { min: 0, max: 60 },
      layers: { occupancy: { chunks: [{ ci: 1, cj: 1, fill: 1 }, { ci: 2, cj: 2, fill: 1 }, { ci: 1, cj: 2, fill: 1 }] } },
    },
    zones: [],
    agents,
  };
}

const AGENTS: AgentSpec[] = [
  { kind: "uav", key: "scout", start: { xM: 5, yM: 5, zM: 20 }, body: { onboardComputeExpansionsPerTick: 5000 } },
  { kind: "ugv", key: "rover", start: { xM: 6, yM: 6 } },
  { kind: "ugv", start: { xM: 8, yM: 8 } },
];

function loaded(agents: AgentSpec[] = AGENTS): LoadedScenario {
  const r = loadScenario(scenarioDoc(agents));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const base: RunConfigDocument = { schemaVersion: 0, scenario: { id: "planners", version: 3 } };

function resolve(doc: RunConfigDocument, l = loaded(), opts = {}) {
  return resolveRunConfig(doc, { loaded: l, version: 3 }, opts);
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("run configuration v0 (ADR-0028)", () => {
  it("resolves the same from the agents-only view (UI, no world built) as from the loaded scenario", () => {
    const doc: RunConfigDocument = {
      ...base,
      planning: { byKind: { ugv: { algorithm: "hpa" } }, byAgent: { scout: { costProfile: { weights: { distance: 1, time: 2 } } } } },
      drive: { byAgent: { rover: { drive: "ackermann" } } },
    };
    const full = value(resolve(doc));
    const light = value(resolveRunConfig(doc, { loaded: scenarioAgents(scenarioDoc(AGENTS)), version: 3 }));
    expect(light.agents).toEqual(full.agents);
    expect(light.effectiveConfigHash).toBe(full.effectiveConfigHash);
    expect(light.runConfigHash).toBe(full.runConfigHash);
  });

  it("resolves field by field across built-in → scenario body → default → byKind → byAgent", () => {
    const r = value(
      resolve({
        ...base,
        planning: {
          default: { algorithm: "dijkstra", totalBudget: 3_000_000 },
          byKind: { ugv: { algorithm: "hpa" } },
          byAgent: { scout: { onboardComputeExpansionsPerTick: 50_000 }, rover: { costProfile: { weights: { distance: 1, terrain: 2 } } } },
        },
      }),
    );
    const [uav1, ugv1, ugv2] = r.agents;
    expect(r.agents.map((a) => a.agentId)).toEqual(["uav-001", "ugv-001", "ugv-002"]);
    // scout: algorithm from default, compute from byAgent (over the scenario body's 5000), budget from default.
    expect(uav1?.planning).toEqual({ algorithm: "dijkstra", onboardComputeExpansionsPerTick: 50_000, totalBudget: 3_000_000, costProfile: { weights: { distance: 1 } }, radiusM: 40, windowMarginM: 10 });
    expect(uav1?.planningSources).toEqual({ algorithm: "default", onboardComputeExpansionsPerTick: "byAgent", totalBudget: "default", costProfile: "builtin", radiusM: "builtin", windowMarginM: "builtin" });
    // rover: hpa from byKind, profile from byAgent, compute from the built-in body.
    expect(ugv1?.planning.algorithm).toBe("hpa");
    expect(ugv1?.planningSources).toEqual({ algorithm: "byKind", onboardComputeExpansionsPerTick: "builtin", totalBudget: "default", costProfile: "byAgent", radiusM: "builtin", windowMarginM: "builtin" });
    // The unkeyed UGV gets byKind but no byAgent entry.
    expect(ugv2?.planning.costProfile).toEqual({ weights: { distance: 1 } });
    expect(r.seed).toBe(11);
    expect(r.timeMode).toBe("lockstep");
  });

  it("uses the scenario body's onboard compute when the run config does not override it", () => {
    const r = value(resolve(base));
    expect(r.agents[0]?.planning.onboardComputeExpansionsPerTick).toBe(5000);
    expect(r.agents[0]?.planningSources.onboardComputeExpansionsPerTick).toBe("scenario");
  });

  it("references agents by key, not load-order ID: overrides survive inserting an agent before them", () => {
    const doc: RunConfigDocument = { ...base, planning: { byAgent: { scout: { algorithm: "hpa" } } } };
    const before = value(resolve(doc));
    const inserted = value(resolve(doc, loaded([{ kind: "uav", start: { xM: 2, yM: 2, zM: 20 } }, ...AGENTS])));
    expect(before.agents.find((a) => a.key === "scout")?.agentId).toBe("uav-001");
    const scout = inserted.agents.find((a) => a.key === "scout");
    expect(scout?.agentId).toBe("uav-002");
    expect(scout?.planning.algorithm).toBe("hpa");
    expect(inserted.agents.find((a) => a.agentId === "uav-001")?.planning.algorithm).toBe("astar");
  });

  it("same scenario version + run config → same effectiveConfigHash; key order and explicit defaults do not change runConfigHash", () => {
    const a = value(resolve({ ...base, seed: 4, planning: { default: { algorithm: "astar", totalBudget: 100_000 } } }));
    const b = value(resolve(JSON.parse('{"planning":{"default":{"totalBudget":100000,"algorithm":"astar"}},"seed":4,"timeMode":"lockstep","scenario":{"version":3,"id":"planners"},"schemaVersion":0}') as RunConfigDocument));
    expect(b.runConfigHash).toBe(a.runConfigHash);
    expect(b.effectiveConfigHash).toBe(a.effectiveConfigHash);
    expect(a.runConfigHash).toMatch(/^[0-9a-f]{8}$/);
    const c = value(resolve({ ...base, seed: 4, timeMode: "realtime", planning: { default: { algorithm: "astar", totalBudget: 100_000 } } }));
    expect(c.runConfigHash).not.toBe(a.runConfigHash);
    // F4 M2: latency-modeled changes when decisions are applied, so it is part of the run's hash; lockstep spelled out is not.
    const d = value(resolve({ ...base, seed: 4, timeMode: "latency-modeled", planning: { default: { algorithm: "astar", totalBudget: 100_000 } } }));
    expect(d.runConfigHash).not.toBe(a.runConfigHash);
    expect(d.runConfigHash).not.toBe(c.runConfigHash);
    expect(d.timeMode).toBe("latency-modeled");
  });

  it("a changed built-in default changes effectiveConfigHash but not runConfigHash", () => {
    const now = value(resolve(base));
    const later = value(resolve(base, loaded(), { builtinPlanning: { ...DEFAULT_PLANNING_CONFIG, totalBudget: 1_500_000 } }));
    expect(later.runConfigHash).toBe(now.runConfigHash);
    expect(later.effectiveConfigHash).not.toBe(now.effectiveConfigHash);
  });

  it("body footprint and tracking margin are model parameters: they change effectiveConfigHash", () => {
    const now = value(resolve(base));
    const wider = value(resolve(base, loaded(), { builtinBodies: { ...BUILTIN_BODY_DEFAULTS, ugv: { ...BUILTIN_BODY_DEFAULTS.ugv, footprintRadiusM: 0.8 } } }));
    const margin = value(resolve(base, loaded([...AGENTS.slice(0, 1), { kind: "ugv", key: "rover", start: { xM: 6, yM: 6 }, body: { trackingMarginM: 0.6 } }, AGENTS[2] as AgentSpec])));
    expect(wider.effectiveConfigHash).not.toBe(now.effectiveConfigHash);
    expect(margin.effectiveConfigHash).not.toBe(now.effectiveConfigHash);
    expect(margin.runConfigHash).toBe(now.runConfigHash);
    // …and they reach the planner's mask cache key through the same resolved values.
    const key = (r: typeof now) => {
      const rover = r.agents.find((a) => a.key === "rover");
      if (!rover) throw new Error("rover missing");
      const p = compileCostProfile(rover.planning.costProfile);
      if (!p.ok) throw new Error("profile");
      return SearchSpace.key(traversalFor(rover), p.value);
    };
    expect(traversalFor(now.agents.find((a) => a.key === "rover") as never).inflationRadiusM).toBe(0.75);
    expect(key(margin)).not.toBe(key(now));
    expect(key(wider)).not.toBe(key(now));
  });
});

describe("drive section (ADR-0033)", () => {
  it("resolves drive overrides with the same precedence and puts them in effectiveConfigHash", () => {
    const now = value(resolve(base));
    const rover = (r: typeof now) => r.agents.find((a) => a.key === "rover")?.body as { drive: string; turningRadiusM: number; reverseAllowed: boolean };
    expect(rover(now)).toMatchObject({ drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const r = value(resolve({ ...base, drive: { default: { drive: "ackermann" }, byKind: { ugv: { wheelbaseM: 2 } }, byAgent: { rover: { drive: "forward-only" } } } }));
    expect(rover(r)).toMatchObject({ drive: "forward-only", turningRadiusM: 1.5, reverseAllowed: false });
    const other = r.agents.find((a) => a.agentId === "ugv-002")?.body as { drive: string; turningRadiusM: number };
    expect(other.drive).toBe("ackermann");
    expect(other.turningRadiusM).toBeCloseTo(2 / Math.tan(0.6), 12);
    expect(r.effectiveConfigHash).not.toBe(now.effectiveConfigHash);
    expect(r.runConfigHash).not.toBe(now.runConfigHash);
    // UAVs have no drive model.
    expect((r.agents.find((a) => a.kind === "uav")?.body as unknown as Record<string, unknown>)["drive"]).toBeUndefined();
  });

  it("rejects unknown agent keys and unknown fields in the drive section", () => {
    const unknown = resolve({ ...base, drive: { byAgent: { ghost: { drive: "ackermann" } } } });
    expect(unknown.ok ? null : unknown.error.code).toBe("unknown_agent_key");
    const bad = parseRunConfigValue({ ...base, drive: { default: { drive: "hovercraft" } } });
    expect(bad.ok ? null : bad.error.code).toBe("invalid_document");
  });
});

describe("beliefs section (ADR-0028 addition of 2026-10-09)", () => {
  const initOf = (doc: RunConfigDocument, l = loaded()) => {
    const r = value(resolve(doc, l));
    return Object.fromEntries(r.agents.map((a) => [a.key ?? a.agentId, [a.beliefs.init, a.beliefs.idealized, a.beliefsSource]]));
  };

  it("built-in unknown; default → byKind → byAgent; `ideal` is labelled idealized", () => {
    expect(initOf(base)).toEqual({ scout: ["unknown", false, "builtin"], rover: ["unknown", false, "builtin"], "ugv-002": ["unknown", false, "builtin"] });
    const doc: RunConfigDocument = { ...base, beliefs: { default: { init: "ideal" }, byKind: { ugv: { init: "unknown" } }, byAgent: { rover: { init: "ideal" } } } };
    expect(initOf(doc)).toEqual({ scout: ["ideal", true, "default"], rover: ["ideal", true, "byAgent"], "ugv-002": ["unknown", false, "byKind"] });
  });

  it("byAgent overrides survive inserting an agent before the one they name (keys, not IDs)", () => {
    const doc: RunConfigDocument = { ...base, beliefs: { byAgent: { rover: { init: "ideal" } } } };
    const inserted = loaded([{ kind: "ugv", start: { xM: 3, yM: 3 } }, ...AGENTS]);
    expect(initOf(doc, inserted)["rover"]).toEqual(["ideal", true, "byAgent"]);
  });

  it("is part of both hashes", () => {
    const a = value(resolve(base));
    const b = value(resolve({ ...base, beliefs: { default: { init: "ideal" } } }));
    expect(b.runConfigHash).not.toBe(a.runConfigHash);
    expect(b.effectiveConfigHash).not.toBe(a.effectiveConfigHash);
  });

  it("rejects unknown agent keys and unknown priors with their codes", () => {
    const k = resolve({ ...base, beliefs: { byAgent: { nobody: { init: "ideal" } } } });
    expect(k.ok ? null : k.error.code).toBe("unknown_agent_key");
    const p = resolve({ ...base, beliefs: { default: { init: { prior: "survey-2019" } } } });
    expect(p.ok ? null : p.error.code).toBe("prior_not_found");
  });
});

describe("planning with resolved configurations", () => {
  const l = loaded();
  const req = (agentId: string, config: PlanRequest["config"]): PlanRequest => ({
    agentId,
    traversal: { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05 },
    config,
    from: { x: 6, y: 6 },
    to: { x: 120, y: 120 },
  });
  function runUntilDone(svc: PlanningService, from: number): PlanOutcome[] {
    const out: PlanOutcome[] = [];
    for (let t = from; t < from + 10_000; t++) {
      svc.tick(t);
      out.push(...svc.takeCompleted());
      if (!svc.isPlanning("ugv-001") && !svc.isPlanning("ugv-002")) break;
    }
    return out;
  }

  it("two agents with different planners: each completes after its own expansions at its own budget", () => {
    const r = value(resolve({ ...base, planning: { byKind: { ugv: { onboardComputeExpansionsPerTick: 500 } }, byAgent: { rover: { algorithm: "hpa" } } } }));
    const rover = r.agents.find((a) => a.key === "rover");
    const other = r.agents.find((a) => a.agentId === "ugv-002");
    if (!rover || !other) throw new Error("agents missing");
    const svc = new PlanningService(l.grid, { cachesEnabled: false });
    expect(svc.submit(req(rover.agentId, toPlanningConfig(rover)), 0).ok).toBe(true);
    expect(svc.submit(req(other.agentId, toPlanningConfig(other)), 0).ok).toBe(true);
    const outcomes = runUntilDone(svc, 0);
    const byAgent = new Map(outcomes.map((o) => [o.agentId, o]));
    for (const id of ["ugv-001", "ugv-002"]) {
      const o = byAgent.get(id);
      expect(o?.status, id).toBe("found");
      if (!o) continue;
      expect(o.completedTick - o.submittedTick + 1).toBe(Math.ceil(o.expansionsCharged / 500));
    }
    expect(byAgent.get("ugv-001")?.expansionsCharged).not.toBe(byAgent.get("ugv-002")?.expansionsCharged);
  });

  it("a runtime change during a query leaves that query unchanged; the next query uses the new configuration", () => {
    const r = value(resolve({ ...base, planning: { byKind: { ugv: { onboardComputeExpansionsPerTick: 200, algorithm: "astar" } } } }));
    const rover = r.agents.find((a) => a.key === "rover");
    if (!rover) throw new Error("rover missing");
    const reference = (cfg: PlanRequest["config"]) => {
      const s = new PlanningService(l.grid, { cachesEnabled: false });
      s.submit(req("ugv-001", cfg), 0);
      return runUntilDone(s, 0)[0];
    };
    const svc = new PlanningService(l.grid, { cachesEnabled: false });
    svc.submit(req("ugv-001", toPlanningConfig(rover)), 0);
    svc.tick(0);
    // World-scope change mid-query (ADR-0028): applies from the agent's next query.
    const changed = value(withRuntimeChange(rover, { algorithm: "dijkstra", onboardComputeExpansionsPerTick: 1000 }));
    expect(changed.planningSources.algorithm).toBe("runtime");
    const first = runUntilDone(svc, 1)[0];
    expect(first?.expansionsCharged).toBe(reference(toPlanningConfig(rover))?.expansionsCharged);
    expect(first?.completedTick).toBe(reference(toPlanningConfig(rover))?.completedTick);
    svc.submit(req("ugv-001", toPlanningConfig(changed)), 100);
    const second = runUntilDone(svc, 100)[0];
    const ref2 = reference(toPlanningConfig(changed));
    expect(second?.expansionsCharged).toBe(ref2?.expansionsCharged);
    expect(second?.expansionsCharged).not.toBe(first?.expansionsCharged);
  });
});

describe("rejections with stable codes", () => {
  const cases: [string, unknown, RunConfigErrorCode][] = [
    ["unknown agent key", { ...base, planning: { byAgent: { ghost: { algorithm: "hpa" } } } }, "unknown_agent_key"],
    ["weight out of range", { ...base, planning: { default: { algorithm: { "weighted-astar": { weight: 11 } } } } }, "weight_out_of_range"],
    ["weight below 1", { ...base, planning: { byKind: { uav: { algorithm: { "weighted-astar": { weight: 0.5 } } } } } }, "weight_out_of_range"],
    ["per-tick compute below 100", { ...base, planning: { default: { onboardComputeExpansionsPerTick: 50 } } }, "budget_out_of_range"],
    ["total budget below per-tick compute", { ...base, planning: { byAgent: { scout: { onboardComputeExpansionsPerTick: 200_000, totalBudget: 100_000 } } } }, "budget_out_of_range"],
    ["total budget above 10,000,000", { ...base, planning: { default: { totalBudget: 20_000_000 } } }, "budget_out_of_range"],
    ["invalid constraint", { ...base, planning: { default: { costProfile: { weights: { distance: 1 }, constraints: ["terrain <"] } } } }, "constraint_invalid"],
    ["hpa with turn costs", { ...base, planning: { default: { algorithm: "hpa", costProfile: { weights: { distance: 1, turn: 1 } } } } }, "profile_feature_unsupported"],
    ["wrong scenario version", { ...base, scenario: { id: "planners", version: 2 } }, "scenario_version_not_found"],
    ["wrong scenario id", { ...base, scenario: { id: "other", version: 3 } }, "scenario_version_not_found"],
  ];
  it.each(cases)("%s", (_, doc, code) => {
    const p = parseRunConfigValue(JSON.parse(JSON.stringify(doc)));
    const r = p.ok ? resolve(p.value) : p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it.each([
    ["unknown field", { ...base, plannning: {} }, "invalid_document"],
    ["unknown entry field", { ...base, planning: { default: { algo: "astar" } } }, "invalid_document"],
    ["unknown algorithm", { ...base, planning: { default: { algorithm: "rrt" } } }, "invalid_document"],
    ["bad key pattern", { ...base, planning: { byAgent: { "Bad Key": {} } } }, "invalid_document"],
    ["unknown kind", { ...base, planning: { byKind: { ev: {} } } }, "invalid_document"],
    ["future schema", { ...base, schemaVersion: 1 }, "unsupported_schema_version"],
    ["prototype key", JSON.parse('{"schemaVersion":0,"scenario":{"id":"planners","version":3},"__proto__":{"x":1}}') as unknown, "invalid_document"],
    ["code-like weight", { ...base, planning: { default: { algorithm: { "weighted-astar": { weight: "1+1" } } } } }, "invalid_document"],
  ])("document: %s", (_, doc, code) => {
    const r = parseRunConfigValue(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it("rejects oversized and malformed text", () => {
    const big = parseRunConfig(" ".repeat(1024 * 1024 + 1));
    expect(big.ok ? null : big.error.code).toBe("too_large");
    const bad = parseRunConfig("{");
    expect(bad.ok ? null : bad.error.code).toBe("invalid_json");
  });

  it("validates runtime changes like run configurations", () => {
    const r = value(resolve(base));
    const rover = r.agents.find((a) => a.key === "rover");
    if (!rover) throw new Error("rover missing");
    const w = withRuntimeChange(rover, { algorithm: { "weighted-astar": { weight: 20 } } });
    expect(w.ok ? null : w.error.code).toBe("weight_out_of_range");
    const extra = withRuntimeChange(rover, { speed: 3 } as never);
    expect(extra.ok ? null : extra.error.code).toBe("invalid_document");
  });
});
