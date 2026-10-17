import { runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";
import { startStrategyTest, type StrategyTestRequest, type StrategyTestResult, type StrategyTestRun } from "./strategy-test.ts";

/*
 * The researcher's "test on map" sandbox (ADR-0037 seventh addition, item 16). The point of the design is isolation: a
 * separate planner over a snapshot copy of the agent's belief map (or the read-only ground truth), no run id, no trace,
 * no effect on any hash. These tests pin what it computes and, above all, that it leaves the run alone.
 */

const astar = { kind: "algorithm", algorithm: "astar" };
const hpa = { kind: "algorithm", algorithm: "hpa" };
const doc = (root: unknown, id = "sandbox") => ({ schemaVersion: 0 as const, id, version: 1, origin: "human" as const, root });

/** A run whose rovers plan on an `unknown` map: the closed box at (50, 40) is reachable on their map, not on the truth. */
const unknownMaps = { beliefs: { default: { init: "unknown" as const } } };

function finish(t: StrategyTestRun, slice = 1000): StrategyTestResult {
  while (!t.step(slice)) {
    /* keep stepping */
  }
  const r = t.result();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function start(run: ReturnType<typeof buildReferenceRun>, req: Partial<StrategyTestRequest> = {}): StrategyTestRun {
  const r = startStrategyTest(run, run.resolved, { agentId: "ugv-001", to: { xM: 50, yM: 20 }, map: "belief", ...req });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

describe("what the sandbox computes", () => {
  it("plans from the agent's current position with the agent's own planner when no strategy is given", () => {
    const run = buildReferenceRun({ runConfig: { ...unknownMaps, planning: { default: { algorithm: "hpa" } } } });
    const r = finish(start(run));
    expect(r.status).toBe("found");
    expect(r.planner).toBe("hpa");
    expect(Math.hypot((r.waypoints[0]?.[0] ?? 0) - 10, (r.waypoints[0]?.[1] ?? 0) - 10)).toBeLessThan(0.5); // the rover's start (cell centre)
    expect(r.strategy).toBeUndefined();
    expect(r.ticks).toBeGreaterThanOrEqual(1);
  });

  it("a strategy given as a preset reference or inline is validated and traced with each search's geometry", () => {
    const run = buildReferenceRun({ runConfig: unknownMaps });
    const preset = finish(start(run, { strategy: { ref: "astar-then-hpa", version: 1 } }));
    expect(preset.planner).toBe("strategy:astar-then-hpa@1");
    expect(preset.strategy?.searches[0]?.waypoints?.length).toBeGreaterThan(1);
    const inline = finish(start(run, { strategy: doc({ kind: "select", branches: [{ when: "dist.m <= 5", then: astar }], else: hpa }) }));
    expect(inline.planner).toBe("strategy:sandbox@1");
    expect(inline.strategy?.selects[0]).toMatchObject({ branch: "else" });
  });

  it("equals what the agent's own planner computes on the same state (checked on an identical twin run)", () => {
    const strategy = { ref: "astar-then-hpa", version: 1 } as const;
    const twin = buildReferenceRun({ runConfig: { ...unknownMaps, planning: { default: { strategy } } } });
    const own = twin.planner.submit("ugv-001", { from: { x: 10, y: 10 }, to: { x: 50, y: 20 } }, 1);
    if (!own.ok) throw new Error(own.error.message);
    let outcome;
    for (let tick = 1; !outcome && tick < 5000; tick++) {
      twin.planner.advance(tick);
      outcome = twin.planner.take("ugv-001", own.value);
    }
    const run = buildReferenceRun({ runConfig: unknownMaps });
    const sandbox = finish(start(run, { strategy }));
    expect(sandbox.status).toBe(outcome?.status);
    expect(sandbox.waypoints).toEqual(outcome?.waypoints);
    expect(sandbox.expansionsCharged).toBe(outcome?.expansionsCharged);
  });

  it("belief and truth can disagree: the closed box is reachable on an unknown map and not on the ground truth", () => {
    const run = buildReferenceRun({ runConfig: unknownMaps });
    const belief = finish(start(run, { to: { xM: 50, yM: 40 }, map: "belief" }));
    const truth = finish(start(run, { to: { xM: 50, yM: 40 }, map: "truth" }));
    expect(belief.status).toBe("found");
    expect(belief.map).toBe("belief");
    expect(truth.status).toBe("not_found");
    expect(truth.map).toBe("truth");
  });

  it("an ideal agent's own map is the ground truth: a belief request reports `truth`, so it is branded as researcher data", () => {
    const run = buildReferenceRun(); // ideal by default
    const r = finish(start(run, { map: "belief" }));
    expect(r.map).toBe("truth");
  });

  it("a lazy refine lists its legs with the tick each became ready; an eager one has none", () => {
    const run = buildReferenceRun({ runConfig: { ...unknownMaps, planning: { default: { onboardComputeExpansionsPerTick: 100 } } } });
    const root = (mode: "lazy" | "eager") => doc({ kind: "refine", mode, coarse: hpa, local: astar }, mode);
    const lazy = finish(start(run, { strategy: root("lazy"), to: { xM: 55, yM: 55 } }));
    const eager = finish(start(run, { strategy: root("eager"), to: { xM: 55, yM: 55 } }));
    expect(eager.legs).toEqual([]);
    expect(lazy.legs.length).toBeGreaterThan(1);
    expect(lazy.legs.at(-1)?.last).toBe(true);
    expect(lazy.legs[0]?.tick).toBeLessThan(eager.ticks);
    expect(lazy.status).toBe(eager.status);
  });

  it("the result does not depend on how the query is sliced into polls", () => {
    const run = buildReferenceRun({ runConfig: unknownMaps });
    const req = { strategy: { ref: "astar-then-hpa", version: 1 } as const, to: { xM: 55, yM: 55 } };
    expect(finish(start(run, req), 1)).toEqual(finish(start(run, req), 7));
    expect(finish(start(run, req), 1)).toEqual(finish(start(run, req), 100_000));
  });

  it("is a snapshot: map changes after it started do not alter the result", async () => {
    const run = buildReferenceRun({ runConfig: { ...unknownMaps }, scripts: { rover: [{ name: "goTo", params: { xM: 50, yM: 10 } }] } });
    const t = start(run, { to: { xM: 50, yM: 20 } });
    const frozen = finish(start(buildReferenceRun({ runConfig: unknownMaps }), { to: { xM: 50, yM: 20 } }));
    await runLockstep(run.world, run.scheduler, 400); // the rover senses and its map changes while the sandbox is mid-query
    expect(finish(t)).toEqual(frozen);
  });
});

describe("refusals have stable codes and never throw", () => {
  const run = buildReferenceRun({ runConfig: unknownMaps });
  const code = (req: Partial<StrategyTestRequest>) => {
    const r = startStrategyTest(run, run.resolved, { agentId: "ugv-001", to: { xM: 50, yM: 20 }, map: "belief", ...req });
    return r.ok ? "ok" : [r.error.code, r.error.path];
  };

  it("an unknown agent, an unknown preset, a bad strategy and a target off the map", () => {
    expect(code({ agentId: "ugv-999" })[0]).toBe("unknown_agent");
    expect(code({ strategy: { ref: "nope", version: 1 } })[0]).toBe("strategy_not_found");
    const bad = code({ strategy: doc({ kind: "select", branches: [{ when: "nonsense > 1", then: astar }], else: hpa }) });
    expect(bad[0]).toBe("expr_unknown_name");
    expect(String(bad[1])).toContain("/strategy");
    expect(code({ strategy: doc({ kind: "refine", mode: "lazy", coarse: hpa, local: astar }, "x") })).toBe("ok");
    expect(code({ to: { xM: 1e6, yM: 1e6 } })[0]).toBe("invalid_endpoint");
  });

  it("code-like content in a condition is rejected as data", () => {
    expect(code({ strategy: doc({ kind: "select", branches: [{ when: "constructor.constructor('x')()", then: astar }], else: hpa }) })[0]).toMatch(/^expr_|invalid_strategy/);
  });
});

describe("the run is left exactly as it was (purity)", () => {
  async function drive(withSandbox: boolean) {
    const run = buildReferenceRun({ runConfig: unknownMaps, planningCachesEnabled: true });
    const checkpoints: string[] = [];
    let calls = 0;
    for (let n = 0; n < 6; n++) {
      if (withSandbox) {
        const strategies = [undefined, { ref: "astar-then-hpa", version: 1 } as const, doc({ kind: "refine", mode: "lazy", coarse: hpa, local: astar }, "lazy")];
        for (const map of ["belief", "truth"] as const) {
          for (const strategy of strategies) {
            finish(start(run, { map, ...(strategy ? { strategy } : {}), to: { xM: 55, yM: 55 } }), 3);
            calls++;
          }
        }
        // Invalid requests too.
        expect(startStrategyTest(run, run.resolved, { agentId: "nobody", to: { xM: 1, yM: 1 }, map: "belief" }).ok).toBe(false);
      }
      await runLockstep(run.world, run.scheduler, 100);
      checkpoints.push(run.world.stateHash);
    }
    return { run, checkpoints, calls };
  }

  it("a live run with sandbox calls between its ticks has the state hash at every checkpoint, the whole trace and the planner's snapshot of one without", async () => {
    const control = await drive(false);
    const probed = await drive(true);
    expect(probed.calls).toBeGreaterThan(30);
    expect(probed.checkpoints).toEqual(control.checkpoints);
    expect(JSON.stringify(probed.run.trace.all())).toBe(JSON.stringify(control.run.trace.all()));
    expect(probed.run.planner.service.snapshot()).toEqual(control.run.planner.service.snapshot());
    expect(probed.run.planner.service.diagnostics).toEqual(control.run.planner.service.diagnostics);
  }, 120_000);

  it("two identical requests give identical results", () => {
    const run = buildReferenceRun({ runConfig: unknownMaps });
    const a = finish(start(run, { to: { xM: 55, yM: 55 } }));
    const b = finish(start(run, { to: { xM: 55, yM: 55 } }));
    expect(b).toEqual(a);
  });
});
