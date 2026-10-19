import { runLockstep } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import { f2DiscoveryScenario, f2RunConfig, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { resolveRunConfig, type ResolvedRunConfig } from "../run-config/resolve.ts";
import { createRun } from "./run.ts";

// ADR-0040 in a full run: the F2 discovery rover explores its whole map in iterations, every search it makes carries a window,
// the temporary marks do not outlive the action, and the run repeats exactly.

function discovery(radiusM?: number): { resolved: ResolvedRunConfig; loaded: LoadedScenario } {
  const loaded = loadScenario(f2DiscoveryScenario());
  if (!loaded.ok) throw new Error(loaded.error.message);
  const base = f2RunConfig(F2_DISCOVERY_ID, 1);
  const doc = radiusM === undefined ? base : { ...base, planning: { ...base.planning, default: { ...base.planning?.default, radiusM } } };
  const resolved = resolveRunConfig(doc, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  return { resolved: resolved.value, loaded: loaded.value };
}

async function exploreRover(radiusM: number | undefined, ticks: number) {
  const { resolved, loaded } = discovery(radiusM);
  const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
  const run = createRun(loaded, resolved, trace, { dtS: 0.1 });
  const rover = run.agents.find((a) => a.key === "rover");
  if (!rover) throw new Error("rover");
  run.world.inject({ agentId: rover.id, name: "explore", params: {} });
  await runLockstep(run.world, run.scheduler, ticks);
  return { run, trace, rover };
}

describe("explore in iterations, on the F2 discovery map (ADR-0040)", () => {
  it("the rover explores to frontier_exhausted: iterations with a window on every target, no temporary mark left behind", async () => {
    const { run, trace, rover } = await exploreRover(undefined, 2600);
    const mine = trace.all().filter((r) => r.agentId === rover.id);
    const end = mine.find((r) => r.kind === "action" && (r.payload as { op?: string; name?: string }).op === "end" && (r.payload as { name?: string }).name === "explore");
    expect((end?.payload as { status?: string; result?: { reason: string } }).status).toBe("succeeded");
    expect((end?.payload as { result?: { reason: string } }).result?.reason).toBe("frontier_exhausted");
    const iterations = mine.filter((r) => (r.payload as { op?: string }).op === "explore-iteration").map((r) => r.payload as { event: string; iteration: number; radiusM: number; window: number[]; centre: number[] });
    expect(iterations.filter((i) => i.event === "start").length).toBeGreaterThanOrEqual(2);
    expect(iterations.filter((i) => i.event === "end").length).toBe(iterations.filter((i) => i.event === "start").length);
    for (const i of iterations.filter((x) => x.event === "start")) {
      expect(i.radiusM).toBe(40); // the built-in default for a ground vehicle
      expect(i.window).toEqual([i.centre[0] as number - 50, i.centre[1] as number - 50, i.centre[0] as number + 50, i.centre[1] as number + 50]); // 2 (R + margin) = 100 m
    }
    const selected = mine.filter((r) => (r.payload as { op?: string; event?: string }).op === "explore-target" && (r.payload as { event?: string }).event === "selected");
    expect(selected.length).toBeGreaterThan(5);
    for (const t of selected) expect((t.payload as { window?: number[] }).window).toHaveLength(4);
    const snap = run.topology.snapshot().agents.find((a) => a.agentId === rover.id);
    expect(snap?.temporary?.cells ?? []).toEqual([]);
  }, 240_000);

  it("a radius of the action overrides the configured one, and the same run repeats exactly", async () => {
    const hashes: string[] = [];
    const starts: number[][] = [];
    for (let k = 0; k < 2; k++) {
      const { resolved, loaded } = discovery(15);
      const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
      const run = createRun(loaded, resolved, trace, { dtS: 0.1 });
      const rover = run.agents.find((a) => a.key === "rover");
      if (!rover) throw new Error("rover");
      run.world.inject({ agentId: rover.id, name: "explore", params: { radiusM: 25 } });
      await runLockstep(run.world, run.scheduler, 700);
      hashes.push(run.world.stateHash);
      starts.push(trace.all().filter((r) => r.agentId === rover.id && (r.payload as { op?: string; event?: string }).op === "explore-iteration" && (r.payload as { event?: string }).event === "start").map((r) => (r.payload as { radiusM: number }).radiusM));
    }
    expect(hashes[1]).toBe(hashes[0]);
    expect(starts[0]?.length).toBeGreaterThan(0);
    expect(new Set(starts[0])).toEqual(new Set([25]));
    expect(starts[1]).toEqual(starts[0]);
  }, 240_000);
});
