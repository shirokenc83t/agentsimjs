import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { chartScale, tableColumns } from "./pane-views.tsx";

const rec = (seq: number, payload: unknown): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: seq, wallTime: 1, source: "uav-001/body", kind: "observation", payload });

describe("tableColumns", () => {
  it("is the fixed columns, then the keys most payloads have, most common first, at most five", () => {
    const rows = [rec(0, { op: "pose", x: 1, y: 2, z: 0, heading: 0.5, speedMps: 1, soc: 0.9, once: 1 }), rec(1, { op: "pose", x: 2, y: 2, z: 0, heading: 0.5, speedMps: 1, soc: 0.9 }), rec(2, { op: "pose", x: 3 })];
    const cols = tableColumns(rows);
    expect(cols.slice(0, 5)).toEqual(["seq", "t", "agent", "kind", "source"]);
    expect(cols.slice(5)).toHaveLength(5);
    expect(cols.slice(5, 7)).toEqual(["op", "x"]); // in all three rows
    expect(cols).not.toContain("once");
  });

  it("is only the fixed columns for payloads that are not objects", () => {
    expect(tableColumns([rec(0, null), rec(1, "text"), rec(2, [1, 2])])).toEqual(["seq", "t", "agent", "kind", "source"]);
    expect(tableColumns([])).toEqual(["seq", "t", "agent", "kind", "source"]);
  });
});

describe("chartScale", () => {
  const line = (points: [number, number][]) => ({ key: "a", source: "uav-001/body", name: "agent.soc", points: points.map(([t, v]) => ({ t, v })) });

  it("spans the time and the values of the lines, at least to the head, and puts a high value high", () => {
    const s = chartScale([line([[0, 0.2], [10, 0.8]])], 30);
    expect([s.t0, s.t1, s.v0, s.v1]).toEqual([0, 30, 0.2, 0.8]);
    expect(s.x(0)).toBeLessThan(s.x(30));
    expect(s.y(0.8)).toBeLessThan(s.y(0.2)); // SVG y grows downwards
  });

  it("gives a flat line a range, and no lines a default span", () => {
    const flat = chartScale([line([[0, 5], [1, 5]])], 0);
    expect(flat.v1 - flat.v0).toBeGreaterThan(0);
    const none = chartScale([], 12);
    expect([none.t0, none.t1, none.v0, none.v1]).toEqual([0, 12, 0, 1]);
  });
});
