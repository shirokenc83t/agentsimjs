import { describe, expect, it } from "vitest";
import type { TraceRecord } from "@agentsim/trace";
import { glyphOf, isRaise, markOf, type Mark } from "../panels/debug/marks.ts";
import { bandMarks } from "./band-marks.ts";

const reflex = (seq: number, t: number, agentId = "ugv-007", code = "obstacle_ahead"): Mark => ({ seq, t, kind: "reflex", op: undefined, agentId, code });
const failure = (seq: number, t: number): Mark => ({ seq, t, kind: "action", op: "end", agentId: "ugv-002", status: "failed", code: "unreachable" });
const args = { widthPx: 600, startS: 0, scaleS: 60 }; // 10 px per second

describe("the marks on the swarm knowledge band", () => {
  it("puts a reflex and a failure at the time they happened, and ignores every other mark", () => {
    const other: Mark = { seq: 9, t: 5, kind: "action", op: "start", agentId: "ugv-001" };
    const m = bandMarks([reflex(1, 39.1), failure(2, 12), other], args);
    expect(m.map((x) => [x.kind, Math.round(x.x), x.seq])).toEqual([["failure", 120, 2], ["reflex", 391, 1]]);
  });

  it("merges marks of one kind closer than 6 px into one glyph with a count and a summary; marks further apart stay apart; a reflex and a failure never merge", () => {
    const m = bandMarks([reflex(1, 10), reflex(2, 10.3), reflex(3, 10.5), reflex(4, 12), failure(5, 10.1)], args);
    expect(m.filter((x) => x.kind === "reflex").map((x) => [x.count, x.seq])).toEqual([[3, 1], [1, 4]]);
    expect(m.find((x) => x.count === 3)?.summary).toBe("3 reflexes: ugv-007 obstacle_ahead at 10.0 s · ugv-007 obstacle_ahead at 10.3 s · ugv-007 obstacle_ahead at 10.5 s");
    expect(m.filter((x) => x.kind === "failure")).toHaveLength(1);
  });

  it("a hover on a single mark names its agent, its code and its time", () => {
    expect(bandMarks([failure(2, 12)], args)[0]?.summary).toBe("ugv-002 unreachable at 12.0 s");
  });
});

describe("the raise of a limit on the band and in the marks (F4 M4, T-123)", () => {
  const raised = (seq: number, t: number): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: t, wallTime: 1, source: "uav-001/s2", kind: "lifecycle", agentId: "uav-001", payload: { op: "raiseLimit", caller: "world", limit: "tokens", before: 40000, after: 80000, tick: 342 } }) as TraceRecord;
  it("is a mark of the run (the run lane), written ◆, whose hover says which limit went from what to what", () => {
    const m = markOf(raised(9, 34.2));
    expect(isRaise(m)).toBe(true);
    expect(m.agentId).toBeUndefined();
    expect(glyphOf(m)).toBe("◆");
    expect(m.code).toBe("uav-001 tokens 40000 → 80000");
    expect(isRaise(markOf({ ...raised(1, 1), kind: "event" } as TraceRecord))).toBe(false);
  });
  it("is a glyph of its own on the band, apart from a reflex and a failure, a click selecting its record", () => {
    const marks = [markOf(raised(9, 34.2)), reflex(3, 34.1)];
    const out = bandMarks(marks, args);
    expect(out.map((b) => b.kind).sort()).toEqual(["raise", "reflex"]);
    const raise = out.find((b) => b.kind === "raise");
    expect(raise?.seq).toBe(9);
    expect(raise?.summary).toBe("limit raised: uav-001 tokens 40000 → 80000 at 34.2 s");
  });
});
