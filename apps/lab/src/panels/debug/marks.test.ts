import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { laneIndex, markOf, nearestMark } from "./marks.ts";

const rec = (seq: number, simTime: number, kind: string, agentId?: string, payload: unknown = {}) => ({ seq, simTime, kind, ...(agentId ? { agentId } : {}), payload }) as unknown as TraceRecord;

describe("timeline marks", () => {
  it("keep the record's kind, op, time and agent; the run's own records have no agent", () => {
    expect(markOf(rec(3, 1.5, "action", "uav-001", { op: "start" }))).toEqual({ seq: 3, t: 1.5, kind: "action", op: "start", agentId: "uav-001" });
    expect(markOf(rec(4, 2, "event", undefined, { op: "checkpoint", tick: 20 }))).toMatchObject({ kind: "event", op: "checkpoint", agentId: undefined });
    expect(markOf(rec(5, 2, "snapshot", undefined, null)).op).toBeUndefined();
  });

  it("go on the lane of their agent; the run's and the unknown agents' on the first", () => {
    const lanes = ["run", "uav-001", "ugv-001"];
    expect(laneIndex(lanes, markOf(rec(1, 0, "action", "ugv-001")))).toBe(2);
    expect(laneIndex(lanes, markOf(rec(1, 0, "snapshot")))).toBe(0);
    expect(laneIndex(lanes, markOf(rec(1, 0, "action", "gone-001")))).toBe(0);
  });

  it("are picked by a click: the nearest on the lane within the tolerance", () => {
    const lanes = ["run", "uav-001", "ugv-001"];
    const marks = [rec(1, 1, "action", "uav-001"), rec(2, 1.2, "action", "uav-001"), rec(3, 1.1, "action", "ugv-001")].map(markOf);
    expect(nearestMark(marks, lanes, 1, 1.15, 0.2)?.seq).toBe(2);
    expect(nearestMark(marks, lanes, 1, 1.04, 0.2)?.seq).toBe(1);
    expect(nearestMark(marks, lanes, 2, 1.1, 0.01)?.seq).toBe(3);
    expect(nearestMark(marks, lanes, 1, 5, 0.2)).toBeUndefined();
    expect(nearestMark(marks, lanes, 0, 1.1, 0.5)).toBeUndefined();
  });
});
