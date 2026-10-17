import { runLockstep, TRAIL_STRIDE, type SimAgent } from "@agentsim/core";
import { buildReferenceRun } from "../../../../packages/scenarios/src/testing/reference-run.ts";
import { describe, expect, it } from "vitest";
import { TrailRecorder } from "./trail-recorder.ts";
import { TrailStore } from "./trail-store.ts";

// Two 1,500-tick reference runs with sensing on (F2): in the `determinism` test project.
describe("executed paths from simulation state (reference run)", () => {
  it("is a pure function of the run's ticks: identical across runs and whatever the delivery cadence", async () => {
    async function recorded(ticks: number, drainEvery: number): Promise<number[][]> {
      const run = buildReferenceRun();
      const rec = new TrailRecorder(run.agents.length);
      const store = new TrailStore(run.agents.length);
      const observe = () => run.agents.forEach((a: SimAgent, i) => rec.observe(i, a.state.x, a.state.y, a.kind === "uav" ? a.state.z : 0));
      const drain = () => {
        const d = rec.drain();
        if (d) store.apply(d);
      };
      observe();
      for (let t = 1; t <= ticks; t++) {
        await runLockstep(run.world, run.scheduler, 1);
        observe();
        if (t % drainEvery === 0) drain();
      }
      drain();
      const out: number[][] = [];
      for (let i = 0; i < run.agents.length; i++) out.push(Array.from(store.path(i).points));
      return out;
    }
    const a = await recorded(1500, 1);
    const b = await recorded(1500, 37);
    expect(a.flat().length / TRAIL_STRIDE).toBeGreaterThan(500); // the agents moved
    expect(b).toEqual(a);
  });
});
