import { knownFractionAlong } from "@agentsim/algorithms";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { f2DiscoveryScenario, f2PriorReferenceScenario, f2PriorRunConfig, f2RunConfig, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { ScenarioDocument } from "../schema.ts";
import { createRun } from "./run.ts";

// ADR-0037 addition of 2026-10-13: `known.frac` is 1 for an `ideal` agent (its map is the ground truth) and is computed on
// the belief map for every other agent, a prior's included.
function start(doc: ScenarioDocument, rc: RunConfigDocument) {
  const loaded = loadScenario(doc);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const resolved = resolveRunConfig(rc, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  return createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1, beliefVsTruth: {} });
}
/** `known.frac` on the agent's own planning map along a segment, the way the planner will see it. */
function knownFrac(run: ReturnType<typeof start>, key: string, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const id = run.agents.find((a) => a.key === key)?.id ?? "";
  const view = run.planner.liveView(id);
  if (!view) throw new Error(`no planning view for ${key}`);
  return knownFractionAlong(view.grid, from, to);
}

describe("known.frac on real agents' maps", () => {
  it("is 1 for an ideal agent and 0 far from where an unknown-start agent has looked", () => {
    const rc = f2RunConfig(F2_DISCOVERY_ID, 1);
    const unknownStart = start(f2DiscoveryScenario(), rc);
    expect(knownFrac(unknownStart, "rover", { x: 50, y: 50 }, { x: 60, y: 20 })).toBe(0); // never observed (tick 0)
    const ideal = start(f2DiscoveryScenario(), { ...rc, beliefs: { default: { init: "ideal" } } });
    expect(knownFrac(ideal, "rover", { x: 50, y: 50 }, { x: 60, y: 20 })).toBe(1);
    expect(knownFrac(ideal, "scout", { x: 1, y: 1 }, { x: 62, y: 62 })).toBe(1);
  });

  it("is computed on a prior agent's belief map: where the prior knows, 1; beside an unknown-start agent, 0", () => {
    const doc = f2PriorReferenceScenario();
    const run = start(doc, { ...f2PriorRunConfig(1), beliefs: { default: { init: "unknown" }, byAgent: { rover: { init: { prior: "survey" } } } } });
    const across = { from: { x: 100, y: 300 }, to: { x: 900, y: 700 } };
    expect(knownFrac(run, "rover", across.from, across.to)).toBeGreaterThan(0.99); // the survey knows the whole map
    expect(knownFrac(run, "scout", across.from, across.to)).toBe(0); // the scout started with an unknown map
  }, 60000);
});
