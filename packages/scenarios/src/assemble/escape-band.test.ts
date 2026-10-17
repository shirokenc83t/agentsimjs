import { runLockstep } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { f2DiscoveryScenario, f2RunConfig, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import { createRun } from "./run.ts";

/**
 * ADR-0033 addition of 2026-10-12 (escape from the inflation band): an explore started at tick 101 on the F2 discovery map
 * used to stop 0.75 m from the closed box's wall, inside its own planning clearance, where no straight reverse of 3 m gets
 * out (the whole strip along the wall is inside the band) and the action failed `kinematically_infeasible`.
 */
async function exploreFrom(startTick: number) {
  const loaded = loadScenario(f2DiscoveryScenario());
  if (!loaded.ok) throw new Error(loaded.error.message);
  const resolved = resolveRunConfig(f2RunConfig(F2_DISCOVERY_ID, 1), { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
  const run = createRun(loaded.value, resolved.value, trace, { dtS: 0.1, beliefVsTruth: {} });
  const rover = run.agents.find((a) => a.key === "rover");
  if (!rover) throw new Error("no rover");
  if (startTick > 1) await runLockstep(run.world, run.scheduler, startTick - 1);
  run.world.inject({ agentId: rover.id, name: "explore", params: {} });
  for (let k = 0; k < 60; k++) {
    await runLockstep(run.world, run.scheduler, 100);
    const end = trace.all().find((r) => r.agentId === rover.id && r.kind === "action" && (r.payload as { op?: string; name?: string }).op === "end" && (r.payload as { name?: string }).name === "explore");
    if (end) return { end: end.payload as { status: string; failure?: { code: string }; result?: { reason: string } }, recoveries: trace.all().filter((r) => r.agentId === rover.id && (r.payload as { op?: string }).op === "recovery").map((r) => r.payload as { kind: string; ok?: boolean; reason: string; cells?: unknown[] }), hash: run.world.stateHash };
  }
  throw new Error("explore did not end");
}

describe("explore started later no longer stalls inside its own planning clearance", () => {
  it("started at tick 101 (the case that failed): it escapes the band, continues, and ends frontier_exhausted", async () => {
    const r = await exploreFrom(101);
    expect(r.end.status, JSON.stringify(r.end)).toBe("succeeded");
    expect(r.end.result?.reason).toBe("frontier_exhausted");
    const escapes = r.recoveries.filter((x) => x.kind === "escape" && x.ok !== false);
    expect(escapes.length).toBeGreaterThan(0);
    expect(escapes[0]?.reason).toBe("inside_planning_clearance");
    expect(Array.isArray(escapes[0]?.cells) && (escapes[0]?.cells?.length ?? 0)).toBeGreaterThan(1);
  }, 120000);

  it("started at tick 1 it is unchanged: succeeded, and deterministic across repeats", async () => {
    const a = await exploreFrom(1);
    const b = await exploreFrom(1);
    expect(a.end.status).toBe("succeeded");
    expect(a.hash).toBe(b.hash);
  }, 120000);
});
