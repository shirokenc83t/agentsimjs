import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { BIN_PX, binMarks, describeAt, flagRole, glyphOf, isFailure, laneIndex, markOf, nearestMark } from "./marks.ts";

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

  it("put the marks of a lane in fixed bins: one glyph for one mark, a count for several, other lanes and far marks apart; two bins are never closer than a count label", () => {
    const lanes = ["run", "uav-001", "ugv-001"];
    const marks = [
      rec(1, 10.0, "action", "uav-001", { op: "start" }),
      rec(2, 10.1, "action", "uav-001", { op: "phase" }),
      rec(3, 10.2, "snapshot", "uav-001", null),
      rec(4, 10.1, "action", "ugv-001", { op: "start" }),
      rec(5, 40, "action", "uav-001", { op: "start" }),
    ].map(markOf);
    // 100 s over 1000 px: 10 px a second, so 32 px is 3.2 s.
    const { bins, flags } = binMarks(marks, lanes, 100, 1000);
    expect(flags).toEqual([]);
    expect(bins.map((b) => [b.lane, b.count, b.mode, b.shown.kind])).toEqual([
      [1, 3, "count", "action"],
      [2, 1, "glyph", "action"],
      [1, 1, "glyph", "action"],
    ]);
    expect(bins[0]?.kinds).toEqual([{ kind: "action", count: 2 }, { kind: "snapshot", count: 1 }]);
    const lane1 = bins.filter((b) => b.lane === 1).map((b) => b.x0);
    for (let i = 1; i < lane1.length; i++) expect((lane1[i] as number) - (lane1[i - 1] as number)).toBeGreaterThanOrEqual(BIN_PX);
  });

  it("never fold a failure, a reflex or a refused start into a count: each is a flag of its own, and a bin it crowds is a density bar with its counts in the tooltip", () => {
    const lanes = ["run", "uav-001"];
    const marks = [
      rec(1, 10.0, "action", "uav-001", { op: "start" }),
      rec(2, 10.1, "action", "uav-001", { op: "phase" }),
      rec(3, 10.2, "action", "uav-001", { op: "end", status: "failed", failure: { code: "unreachable" } }),
      rec(4, 10.3, "reflex", "uav-001", { code: "obstacle_ahead" }),
      rec(5, 10.4, "action", "uav-001", { op: "phase" }),
      rec(6, 50, "action", "uav-001", { op: "start" }),
      rec(7, 50.1, "action", "uav-001", { op: "phase" }),
    ].map(markOf);
    const binned = binMarks(marks, lanes, 100, 1000);
    expect(binned.flags.map((f) => f.mark.seq)).toEqual([3, 4]);
    expect(binned.bins.reduce((n, b) => n + b.count, 0)).toBe(5); // the flags are not in any count
    expect(binned.bins.map((b) => [b.count, b.mode])).toEqual([[3, "bar"], [2, "count"]]);
    expect(binned.maxCount).toBe(3);
    expect(describeAt(binned, 1, 112)).toBe("3 marks: action ×3");
    expect(describeAt(binned, 1, 102)).toContain("action end");
    expect(describeAt(binned, 1, 502)).toBe("2 marks: action ×2");
    expect(describeAt(binned, 1, 300)).toBe("");
  });

  it("carry the failure code of an action, of a refused start and of a reflex; failures, reflexes and refusals are the flags, in their role", () => {
    const failed = markOf(rec(1, 1, "action", "uav-001", { op: "end", status: "failed", failure: { code: "unreachable" } }));
    const rejected = markOf(rec(2, 2, "action", "uav-001", { op: "rejected", failure: { code: "target_blocked" } }));
    const reflex = markOf(rec(3, 3, "reflex", "uav-001", { reflex: "obstacle", code: "obstacle_ahead" }));
    const plain = markOf(rec(4, 4, "action", "uav-001", { op: "start" }));
    expect([failed.code, rejected.code, reflex.code, plain.code]).toEqual(["unreachable", "target_blocked", "obstacle_ahead", undefined]);
    expect([failed, rejected, reflex, plain].map(flagRole)).toEqual(["alarm", "warning", "warning", undefined]);
    expect(glyphOf(rejected)).toBe("▲");
  });
});
