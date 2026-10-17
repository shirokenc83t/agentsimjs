import { describe, expect, it } from "vitest";
import { compileCostProfile, FEATURES } from "../../cost-profile.ts";
import { PLANNING_LIMITS } from "../planning-service.ts";
import { PLANNING_CONDITION_CONTEXT, PLANNING_CONDITION_VARIABLES } from "../planning-condition.ts";
import { checkStrategyForAgent, parsePlanningStrategy, strategyContentHash, validatePlanningStrategy, type StrategyErrorCode } from "./validate.ts";
import { STRATEGY_LIMITS, type PlanningStrategy } from "./schema.ts";

const leaf = (algorithm = "astar", extra: Record<string, unknown> = {}) => ({ kind: "algorithm", algorithm, ...extra });
const doc = (root: unknown, extra: Record<string, unknown> = {}) => ({ schemaVersion: 0, id: "my-strategy", version: 1, root, ...extra });
const select = (n: number, then: unknown = leaf(), els: unknown = leaf("hpa")) => ({
  kind: "select",
  branches: Array.from({ length: n }, (_, i) => ({ when: `dist.m < ${i + 10}`, then })),
  else: els,
});

function code(r: { ok: true; value: unknown } | { ok: false; error: { code: string } }): string {
  return r.ok ? "ok" : r.error.code;
}
function expectCode(value: unknown, expected: StrategyErrorCode, opts?: Parameters<typeof validatePlanningStrategy>[1]) {
  expect(code(validatePlanningStrategy(value, opts))).toBe(expected);
}

describe("limits stay in step with the planner's own ranges (ADR-0028)", () => {
  it("uses the same weight and budget ranges as PLANNING_LIMITS", () => {
    expect(STRATEGY_LIMITS.minWeight).toBe(PLANNING_LIMITS.minWeight);
    expect(STRATEGY_LIMITS.maxWeight).toBe(PLANNING_LIMITS.maxWeight);
    expect(STRATEGY_LIMITS.maxStageBudget).toBe(PLANNING_LIMITS.maxTotalBudget);
  });
});

describe("planning-condition context (ADR-0037 §2)", () => {
  it("registers exactly the planner's inputs at query start and nothing else", () => {
    expect([...PLANNING_CONDITION_VARIABLES]).toEqual(
      ["altitude", "budget.total", "dist.m", "known.frac", ...FEATURES.map((f) => `profile.${f}`), "replan.count", "vehicle"].sort(),
    );
    expect(Object.keys(PLANNING_CONDITION_CONTEXT).sort()).toEqual([...PLANNING_CONDITION_VARIABLES]);
    for (const f of FEATURES) expect(PLANNING_CONDITION_CONTEXT[`profile.${f}`]).toEqual({ type: "boolean" });
    expect(PLANNING_CONDITION_CONTEXT["vehicle"]).toEqual({ type: "enum", values: ["uav", "ugv"] });
  });
});

describe("valid documents", () => {
  it("accepts every node kind", () => {
    const root = {
      kind: "select",
      branches: [
        { when: "dist.m < 150 and known.frac > 0.5", then: leaf("astar", { heuristic: "euclidean", stageBudget: 5000 }) },
        { when: 'vehicle == "uav" or profile.turn', then: { kind: "fallback", stages: [leaf("weighted-astar", { weight: 2 }), leaf("hpa")] } },
        { when: "replan.count >= 2", then: { kind: "refine", coarse: leaf("hpa"), local: leaf("astar"), mode: "lazy" } },
      ],
      else: { kind: "anytime", weights: [3, 2, 1.5, 1], stageBudget: 20000 },
    };
    const r = validatePlanningStrategy(doc(root, { description: "all kinds", origin: "llm" }));
    expect(r.ok).toBe(true);
  });

  it("accepts the limits exactly: depth 6 and 32 nodes", () => {
    let chain: unknown = leaf();
    for (let i = 0; i < 5; i++) chain = { kind: "refine", coarse: chain, local: leaf(), mode: "eager" }; // depth 6
    expect(validatePlanningStrategy(doc(chain)).ok).toBe(true);
    // 1 fallback + 10 + 10 + 10 + 1 leaf = 32 nodes
    const thirtyTwo = { kind: "fallback", stages: [select(8), select(8), select(8), leaf()] };
    expect(validatePlanningStrategy(doc(thirtyTwo)).ok).toBe(true);
  });
});

