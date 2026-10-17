import { runLockstep, type Brain, type DecisionRequest } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

class Explorer implements Brain {
  readonly tier = "baseline" as const;
  constructor(readonly id = "explorer") {}
  decide(req: DecisionRequest) {
    return Promise.resolve({ decision: req.self.running === null ? { kind: "action" as const, name: "explore", params: {} } : { kind: "idle" as const } });
  }
}

describe("the frontier witness answers exactly what a full regrouping answers (ADR-0005 addition: frontierExhausted)", () => {
  it("over an exploring run, with marks added and cleared, at every tick for every agent (property)", async () => {
    const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } } }, scripts: {}, brains: { rover: new Explorer(), low: new Explorer(), scout: new Explorer() } });
    const ids = run.agents.map((a) => a.id);
    let checks = 0;
    let withFrontier = 0;
    for (let tick = 1; tick <= 400; tick++) {
      await runLockstep(run.world, run.scheduler, 1);
      for (const id of ids) {
        // Mark a group now and then (as a failed goTo would), so the witness is sometimes invalidated by a mark.
        const groups = run.topology.of(id).frontierGroups();
        if (tick % 37 === 0 && groups.length > 0) {
          const g = groups[(tick / 37) % groups.length];
          if (g) {
            const gr = run.topology.of(id).grid;
            run.topology.markAt(id, gr.cellCenterX(g.point % gr.sizeX), gr.cellCenterY((g.point / gr.sizeX) | 0), tick * 0.1);
          }
        }
        // The witness path first (it may regroup only part of the map), then the full check on the same state.
        const witness = run.topology.hasUnmarkedFrontier(id);
        if (tick % 2 === 0) {
          const full = run.topology
            .of(id)
            .frontierGroups()
            .some((f) => !run.topology.isMarkedGroup(id, f));
          expect(witness, `${id} at tick ${tick}`).toBe(full);
          checks++;
          if (full) withFrontier++;
        }
      }
    }
    expect(checks).toBeGreaterThan(500);
    expect(withFrontier).toBeGreaterThan(50); // the property is exercised on both answers
    expect(withFrontier).toBeLessThan(checks);
  }, 120000);
});
