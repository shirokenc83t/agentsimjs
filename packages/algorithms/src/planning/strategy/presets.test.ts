import { describe, expect, it } from "vitest";
import golden from "./presets.golden.json";
import { PLANNING_STRATEGY_PRESETS, presetStrategy } from "./presets.ts";
import { strategyContentHash, validatePlanningStrategy } from "./validate.ts";

describe("shipped planning strategies (ADR-0037 §7)", () => {
  it("are the five named presets, at version 1", () => {
    expect(PLANNING_STRATEGY_PRESETS.map((p) => `${p.id}@${p.version}`)).toEqual([
      "anytime-weighted@1",
      "astar-only@1",
      "astar-then-hpa@1",
      "hpa-only@1",
      "short-astar-long-hpa@1",
    ]);
  });

  it("every preset passes the validator unchanged, with no space restriction", () => {
    for (const p of PLANNING_STRATEGY_PRESETS) {
      const r = validatePlanningStrategy(JSON.parse(JSON.stringify(p)));
      expect(r.ok, p.id).toBe(true);
      expect(p.origin, p.id).toBe("human");
    }
  });

  it("are looked up by id and version, and never by a version that does not exist", () => {
    expect(presetStrategy({ ref: "astar-only", version: 1 })?.id).toBe("astar-only");
    expect(presetStrategy({ ref: "astar-only", version: 2 })).toBeUndefined();
    expect(presetStrategy({ ref: "nope", version: 1 })).toBeUndefined();
    expect(presetStrategy({ ref: "__proto__", version: 1 })).toBeUndefined();
    expect(presetStrategy({ ref: "constructor", version: 1 })).toBeUndefined();
  });

  it("have the shapes the ROADMAP asks for", () => {
    const get = (id: string) => presetStrategy({ ref: id, version: 1 })?.root;
    expect(get("astar-only")).toEqual({ kind: "algorithm", algorithm: "astar" });
    expect(get("hpa-only")).toEqual({ kind: "algorithm", algorithm: "hpa" });
    const sel = get("short-astar-long-hpa");
    expect(sel?.kind).toBe("select");
    if (sel?.kind === "select") {
      expect(sel.branches).toHaveLength(1);
      expect(sel.branches[0]?.when).toMatch(/^dist\.m /);
      expect(sel.branches[0]?.then).toEqual({ kind: "algorithm", algorithm: "astar" });
      expect(sel.else).toEqual({ kind: "algorithm", algorithm: "hpa" });
    }
    const fb = get("astar-then-hpa");
    expect(fb?.kind).toBe("fallback");
    if (fb?.kind === "fallback") {
      expect(fb.stages.map((s) => (s.kind === "algorithm" ? s.algorithm : s.kind))).toEqual(["astar", "hpa"]);
      expect(fb.stages[0]).toHaveProperty("stageBudget");
    }
    const any = get("anytime-weighted");
    expect(any?.kind === "anytime" ? any.weights : undefined).toEqual([3, 2, 1.5, 1]);
  });

  it("match the golden documents and content hashes (a change needs an explanation and a new version)", () => {
    expect(JSON.parse(JSON.stringify(PLANNING_STRATEGY_PRESETS))).toEqual(golden.presets);
    expect(Object.fromEntries(PLANNING_STRATEGY_PRESETS.map((p) => [`${p.id}@${p.version}`, strategyContentHash(p)]))).toEqual(golden.hashes);
  });
});