describe("document errors", () => {
  it("reports invalid JSON, a wrong schema version and an oversized document with their codes", () => {
    expect(code(parsePlanningStrategy("{nope"))).toBe("invalid_json");
    expect(code(parsePlanningStrategy(JSON.stringify({ ...doc(leaf()), schemaVersion: 9 })))).toBe("unsupported_schema_version");
    const big = JSON.stringify(doc(leaf(), { description: "x".repeat(STRATEGY_LIMITS.maxBytes) }));
    expect(code(parsePlanningStrategy(big))).toBe("strategy_too_large");
    expect(parsePlanningStrategy(JSON.stringify(doc(leaf()))).ok).toBe(true);
  });

  it("rejects unknown fields, bad ids and non-objects", () => {
    expectCode({ ...doc(leaf()), extra: 1 }, "invalid_strategy");
    expectCode(doc(leaf(), { id: "../etc/passwd" }), "invalid_strategy");
    expectCode(doc(leaf(), { id: "Has Space" }), "invalid_strategy");
    expectCode(doc(leaf(), { origin: "robot" }), "invalid_strategy");
    expectCode(doc(leaf(), { version: 0 }), "invalid_strategy");
    expectCode(null, "invalid_strategy");
    expectCode(doc("astar"), "invalid_strategy");
    expectCode(doc({ kind: "teleport" }), "invalid_strategy");
    expectCode(doc({ ...leaf(), extra: true }), "invalid_strategy");
  });

  it("limits the depth, the node count, the fallback stages and the anytime weights", () => {
    let deep: unknown = leaf();
    for (let i = 0; i < 6; i++) deep = { kind: "refine", coarse: deep, local: leaf(), mode: "eager" }; // depth 7
    expectCode(doc(deep), "strategy_too_deep");
    // 1 + 10 + 10 + 9 + 3 = 33 nodes
    expectCode(doc({ kind: "fallback", stages: [select(8), select(8), select(7), { kind: "refine", coarse: leaf(), local: leaf(), mode: "eager" }] }), "strategy_too_large");
    expectCode(doc({ kind: "fallback", stages: [leaf(), leaf("dijkstra"), leaf("hpa"), leaf("astar"), leaf("astar")] }), "strategy_too_large");
    expectCode(doc({ kind: "anytime", weights: [7, 6, 5, 4, 3, 2, 1] }), "strategy_too_large");
    expectCode(doc({ kind: "fallback", stages: [leaf()] }), "invalid_strategy");
  });
});

describe("algorithm leaves", () => {
  it("rejects an unknown algorithm with its code", () => {
    expectCode(doc(leaf("bfs")), "unknown_algorithm");
    expectCode(doc(leaf("D*-lite")), "unknown_algorithm");
    expectCode(doc(leaf("")), "unknown_algorithm");
  });

  it("checks the weight range of weighted-astar and anytime", () => {
    expectCode(doc(leaf("weighted-astar", { weight: 0.5 })), "weight_out_of_range");
    expectCode(doc(leaf("weighted-astar", { weight: 11 })), "weight_out_of_range");
    expectCode(doc({ kind: "anytime", weights: [3, 0.5] }), "weight_out_of_range");
    expectCode(doc({ kind: "anytime", weights: [30, 2] }), "weight_out_of_range");
    expect(validatePlanningStrategy(doc(leaf("weighted-astar", { weight: 10 }))).ok).toBe(true);
    expect(validatePlanningStrategy(doc(leaf("weighted-astar", { weight: 1 }))).ok).toBe(true);
  });

  it("requires a decreasing weight list", () => {
    expectCode(doc({ kind: "anytime", weights: [1, 2] }), "anytime_weights_invalid");
    expectCode(doc({ kind: "anytime", weights: [2, 2] }), "anytime_weights_invalid");
    expectCode(doc({ kind: "anytime", weights: [] }), "invalid_strategy");
  });

  it("allows parameters only where the algorithm has them", () => {
    expectCode(doc(leaf("weighted-astar")), "invalid_strategy"); // needs a weight
    expectCode(doc(leaf("astar", { weight: 2 })), "invalid_strategy");
    expectCode(doc(leaf("hpa", { heuristic: "octile" })), "invalid_strategy");
    expectCode(doc(leaf("dijkstra", { heuristic: "euclidean" })), "invalid_strategy");
    expectCode(doc(leaf("astar", { heuristic: "manhattan" })), "invalid_strategy");
    expect(validatePlanningStrategy(doc(leaf("weighted-astar", { weight: 2, heuristic: "euclidean" }))).ok).toBe(true);
  });

  it("checks stage budgets against the planner's range", () => {
    expectCode(doc(leaf("astar", { stageBudget: 0 })), "budget_out_of_range");
    expectCode(doc(leaf("astar", { stageBudget: STRATEGY_LIMITS.maxStageBudget + 1 })), "budget_out_of_range");
    expectCode(doc(leaf("astar", { stageBudget: 2.5 })), "invalid_strategy");
    expectCode(doc({ kind: "anytime", weights: [2, 1], stageBudget: -5 }), "budget_out_of_range");
  });

  it("rejects an octile heuristic on a space without diagonal moves (ADR-0037 addition, §7)", () => {
    const r = doc(leaf("astar", { heuristic: "octile" }));
    expectCode(r, "heuristic_not_admissible", { movement: "4-connected" });
    expect(validatePlanningStrategy(r, { movement: "8-connected" }).ok).toBe(true);
    // The euclidean bound never overestimates, whatever the moves.
    expect(validatePlanningStrategy(doc(leaf("astar", { heuristic: "euclidean" })), { movement: "4-connected" }).ok).toBe(true);
  });
});

