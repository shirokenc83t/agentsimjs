import { runLockstep } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { f2DiscoveryScenario, f2RunConfig, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import { watchTruth } from "../testing/truth-watch.ts";
import { createRun } from "./run.ts";

/**
 * ADR-0033 addition of 2026-10-12 and ADR-0005: the escape search (its clearance queries and bare-footprint checks) reads
 * the agent's own planning view, never the ground truth. The instrument counts ground-truth cell reads while
 * `ActionRuntime.findEscape` runs, for a belief agent whose explore escapes the planning band beside the box wall.
 */
describe("the escape search reads no ground truth for a belief agent", () => {
  it("explore started at tick 60 on the F2 discovery map: the escape runs, with zero ground-truth reads", async () => {
    const loaded = loadScenario(f2DiscoveryScenario());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const resolved = resolveRunConfig(f2RunConfig(F2_DISCOVERY_ID, 1), { loaded: loaded.value, version: 1 });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
    const run = createRun(loaded.value, resolved.value, trace, { dtS: 0.1 });
    const truth = watchTruth(run.spatial);
    // The behaviour class of goTo is private to the runtime: reach its prototype through a running instance (a goTo of
    // another agent), then wrap `findEscape` there so every instance, including explore's goTo legs, is measured.
    const other = run.agents.find((a) => a.key === "low");
    run.world.inject({ agentId: other?.id ?? "", name: "goTo", params: { xM: 12, yM: 20 } });
    await runLockstep(run.world, run.scheduler, 2);
    const active = (run.runtime as unknown as { active: Map<string, { behavior: object }> }).active;
    const proto = Object.getPrototypeOf(active.get(other?.id ?? "")?.behavior) as { findEscape: (...a: unknown[]) => unknown };
    expect(typeof proto.findEscape).toBe("function");
    const original = proto.findEscape;
    let searches = 0;
    proto.findEscape = function (this: unknown, ...a: unknown[]) {
      searches++;
      return truth.during(() => original.apply(this, a));
    };
    try {
      const rover = run.agents.find((a) => a.key === "rover");
      await runLockstep(run.world, run.scheduler, 58);
      run.world.inject({ agentId: rover?.id ?? "", name: "explore", params: {} });
      await runLockstep(run.world, run.scheduler, 1700); // its first escape comes at about tick 1,725 of the run
    } finally {
      proto.findEscape = original;
    }
    const escapes = trace.all().filter((r) => (r.payload as { op?: string; kind?: string }).op === "recovery" && (r.payload as { kind?: string }).kind === "escape");
    expect(searches, "the escape search ran").toBeGreaterThan(0);
    expect(escapes.length).toBeGreaterThan(0);
    expect(truth.hits).toEqual([]);
  }, 240000);

  it("positive control: the instrument sees ground-truth reads made inside the same wrapper", async () => {
    const loaded = loadScenario(f2DiscoveryScenario());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const resolved = resolveRunConfig(f2RunConfig(F2_DISCOVERY_ID, 1), { loaded: loaded.value, version: 1 });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const run = createRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 1_000_000), { dtS: 0.1 });
    const truth = watchTruth(run.spatial);
    truth.during(() => run.spatial.grid.isBlocked(60, 10));
    expect(truth.hits.length).toBeGreaterThan(0);
  });
});
