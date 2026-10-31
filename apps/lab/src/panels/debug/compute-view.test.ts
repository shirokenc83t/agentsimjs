import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { beliefAt, beliefPixels, computeFacts, routeOverBelief } from "./compute-view.ts";

// The Compute inspector's facts and its map (F4 M4, T-123): the words of each tool's result, and the route drawn over what the agent believes, with how much of it lies over cells it has not seen.

const rec = (payload: Record<string, unknown>) => ({ id: "run-000001#5", runId: "run-000001", seq: 5, simTime: 3, wallTime: 1, source: "uav-001/s2", kind: "compute", agentId: "uav-001", payload }) as TraceRecord;

describe("the facts of a compute call", () => {
  it("words the result of each tool and keeps the route of a plan", () => {
    const plan = computeFacts(rec({ op: "tool", tool: "planPath", ok: true, status: "found", expansions: 212, params: { to: { xM: 50, yM: 20 } }, result: { status: "found", lengthM: 41.2, etaS: 20.6, energyPct: 1.1, expansions: 212, waypoints: [{ xM: 28, yM: 12.5 }, { xM: 40, yM: 18 }, { xM: 50, yM: 20 }] } }));
    expect(plan.lines).toEqual(["3 waypoints · 41.2 m · 20.6 s · 1.1 % battery · found"]);
    expect(plan.waypoints).toHaveLength(3);
    expect(plan.to).toEqual({ xM: 50, yM: 20 });
    expect(plan.expansions).toBe(212);
    const cost = computeFacts(rec({ op: "tool", tool: "estimateCost", ok: true, status: "found", params: { route: [] }, result: { status: "found", lengthM: 104, etaS: 45, energyPct: 3, legs: [{ lengthM: 41, etaS: 18, status: "found" }, { lengthM: 63, etaS: 27, status: "found" }] } }));
    expect(cost.lines).toEqual(["total 104.0 m · 45.0 s · 3.0 % · found", "leg 1: 41.0 m · 18.0 s · found", "leg 2: 63.0 m · 27.0 s · found"]);
    expect(cost.waypoints).toEqual([]);
    const k = computeFacts(rec({ op: "tool", tool: "kShortestPaths", ok: true, status: "found", result: { status: "found", paths: [{ lengthM: 40, etaS: 20, sharedPct: 0 }, { lengthM: 52, etaS: 26, sharedPct: 35 }] } }));
    expect(k.lines[2]).toBe("route 2: 52.0 m · 26.0 s · shares 35 % with the best");
    expect(computeFacts(rec({ op: "tool", tool: "querySpace", ok: true, status: "found", result: { summary: {} } })).lines[0]).toContain("summary of space");
    const refused = computeFacts(rec({ op: "tool", tool: "planPath", ok: false, code: "tool_call_limit", message: "you have used your 8 tool calls", params: {} }));
    expect(refused.ok).toBe(false);
    expect(refused.lines[0]).toBe("refused · tool_call_limit: you have used your 8 tool calls");
  });
});

/** An 8 x 8 map of 1 m cells in four 4 x 4 chunks: free in the west half, the east half never seen (state 0), with a believed obstacle at (3, 2). */
function belief() {
  const cs = 4;
  const chunk = (fill: number) => new Uint8Array(cs * cs).fill(fill);
  const west = [chunk(1), chunk(1)];
  west[0]![2 * cs + 3] = 2; // (i=3, j=2) believed occupied
  return { sizeX: 8, sizeY: 8, chunkSize: cs, coords: Uint16Array.from([0, 0, 0, 1, 1, 0, 1, 1]), data: Uint8Array.from([...west[0]!, ...west[1]!, ...chunk(0), ...chunk(0)]) };
}

describe("a route over the agent's belief", () => {
  it("reads the belief of a cell and says unknown where the map has nothing", () => {
    const m = belief();
    expect(beliefAt(m, 1, 1)).toBe(1);
    expect(beliefAt(m, 3, 2)).toBe(2);
    expect(beliefAt(m, 6, 1)).toBe(0);
    expect(beliefAt(m, -1, 0)).toBe(0);
    expect(beliefAt({ ...m, coords: [], data: [] }, 1, 1)).toBe(0);
  });

  it("a route through what the agent has not seen is counted as such: the belief agent planned straight through the unseen east, which a ground-truth map would not show", () => {
    const m = belief();
    const through = routeOverBelief(m, 1, [{ xM: 0.5, yM: 0.5 }, { xM: 7.5, yM: 0.5 }]);
    expect(through.totalM).toBeCloseTo(7, 6);
    expect(through.unknownM).toBeGreaterThan(3); // the east half: x from 4 to 7.5
    expect(through.unknownM).toBeLessThan(4.5);
    const known = routeOverBelief(m, 1, [{ xM: 0.5, yM: 0.5 }, { xM: 2.5, yM: 0.5 }]);
    expect(known.unknownM).toBe(0);
    const bump = routeOverBelief(m, 1, [{ xM: 0.5, yM: 2.5 }, { xM: 3.5, yM: 2.5 }]);
    expect(bump.occupiedM).toBeGreaterThan(0);
  });

  it("draws the map north up with the unknown hatched (every other diagonal), the free and the occupied as they are", () => {
    const m = belief();
    const px = beliefPixels(m, 1);
    expect([px.width, px.height]).toEqual([8, 8]);
    // Row 7 of the pixels is j = 0: the south-west is free; the occupied cell (3, 2) is at pixel row 5.
    expect(px.cls[7 * 8 + 0]).toBe(1);
    expect(px.cls[5 * 8 + 3]).toBe(2);
    const east = [...px.cls].filter((c, k) => k % 8 >= 4 && (c === 0 || c === 3));
    expect(east).toHaveLength(32); // the whole east half is unknown…
    expect(new Set(east)).toEqual(new Set([0, 3])); // …drawn as stripes
    expect(beliefPixels(m, 4).width).toBe(2);
  });
});
