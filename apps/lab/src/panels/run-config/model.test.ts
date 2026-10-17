import { f1DemoRunConfig, f1DemoScenario, scenarioAgents, type RunConfigDocument } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import {
  constraintIssue,
  driveScopes,
  getEntry,
  planningScopes,
  presetIdOf,
  profileIssue,
  rebasePreset,
  scopeFromId,
  scopeId,
  setEntry,
  validateDraft,
  withField,
  withPlanner,
  plannerKind,
  strategyRefOf,
  parseInlineStrategy,
} from "./model.ts";

const view = scenarioAgents(f1DemoScenario());
const base = f1DemoRunConfig(4);

describe("run-configuration form model (ADR-0028)", () => {
  it("lists planning and drive scopes from the scenario's agents", () => {
    expect(planningScopes(view).map(scopeId)).toEqual(["default", "byKind.ugv", "byKind.uav", "byAgent.rover", "byAgent.low", "byAgent.scout"]);
    expect(driveScopes(view).map(scopeId)).toEqual(["default", "byKind.ugv", "byAgent.rover", "byAgent.low"]);
    for (const s of planningScopes(view)) expect(scopeFromId(scopeId(s))).toEqual(s);
  });

  it("sets and clears entries immutably, dropping empty sections so the document stays canonical", () => {
    const rover = { level: "byAgent", key: "rover" } as const;
    const a = setEntry(base, "planning", rover, { costProfile: { weights: { distance: 1, terrain: 1 } } });
    expect(base.planning).toBeUndefined();
    expect(getEntry(a, "planning", rover)).toEqual({ costProfile: { weights: { distance: 1, terrain: 1 } } });
    const b = setEntry(a, "planning", rover, withField(getEntry(a, "planning", rover), "costProfile", undefined));
    expect(b).toEqual(base);
    const c = setEntry(base, "drive", { level: "byKind", kind: "ugv" }, { drive: "ackermann" });
    expect(c.drive).toEqual({ byKind: { ugv: { drive: "ackermann" } } });
    // Values inside an entry are not pruned: an emptied weight map is a degenerate profile, not "inherit".
    const d = setEntry(base, "planning", { level: "default" }, { costProfile: { weights: {} } });
    expect(getEntry(d, "planning", { level: "default" })).toEqual({ costProfile: { weights: {} } });
    const r = validateDraft(d, view, 4);
    expect(r.ok ? "ok" : r.error.code).toBe("profile_degenerate");
  });

  it("validates like a run: live hashes when valid, stable codes when not", () => {
    const ok = validateDraft(base, view, 4);
    expect(ok.ok).toBe(true);
    const weighted = validateDraft(setEntry(base, "planning", { level: "default" }, { costProfile: { weights: { distance: 1, terrain: 1 } } }), view, 4);
    expect(weighted.ok && ok.ok && weighted.resolved.effectiveConfigHash !== ok.resolved.effectiveConfigHash).toBe(true);
    expect(weighted.ok && ok.ok && weighted.resolved.runConfigHash !== ok.resolved.runConfigHash).toBe(true);

    const codes: [unknown, string][] = [
      [{ ...base, schemaVersion: 9 }, "unsupported_schema_version"],
      [{ ...base, seed: -1 }, "invalid_document"],
      [setEntry(base, "planning", { level: "byAgent", key: "ghost" }, { algorithm: "astar" }), "unknown_agent_key"],
      [setEntry(base, "planning", { level: "default" }, { algorithm: { "weighted-astar": { weight: 0.5 } } }), "weight_out_of_range"],
      [setEntry(base, "planning", { level: "default" }, { onboardComputeExpansionsPerTick: 0 }), "budget_out_of_range"],
      [setEntry(base, "planning", { level: "default" }, { costProfile: { weights: { time: 0 } } }), "profile_degenerate"],
      [setEntry(base, "planning", { level: "default" }, { costProfile: { weights: { risk: 1 } } }), "profile_feature_unsupported"],
      [setEntry(base, "planning", { level: "default" }, { costProfile: { constraints: ["slope <"] } }), "constraint_invalid"],
    ];
    for (const [doc, code] of codes) {
      const r = validateDraft(doc, view, 4);
      expect(r.ok ? "ok" : r.error.code, JSON.stringify(doc)).toBe(code);
    }
    const wrongVersion = validateDraft(base, view, 5);
    expect(wrongVersion.ok ? "ok" : wrongVersion.error.code).toBe("scenario_version_not_found");
  });

  it("validates cost profiles and single constraints with stable codes; code is never evaluated", () => {
    expect(profileIssue({ weights: { distance: 1, terrain: 2 }, constraints: ["slope < 0.3"] })).toBeUndefined();
    expect(profileIssue({ weights: { distance: 0 } })?.code).toBe("profile_degenerate");
    expect(constraintIssue('terrain <= 5 and vehicle == "ugv"')).toBeUndefined();
    expect(constraintIssue("speed > 2")?.code).toBe("constraint_invalid");
    for (const evil of ["globalThis.alert(1)", "constructor.constructor('x')()", "(() => 1)()", "`${1}`", "slope; while(true){}"]) {
      expect(constraintIssue(evil)?.code, evil).toBe("constraint_invalid");
    }
  });

  it("derives preset IDs storage accepts", () => {
    expect(presetIdOf("Terrain-aware rover")).toBe("terrain-aware-rover");
    expect(presetIdOf("  42 HPA* everywhere! ")).toBe("hpa-everywhere");
    expect(presetIdOf("123")).toBeUndefined();
    expect(presetIdOf("x".repeat(100))?.length).toBe(64);
  });

  it("rebases a preset onto the loaded scenario version", () => {
    const preset: RunConfigDocument = { ...base, scenario: { id: "f1-demo", version: 1 }, seed: 7 };
    expect(rebasePreset(preset, { id: "f1-demo", version: 4 })).toEqual({ doc: { ...preset, scenario: { id: "f1-demo", version: 4 } }, rebased: true });
    expect(rebasePreset(base, { id: "f1-demo", version: 4 }).rebased).toBe(false);
  });
});

