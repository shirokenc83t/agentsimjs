import { runLockstep } from "@agentsim/core";
import { AgentTopology, DEFAULT_TOPOLOGY } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

const UNKNOWN = { beliefs: { default: { init: "unknown" as const } } };

describe("topology in runs (ADR-0039)", () => {
  it("resolves field by field (default → byKind → byAgent), enters effectiveConfigHash, and checks regionChunks", () => {
    const base = buildReferenceRun({ scripts: {} });
    const run = buildReferenceRun({
      scripts: {},
      runConfig: { topology: { default: { maxRegions: 10 }, byKind: { uav: { regionChunks: 2 } }, byAgent: { rover: { maxFrontiers: 3 } } } },
    });
    const of = (key: string) => run.resolved.agents.find((a) => a.key === key)?.topology;
    expect(of("rover")).toEqual({ ...DEFAULT_TOPOLOGY, maxRegions: 10, maxFrontiers: 3 });
    expect(of("scout")).toEqual({ ...DEFAULT_TOPOLOGY, maxRegions: 10, regionChunks: 2 });
    expect(run.resolved.effectiveConfigHash).not.toBe(base.resolved.effectiveConfigHash);
    for (const bad of [0, 17]) {
      expect(() => buildReferenceRun({ scripts: {}, runConfig: { topology: { default: { regionChunks: bad } } } })).toThrow(/regionChunks must be in \[1, 16\]/);
    }
  });

  it("is maintained during a run with sensing; after every 10 ticks it equals a full rebuild from the same map", async () => {
    const run = buildReferenceRun({ runConfig: { ...UNKNOWN, topology: { default: { regionChunks: 1, minFrontierCells: 2 } } } });
    for (let k = 0; k < 15; k++) {
      await runLockstep(run.world, run.scheduler, 10);
      for (const a of run.agents) {
        const t = run.topology.of(a.id);
        const full = new AgentTopology(t.grid, t.config);
        full.update();
        expect(t.regions(), `${a.id} tick ${(k + 1) * 10}`).toEqual(full.regions());
        expect(t.frontierGroups()).toEqual(full.frontierGroups());
      }
    }
    // Agents that have sensed something have frontiers.
    expect(run.agents.some((a) => run.topology.of(a.id).frontierGroups().length > 0)).toBe(true);
  });

  it("an ideal agent's layer is built on the ground truth (no frontiers)", async () => {
    const run = buildReferenceRun({});
    await runLockstep(run.world, run.scheduler, 5);
    for (const a of run.agents) expect(run.topology.of(a.id).frontierGroups()).toEqual([]);
  });
});
