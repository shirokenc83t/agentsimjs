import { runLockstep, type SimAgent } from "@agentsim/core";
import { expect, it } from "vitest";
import { recordResults, summarize } from "../../../tools/bench/measure.ts";
import { buildReferenceRun } from "./testing/reference-run.ts";

// F1 acceptance (ROADMAP F1, tick budget split): tick time excluding the planning phase, p95 ≤ 1 ms with one
// agent moving. The whole world tick is timed (brains, planning phase, actions, reflexes, kinematics,
// battery, hash), but only on ticks where the moving agent is following its path before and after the
// tick, so no planning query runs in it. The planning phase is bounded separately (planning.slice20k).
it("world tick with one agent moving (planning phase idle)", async () => {
  const legs = [
    { name: "goTo", params: { xM: 50, yM: 10 } },
    { name: "goTo", params: { xM: 10, yM: 10 } },
    { name: "goTo", params: { xM: 50, yM: 10 } },
    { name: "goTo", params: { xM: 10, yM: 10 } },
  ];
  const run = buildReferenceRun({ scripts: { rover: legs } });
  const rover = run.agents.find((a) => a.key === "rover") as SimAgent;
  const following = () => run.runtime.info(rover.id)?.phase === "following";
  const samples: number[] = [];
  for (let t = 0; t < 8000 && samples.length < 3000; t++) {
    if (run.world.outstandingCount > 0) await run.world.decide();
    const before = following();
    const t0 = performance.now();
    run.scheduler.step();
    const ms = performance.now() - t0;
    if (before && following()) samples.push(ms);
  }
  // Warm-up: drop the first ticks of the run (JIT).
  const steady = samples.slice(200);
  expect(steady.length).toBeGreaterThan(1000);
  recordResults("node.json", { "sim.tickNoPlanning": summarize(steady) });
  await runLockstep(run.world, run.scheduler, 1); // the run is still consistent after the measurement
});
