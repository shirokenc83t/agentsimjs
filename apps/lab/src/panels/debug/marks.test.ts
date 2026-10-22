import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { collapseMarks, glyphOf, isFailure, laneIndex, markOf, nearestMark } from "./marks.ts";

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

  it("know how an action ended, and that a failure is a flag with its own glyph; reflexes, commands, degradations and snapshots have theirs", () => {
    const failed = markOf(rec(1, 1, "action", "uav-001", { op: "end", status: "failed" }));
    expect(failed.status).toBe("failed");
    expect(isFailure(failed)).toBe(true);
    expect(glyphOf(failed)).toBe("✕");
    expect(isFailure(markOf(rec(2, 1, "action", "uav-001", { op: "end", status: "succeeded" })))).toBe(false);
    expect(markOf(rec(3, 1, "reflex", "uav-001", { op: "obstacle_ahead" })).status).toBeUndefined();
    const glyphs = ["action", "reflex", "injected", "degradation", "snapshot"].map((k) => glyphOf(markOf(rec(1, 0, k, "uav-001"))));
    expect(glyphs).toEqual(["▪", "▲", "◆", "▼", "◇"]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("collapse marks of a lane that are closer than a few pixels into one with a count, showing the most telling; other lanes and far marks stay apart", () => {
    const lanes = ["run", "uav-001", "ugv-001"];
    const marks = [
      rec(1, 10.0, "action", "uav-001", { op: "start" }),
      rec(2, 10.1, "reflex", "uav-001", { op: "obstacle_ahead" }),
      rec(3, 10.2, "action", "uav-001", { op: "end", status: "failed" }),
      rec(4, 10.1, "action", "ugv-001", { op: "start" }),
      rec(5, 40, "action", "uav-001", { op: "start" }),
    ].map(markOf);
    // 100 s over 1000 px: 10 px a second; 6 px merges what is within 0.6 s.
    const clusters = collapseMarks(marks, lanes, 100, 1000, 6);
    expect(clusters.map((c) => [c.lane, c.count, c.shown.seq])).toEqual([
      [1, 3, 3],
      [2, 1, 4],
      [1, 1, 5],
    ]);
    expect(collapseMarks(marks, lanes, 100, 1000, 0).map((c) => c.count)).toEqual([1, 1, 1, 1, 1]);
  });
});
