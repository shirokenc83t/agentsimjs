import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { knowledgeAt, knowledgeBand, knowledgeWords } from "./knowledge-band.ts";

// The band is the mean over agents of their latest recorded belief-vs-truth sample, nothing else (observer data).

let seq = 0;
const sample = (agentId: string, t: number, unknownPct: number, correctPct: number): TraceRecord =>
  ({ id: `r#${seq}`, runId: "r", seq: seq++, simTime: t, wallTime: 0, agentId, source: "world/sim", kind: "event", payload: { op: "belief-vs-truth", map: { reachableCells: 100, unknownPct, correctPct, phantomPct: 100 - unknownPct - correctPct }, entities: {} } }) as TraceRecord;
const ideal = (agentId: string, t: number): TraceRecord => ({ id: `r#${seq}`, runId: "r", seq: seq++, simTime: t, wallTime: 0, agentId, source: "world/sim", kind: "event", payload: { op: "belief-vs-truth", ideal: true, entities: {} } }) as TraceRecord;

describe("the swarm knowledge band", () => {
  it("is empty without samples, and ignores records of other ops and kinds", () => {
    expect(knowledgeBand([]).points).toEqual([]);
    const other = { id: "x", runId: "r", seq: 99, simTime: 1, wallTime: 0, agentId: "ugv-001", source: "a", kind: "action", payload: { op: "start" } } as TraceRecord;
    expect(knowledgeBand([other]).points).toEqual([]);
  });

  it("a point is the mean of every agent's latest sample so far, of the known share (100 minus unknown) and of the matching share", () => {
    const b = knowledgeBand([sample("ugv-001", 0, 100, 0), sample("ugv-002", 5, 100, 0), sample("ugv-001", 10, 80, 18), sample("ugv-002", 15, 60, 40), sample("ugv-001", 20, 50, 45)]);
    expect(b.points.map((p) => [p.t, p.knownPct, p.matchPct, p.agents])).toEqual([
      [0, 0, 0, 1],
      [5, 0, 0, 2],
      [10, 10, 9, 2], // ugv-001 knows 20 % (18 matching), ugv-002 still 0: the means are 10 and 9
      [15, 30, 29, 2], // 20 and 40 known; 18 and 40 matching
      [20, 45, 42.5, 2], // 50 and 40 known; 45 and 40 matching
    ]);
    expect(b.observed).toBe(2);
  });

  it("says how many agents have reported, and counts an ideal agent apart: it has no belief to compare and is not in the mean", () => {
    const b = knowledgeBand([ideal("ugv-009", 0), sample("ugv-001", 1, 90, 5), sample("ugv-002", 6, 70, 25)]);
    expect(b.ideal).toBe(1);
    expect(b.observed).toBe(2);
    expect(b.points.map((p) => p.agents)).toEqual([1, 2]);
    expect(knowledgeWords(b, 3)).toContain("mean of the 1 of 2 agents that have reported");
    expect(knowledgeWords(b, 3)).toContain("(1 ideal not counted)");
    expect(knowledgeWords(knowledgeBand([ideal("ugv-009", 0)]), 3)).toContain("nothing to compare");
  });

  it("several agents sampled at one instant make one point; the rate is the median spacing of one agent's samples", () => {
    const b = knowledgeBand([sample("ugv-001", 0, 100, 0), sample("ugv-002", 0, 100, 0), sample("ugv-001", 10, 50, 40), sample("ugv-002", 10, 50, 40), sample("ugv-001", 20, 40, 50)]);
    expect(b.points.filter((p) => p.t === 10)).toHaveLength(1);
    expect(b.everyS).toBe(10);
    expect(knowledgeWords(b, 20)).toContain("each agent every 10 s");
  });

  it("a span with no sample for more than two intervals is a gap, not a value carried across", () => {
    const b = knowledgeBand([sample("ugv-001", 0, 100, 0), sample("ugv-001", 10, 90, 8), sample("ugv-001", 20, 80, 15), sample("ugv-001", 70, 40, 50)]);
    expect(b.gaps).toEqual([{ fromS: 20, toS: 70 }]);
  });

  it("is read at a time: the latest point at or before it", () => {
    const b = knowledgeBand([sample("ugv-001", 0, 100, 0), sample("ugv-001", 10, 50, 40)]);
    expect(knowledgeAt(b, 9.9)?.knownPct).toBe(0);
    expect(knowledgeAt(b, 10)?.knownPct).toBe(50);
    expect(knowledgeAt(b, -1)).toBeUndefined();
    expect(knowledgeWords(b, -1)).toContain("no sample yet");
  });
});
