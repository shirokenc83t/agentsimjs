import { describe, expect, it } from "vitest";
import type { Mark } from "../panels/debug/marks.ts";
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
