import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { explorationOf } from "./explore-state.ts";

const GRID = { sizeX: 100, resolutionM: 0.5 };
let seq = 0;
const rec = (simTime: number, payload: Record<string, unknown>, agentId = "ugv-001"): TraceRecord => ({ seq: seq++, simTime, wallTime: 0, kind: "action", source: `${agentId}/actions`, agentId, detail: "full", payload }) as unknown as TraceRecord;

const start = (t: number) => rec(t, { op: "start", name: "explore" });
const iter = (t: number, event: "start" | "end", extra: Record<string, unknown> = {}) => rec(t, { op: "explore-iteration", event, iteration: 1, centre: [10, 20], radiusM: 40, window: [-40, -30, 60, 70], ...extra });
const marked = (t: number, mark: "temporary" | "permanent", group: number) => rec(t, { op: "explore-target", event: "marked", mark, group });

describe("what exploration is doing, from the records (ADR-0040)", () => {
  it("is the iteration in progress: its centre, radius and window; nothing before one starts or after it ends", () => {
    const records = [start(0), iter(1, "start"), iter(9, "end")];
    expect(explorationOf(records, "ugv-001", 0.5, GRID).area).toBeUndefined();
    expect(explorationOf(records, "ugv-001", 5, GRID).area).toEqual({ x: 10, y: 20, radiusM: 40, window: [-40, -30, 60, 70] });
    expect(explorationOf(records, "ugv-001", 9.5, GRID).area).toBeUndefined();
  });

  it("looks only at the agent's records and at what happened by the moment shown", () => {
    const records = [iter(1, "start"), rec(2, { op: "explore-iteration", event: "start", iteration: 1, centre: [99, 99], radiusM: 5, window: [0, 0, 1, 1] }, "ugv-002")];
    expect(explorationOf(records, "ugv-001", 100, GRID).area?.x).toBe(10);
    expect(explorationOf(records, "ugv-001", 0.5, GRID).area).toBeUndefined();
  });

  it("marks the targets set aside for the iteration apart from the ones marked for good, and clears the first when the iteration moves on", () => {
    // A group at cell 2 * 100 + 30: x = 30.5 · 0.5 m, y = 2.5 · 0.5 m.
    const records = [start(0), iter(1, "start"), marked(2, "temporary", 230), marked(3, "temporary", 410), marked(4, "permanent", 230)];
    const v = explorationOf(records, "ugv-001", 5, GRID);
    expect(Array.from(v.permanent)).toEqual([15.25, 1.25]); // cell (30, 2): the centre of a 0.5 m cell
    expect(Array.from(v.temporary)).toEqual([5.25, 2.25]); // cell (10, 4)
    const later = explorationOf([...records, iter(6, "end")], "ugv-001", 7, GRID);
    expect(Array.from(later.temporary)).toEqual([]);
    expect(Array.from(later.permanent)).toEqual([15.25, 1.25]); // a mark for good outlives the iteration
  });

  it("a view that begins in the middle of an iteration has its area from the target records", () => {
    const records = [rec(3, { op: "explore-target", event: "selected", iteration: 4, mode: "iterate", centre: [50, 60], radiusM: 25, window: [10, 20, 90, 100] })];
    expect(explorationOf(records, "ugv-001", 4, GRID).area).toEqual({ x: 50, y: 60, radiusM: 25, window: [10, 20, 90, 100] });
  });

  it("a new explore, or the end of the action, leaves no iteration and no temporary mark behind", () => {
    const records = [start(0), iter(1, "start"), marked(2, "temporary", 230)];
    expect(explorationOf([...records, rec(3, { op: "end", name: "explore" })], "ugv-001", 4, GRID).temporary).toHaveLength(0);
    const restarted = explorationOf([...records, start(3)], "ugv-001", 4, GRID);
    expect(restarted.area).toBeUndefined();
    expect(restarted.temporary).toHaveLength(0);
  });
});