describe("select and conditions", () => {
  it("requires an else", () => {
    const s = select(1) as Record<string, unknown>;
    delete s["else"];
    expectCode(doc(s), "select_missing_else");
  });

  it("rejects names outside the planning-condition context (ground truth, other agents, wall time)", () => {
    for (const name of ["truth.blocked", "agent.x", "world.obstacles", "time.now", "wall.ms", "other.battery", "distance", "known", "dist", "profile.risk", "profile"]) {
      expectCode(doc({ kind: "select", branches: [{ when: `${name} > 1`, then: leaf() }], else: leaf() }), "expr_unknown_name");
    }
  });

  it("rejects non-boolean conditions and malformed expressions with the grammar's codes", () => {
    expectCode(doc({ kind: "select", branches: [{ when: "dist.m + 1", then: leaf() }], else: leaf() }), "expr_type");
    expectCode(doc({ kind: "select", branches: [{ when: "dist.m <", then: leaf() }], else: leaf() }), "expr_syntax");
    expectCode(doc({ kind: "select", branches: [{ when: "x".repeat(300), then: leaf() }], else: leaf() }), "invalid_strategy"); // over the schema's length cap
  });

  it("rejects code-like conditions", () => {
    const attacks = [
      "constructor.constructor('return 1')()",
      "eval('1')",
      "(() => true)()",
      "import('x')",
      "process.exit()",
      "this.constructor",
      "__proto__.polluted == 1",
      "dist.m < 1; while(true){}",
      "`${1}` == '1'",
      "dist.m < 1 // comment",
      "dist.m.constructor",
    ];
    for (const when of attacks) {
      const r = validatePlanningStrategy(doc({ kind: "select", branches: [{ when, then: leaf() }], else: leaf() }));
      expect(r.ok, when).toBe(false);
      if (!r.ok) expect(String(r.error.code), when).toMatch(/^expr_/);
    }
  });

  it("evaluates nothing it was not given: a variable can be marked unavailable", () => {
    const r = doc({ kind: "select", branches: [{ when: "known.frac > 0.5", then: leaf() }], else: leaf() });
    expectCode(r, "condition_variable_unavailable", { unavailable: ["known.frac"] });
    expect(validatePlanningStrategy(r).ok).toBe(true);
  });

  it("points at the offending node", () => {
    const r = validatePlanningStrategy(doc({ kind: "fallback", stages: [leaf(), { kind: "select", branches: [{ when: "truth.x", then: leaf() }], else: leaf() }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path).toBe("/root/stages/1/branches/0/when");
  });
});

describe("hostile inputs", () => {
  it("rejects prototype pollution keys and does not touch Object.prototype", () => {
    const text = '{"schemaVersion":0,"id":"x","version":1,"__proto__":{"polluted":true},"root":{"kind":"algorithm","algorithm":"astar"}}';
    expect(code(parsePlanningStrategy(text))).toBe("invalid_strategy");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const nested = '{"schemaVersion":0,"id":"x","version":1,"root":{"kind":"algorithm","algorithm":"astar","__proto__":{"polluted":true}}}';
    expect(code(parsePlanningStrategy(nested))).toBe("invalid_strategy");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("does not recurse on a hostile depth (a few KB of nesting ends at the depth limit)", () => {
    let text = JSON.stringify(leaf());
    for (let i = 0; i < 400; i++) text = `{"kind":"refine","mode":"eager","local":{"kind":"algorithm","algorithm":"astar"},"coarse":${text}}`;
    const r = parsePlanningStrategy(`{"schemaVersion":0,"id":"x","version":1,"root":${text}}`);
    expect(code(r)).toMatch(/^(strategy_too_deep|strategy_too_large)$/);
  });

  it("treats code-like strings in data fields as plain, rejected data", () => {
    expectCode(doc(leaf("astar; rm -rf /")), "unknown_algorithm");
    expectCode(doc(leaf("${process.env.X}")), "unknown_algorithm");
    expectCode(doc(leaf(), { description: "x".repeat(600) }), "invalid_strategy");
  });
});

describe("content hash", () => {
  const a = doc(select(2)) as unknown as PlanningStrategy;
  it("is stable under key order and ignores metadata that does not change behavior", () => {
    const reordered = JSON.parse(JSON.stringify({ root: a.root, version: 1, id: "my-strategy", schemaVersion: 0 }));
    expect(strategyContentHash(reordered)).toBe(strategyContentHash(a));
    expect(strategyContentHash({ ...a, description: "other words", origin: "llm" })).toBe(strategyContentHash(a));
  });
  it("changes with the id, the version and any node", () => {
    const h = strategyContentHash(a);
    expect(strategyContentHash({ ...a, version: 2 })).not.toBe(h);
    expect(strategyContentHash({ ...a, id: "other" })).not.toBe(h);
    expect(strategyContentHash(doc(select(3)) as unknown as PlanningStrategy)).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("a strategy against an agent's budgets and profile (ADR-0037 §9)", () => {
  const profile = (p: unknown) => {
    const r = compileCostProfile(p);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const valid = (root: unknown) => {
    const r = validatePlanningStrategy(doc(root));
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  it("rejects a stage budget above the agent's total budget", () => {
    const s = valid({ kind: "fallback", stages: [leaf("astar", { stageBudget: 5000 }), leaf("hpa")] });
    expect(code(checkStrategyForAgent(s, { totalBudget: 4999, profile: profile({ weights: { distance: 1 } }) }))).toBe("stage_budget_exceeds_total");
    expect(checkStrategyForAgent(s, { totalBudget: 5000, profile: profile({ weights: { distance: 1 } }) }).ok).toBe(true);
    const any = valid({ kind: "anytime", weights: [2, 1], stageBudget: 9000 });
    expect(code(checkStrategyForAgent(any, { totalBudget: 8000, profile: profile({}) }))).toBe("stage_budget_exceeds_total");
  });
  it("rejects an hpa leaf under a turn-aware profile, wherever the leaf is", () => {
    const s = valid({ kind: "select", branches: [{ when: "dist.m > 100", then: { kind: "refine", coarse: leaf("hpa"), local: leaf(), mode: "eager" } }], else: leaf() });
    const turn = profile({ weights: { distance: 1, turn: 1 } });
    expect(code(checkStrategyForAgent(s, { totalBudget: 100000, profile: turn }))).toBe("profile_feature_unsupported");
    expect(checkStrategyForAgent(s, { totalBudget: 100000, profile: profile({}) }).ok).toBe(true);
    expect(checkStrategyForAgent(valid(leaf()), { totalBudget: 100000, profile: turn }).ok).toBe(true); // no hpa leaf: fine
  });
});

describe("where a lazy refine may sit (ADR-0037 fourth addition, item 9)", () => {
  const lazy = { kind: "refine", mode: "lazy", coarse: leaf("hpa"), local: leaf("astar") };
  it("at the root or below select branches, where its legs are the path the action drives", () => {
    expect(validatePlanningStrategy(doc(lazy)).ok).toBe(true);
    expect(validatePlanningStrategy(doc({ kind: "select", branches: [{ when: "dist.m > 50", then: lazy }], else: leaf("astar") })).ok).toBe(true);
    expect(validatePlanningStrategy(doc({ kind: "select", branches: [{ when: "dist.m > 50", then: { kind: "select", branches: [{ when: "known.frac > 0.5", then: lazy }], else: leaf("hpa") } }], else: leaf("astar") })).ok).toBe(true);
  });
  it("not under a fallback (a later failure would contradict legs already handed out), nor inside another refine", () => {
    const underFallback = validatePlanningStrategy(doc({ kind: "fallback", stages: [lazy, leaf("hpa")] }));
    expect(underFallback.ok).toBe(false);
    if (!underFallback.ok) {
      expect(underFallback.error.code).toBe("invalid_strategy");
      expect(underFallback.error.path).toBe("/root/stages/0");
    }
    expectCode(doc({ kind: "refine", mode: "eager", coarse: lazy, local: leaf("astar") }), "invalid_strategy");
    expectCode(doc({ kind: "refine", mode: "eager", coarse: leaf("hpa"), local: lazy }), "invalid_strategy");
    expectCode(doc({ kind: "fallback", stages: [leaf("astar", { stageBudget: 100 }), { kind: "select", branches: [{ when: "dist.m > 1", then: lazy }], else: leaf("hpa") }] }), "invalid_strategy");
  });
  it("eager refine has no such restriction", () => {
    const eager = { kind: "refine", mode: "eager", coarse: leaf("hpa"), local: leaf("astar") };
    expect(validatePlanningStrategy(doc({ kind: "fallback", stages: [eager, leaf("hpa")] })).ok).toBe(true);
    expect(validatePlanningStrategy(doc({ kind: "refine", mode: "eager", coarse: eager, local: leaf("astar") })).ok).toBe(true);
  });
});
