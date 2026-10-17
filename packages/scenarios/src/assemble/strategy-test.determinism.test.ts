import { runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";
import { startStrategyTest, type StrategyTestRequest } from "./strategy-test.ts";

/*
 * The strategy sandbox leaves a live run exactly as it was (ADR-0037 seventh addition, item 16), over a whole reference run
 * with sensing, exploring beliefs and replanning: sandbox queries on both maps, with eager and lazy strategies, valid and
 * refused, between every 100 ticks change nothing: not the state hash at any checkpoint, not one trace record, not the
 * planning service's snapshot or diagnostics. Long, so it runs with `pnpm test:determinism`.
 */

const TICKS = 1500;
const astar = { kind: "algorithm", algorithm: "astar" };
const hpa = { kind: "algorithm", algorithm: "hpa" };
const lazy = { schemaVersion: 0 as const, id: "lazy", version: 1, origin: "human" as const, root: { kind: "refine", mode: "lazy", coarse: hpa, local: astar } };
const unknownMaps = { beliefs: { default: { init: "unknown" as const } }, planning: { default: { strategy: { ref: "astar-then-hpa", version: 1 } } } } as never;

const REQUESTS: readonly Partial<StrategyTestRequest>[] = [
  { map: "belief" },
  { map: "truth" },
  { map: "belief", strategy: { ref: "short-astar-long-hpa", version: 1 } },
  { map: "truth", strategy: lazy },
  { map: "belief", strategy: lazy, agentId: "uav-001" },
  { map: "belief", agentId: "ugv-002", to: { xM: 60, yM: 5 } },
];

async function drive(withSandbox: boolean) {
  const run = buildReferenceRun({ runConfig: unknownMaps });
  const checkpoints: string[] = [];
  let answered = 0;
  for (let done = 0; done < TICKS; done += 100) {
    if (withSandbox) {
      for (const r of REQUESTS) {
        const t = startStrategyTest(run, run.resolved, { agentId: "ugv-001", to: { xM: 55, yM: 55 }, map: "belief", ...r });
        if (!t.ok) continue;
        while (!t.value.step(500)) {
          /* sliced as the host would */
        }
        if (t.value.result().ok) answered++;
      }
      startStrategyTest(run, run.resolved, { agentId: "nobody", to: { xM: 1, yM: 1 }, map: "truth" });
    }
    await runLockstep(run.world, run.scheduler, 100);
    checkpoints.push(run.world.stateHash);
  }
  return { run, checkpoints, answered };
}

describe("the sandbox never changes a run (whole reference run)", () => {
  it("state hash at every checkpoint, the whole trace, the planner's snapshot and diagnostics are those of a run without sandbox calls", async () => {
    const control = await drive(false);
    const probed = await drive(true);
    expect(probed.answered).toBeGreaterThan(40);
    expect(probed.checkpoints).toEqual(control.checkpoints);
    expect(JSON.stringify(probed.run.trace.all())).toBe(JSON.stringify(control.run.trace.all()));
    expect(probed.run.planner.service.snapshot()).toEqual(control.run.planner.service.snapshot());
    expect(probed.run.planner.service.diagnostics).toEqual(control.run.planner.service.diagnostics);
    expect(probed.run.trace.all().length).toBeGreaterThan(100);
  }, 600_000);
});
