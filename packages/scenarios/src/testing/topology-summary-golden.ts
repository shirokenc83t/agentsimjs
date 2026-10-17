import { compileCostProfile, SearchSpace } from "@agentsim/algorithms";
import { runLockstep } from "@agentsim/core";
import { buildSpaceSummary } from "@agentsim/spatial";
import { expect } from "vitest";
import { passabilityOf } from "../assemble/topology.ts";
import { canonicalJson, hash32Hex } from "../canonical.ts";
import { traversalFor } from "../traversal.ts";
import golden from "./topology-summary.golden.json";
import { buildReferenceRun } from "./reference-run.ts";

export const SUMMARY_TICKS = 200;

/**
 * ADR-0039 §6 determinism: the F1 reference run with `unknown` beliefs and small regions; after SUMMARY_TICKS ticks,
 * every agent's `space` summary (against its planning view) is hashed. The hash must be identical in Node, Chromium
 * and Firefox.
 */
export async function computeSummaryHash(): Promise<string> {
  const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } }, topology: { default: { regionChunks: 1, minFrontierCells: 2 } } } });
  await runLockstep(run.world, run.scheduler, SUMMARY_TICKS);
  const summaries = run.resolved.agents.map((cfg) => {
    const topo = run.topology.of(cfg.agentId);
    const profile = compileCostProfile(cfg.planning.costProfile);
    if (!profile.ok) throw new Error(profile.error.message);
    const view = passabilityOf(new SearchSpace(topo.grid, traversalFor(cfg), profile.value));
    const agent = run.agents.find((a) => a.id === cfg.agentId);
    return buildSpaceSummary(topo, view, { xM: agent?.state.x ?? 0, yM: agent?.state.y ?? 0 });
  });
  // A meaningful golden: agents have discovered frontiers and several regions.
  if (!summaries.some((s) => s.frontiers.length > 0 && s.regions.length > 1)) throw new Error("summaries are trivial");
  return hash32Hex(canonicalJson(summaries));
}

/** Shared assertion for the Node and cross-engine runs. Regenerate with the reference-run golden (tools/golden). */
export async function expectSummaryMatchesGolden(): Promise<void> {
  expect(golden.ticks).toBe(SUMMARY_TICKS);
  expect(await computeSummaryHash()).toBe(golden.summaryHash);
}
