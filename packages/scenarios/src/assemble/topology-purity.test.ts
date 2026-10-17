import { compileCostProfile, SearchSpace } from "@agentsim/algorithms";
import { runLockstep } from "@agentsim/core";
import { buildSpaceSummary } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";
import { traversalFor } from "../traversal.ts";
import { passabilityOf } from "./topology.ts";

/**
 * Laziness is observationally pure (ADR-0039 addition of 2026-10-10): frontier groups and edges computed on demand
 * are memoized only. Building the summary an Inspector shows, at every tick, changes no state hash and no trace.
 */
async function runOnce(poll: boolean) {
  const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } }, topology: { default: { regionChunks: 1 } } } });
  const hashes: string[] = [];
  for (let t = 0; t < 150; t++) {
    await runLockstep(run.world, run.scheduler, 1);
    if (poll) {
      for (const cfg of run.resolved.agents) {
        const topo = run.topology.of(cfg.agentId);
        const profile = compileCostProfile(cfg.planning.costProfile);
        if (!profile.ok) throw new Error(profile.error.message);
        const agent = run.agents.find((a) => a.id === cfg.agentId);
        buildSpaceSummary(topo, passabilityOf(new SearchSpace(topo.grid, traversalFor(cfg), profile.value)), { xM: agent?.state.x ?? 0, yM: agent?.state.y ?? 0 });
      }
    }
    hashes.push(run.world.stateHash);
  }
  return { hashes, trace: run.trace.all().map((r) => ({ ...r, wallTime: 0 })) };
}

describe("topology laziness is observationally pure", () => {
  it("the same run with the summary polled every tick and never polled: identical state hashes and traces", async () => {
    const polled = await runOnce(true);
    const quiet = await runOnce(false);
    expect(polled.hashes).toEqual(quiet.hashes);
    expect(polled.trace).toEqual(quiet.trace);
  });
});