describe("beliefs entries (ADR-0028 addition of 2026-10-09)", () => {
  it("are edited per level like planning, and the resolver reports each agent's initial map with its source", () => {
    const doc = f1DemoRunConfig(4);
    const unknown = setEntry(doc, "beliefs", { level: "default" }, { init: "unknown" });
    const rover = setEntry(unknown, "beliefs", { level: "byAgent", key: "rover" }, { init: "ideal" });
    expect(getEntry(rover, "beliefs", { level: "byAgent", key: "rover" })).toEqual({ init: "ideal" });
    const v = validateDraft(rover, view, 4);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const byKey = new Map(v.resolved.agents.map((a) => [a.key, a]));
    expect(byKey.get("rover")?.beliefs).toMatchObject({ idealized: true });
    expect(byKey.get("rover")?.beliefsSource).toBe("byAgent");
    expect(byKey.get("low")?.beliefs).toMatchObject({ init: "unknown", idealized: false });
    expect(byKey.get("low")?.beliefsSource).toBe("default");
    // Removing the entry falls back to the lower level; an empty section is dropped from the document.
    const back = setEntry(setEntry(rover, "beliefs", { level: "byAgent", key: "rover" }, undefined), "beliefs", { level: "default" }, undefined);
    expect(back.beliefs).toBeUndefined();
  });

  it("a prior that the scenario does not have is refused with its stable code", () => {
    const doc = setEntry(f1DemoRunConfig(4), "beliefs", { level: "default" }, { init: { prior: "stale-map" } });
    const v = validateDraft(doc, view, 4);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe("prior_not_found");
  });
});

describe("planner choice in the form model (ADR-0037, ADR-0028 addition of 2026-10-13)", () => {
  const all = { level: "default" } as const;

  it("choosing a strategy clears the algorithm of the same entry, and the other way round", () => {
    const withAlg = setEntry(base, "planning", all, withPlanner(undefined, { algorithm: "dijkstra" }));
    expect(plannerKind(getEntry(withAlg, "planning", all))).toBe("algorithm");
    const strat = setEntry(withAlg, "planning", all, withPlanner(getEntry(withAlg, "planning", all), { strategy: { ref: "astar-only", version: 1 } }));
    expect(getEntry(strat, "planning", all)).toEqual({ strategy: { ref: "astar-only", version: 1 } });
    expect(plannerKind(getEntry(strat, "planning", all))).toBe("strategy");
    expect(strategyRefOf(getEntry(strat, "planning", all))).toEqual({ ref: "astar-only", version: 1 });
    const back = withPlanner(getEntry(strat, "planning", all), { algorithm: "astar" });
    expect(back).toEqual({ algorithm: "astar" });
  });

  it("keeps the other planning fields and inherits when cleared", () => {
    const e = withPlanner({ totalBudget: 5000, algorithm: "hpa" }, { strategy: { ref: "hpa-only", version: 1 } });
    expect(e).toEqual({ totalBudget: 5000, strategy: { ref: "hpa-only", version: 1 } });
    expect(withPlanner(e, undefined)).toEqual({ totalBudget: 5000 });
    expect(plannerKind(withPlanner(e, undefined))).toBe("inherit");
  });

  it("a preset reference validates and resolves to the shipped strategy's id, version and hash", () => {
    const doc = setEntry(base, "planning", all, withPlanner(undefined, { strategy: { ref: "astar-then-hpa", version: 1 } }));
    const r = validateDraft(doc, view, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.agents[0]?.planning.strategy).toMatchObject({ id: "astar-then-hpa", version: 1 });
    expect(r.resolved.agents[0]?.planningSources.algorithm).toBe("default");
  });

  it("reports an unknown preset and bad inline documents with their stable codes, not as exceptions", () => {
    const unknown = validateDraft(setEntry(base, "planning", all, withPlanner(undefined, { strategy: { ref: "nope", version: 1 } })), view, 4);
    expect(unknown.ok).toBe(false);
    const inline = parseInlineStrategy(JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root: { kind: "select", branches: [{ when: "nonsense > 1", then: { kind: "algorithm", algorithm: "astar" } }], else: { kind: "algorithm", algorithm: "hpa" } } }));
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    const bad = validateDraft(setEntry(base, "planning", all, withPlanner(undefined, { strategy: inline.value })), view, 4);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("expr_unknown_name");
  });

  it("the inline editor reports only JSON syntax (invalid_json) and refuses non-objects", () => {
    expect(parseInlineStrategy("{ not json")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(parseInlineStrategy("[1,2]")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(parseInlineStrategy("null")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(parseInlineStrategy("{}")).toMatchObject({ ok: true });
  });
});
