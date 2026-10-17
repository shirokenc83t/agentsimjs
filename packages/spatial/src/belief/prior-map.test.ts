import { describe, expect, it } from "vitest";
import { BELIEF_FREE, BELIEF_OCCUPIED, BELIEF_UNKNOWN, BeliefMap, LOGODDS_CLAMP } from "./belief-map.ts";
import { applyPrior, PRIOR_FREE, PRIOR_OCCUPIED, priorLogOdds, type PriorMap } from "./prior-map.ts";

const W = 20;
const H = 10;

function prior(confidence: number, cells: Readonly<Record<string, number>>, heights: Readonly<Record<string, number>> = {}): PriorMap {
  const knowledge = new Uint8Array(W * H);
  const heightDm = new Uint16Array(W * H);
  for (const [c, v] of Object.entries(cells)) {
    const [i = 0, j = 0] = c.split(",").map(Number);
    knowledge[j * W + i] = v;
  }
  for (const [c, v] of Object.entries(heights)) {
    const [i = 0, j = 0] = c.split(",").map(Number);
    heightDm[j * W + i] = v;
  }
  return { id: "p", sizeX: W, sizeY: H, confidence, knowledge, heightDm, terrainCost: undefined };
}

describe("prior maps (ADR-0025 and ADR-0028 additions of 2026-10-09)", () => {
  it("a prior agent starts with exactly the prior's cells, at ±round(60 × confidence)", () => {
    const b = new BeliefMap(W, H, 8);
    applyPrior(b, prior(0.5, { "2,3": PRIOR_OCCUPIED, "4,3": PRIOR_FREE }));
    expect(b.logOdds(2, 3)).toBe(30);
    expect(b.logOdds(4, 3)).toBe(-30);
    let known = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (b.state(i, j) !== BELIEF_UNKNOWN) known++;
    expect(known).toBe(2);
    expect(priorLogOdds(1)).toBe(60);
    expect(priorLogOdds(1)).toBeLessThan(LOGODDS_CLAMP);
  });

  it("a wrong prior wall at confidence 1 is believed free after at most 4 clear observations", () => {
    const b = new BeliefMap(W, H, 8);
    applyPrior(b, prior(1, { "5,5": PRIOR_OCCUPIED }));
    expect(b.state(5, 5)).toBe(BELIEF_OCCUPIED);
    let n = 0;
    while (b.state(5, 5) !== BELIEF_FREE) {
      b.observeFree(5, 5, 20); // the minimum increment
      n++;
    }
    expect(n).toBeLessThanOrEqual(4);
  });

  it("a wall missing from the prior is believed occupied after at most 4 hits", () => {
    const b = new BeliefMap(W, H, 8);
    applyPrior(b, prior(1, { "5,5": PRIOR_FREE }));
    let n = 0;
    while (b.state(5, 5) !== BELIEF_OCCUPIED) {
      b.observeHit(5, 5, 0, 20);
      n++;
    }
    expect(n).toBeLessThanOrEqual(4);
  });

  it("a cell held at the clamp flips after at most 6 contradicting observations", () => {
    const b = new BeliefMap(W, H, 8);
    b.observeContact(5, 5, 0);
    expect(b.logOdds(5, 5)).toBe(LOGODDS_CLAMP);
    let n = 0;
    while (b.state(5, 5) !== BELIEF_FREE) {
      b.observeFree(5, 5, 20);
      n++;
    }
    expect(n).toBeLessThanOrEqual(6);
  });

  it("an occupied prior cell with a height starts with both bounds at it; 0 means unknown height", () => {
    const b = new BeliefMap(W, H, 8);
    applyPrior(b, prior(1, { "2,2": PRIOR_OCCUPIED, "3,2": PRIOR_OCCUPIED }, { "2,2": 125 }));
    expect(b.knownMinM(2, 2)).toBe(12.5);
    expect(b.knownMaxM(2, 2)).toBe(12.5);
    expect(b.knownMaxM(3, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("sensing overturns a wrong prior height: the observation wins and the bounds stay ordered", () => {
    const b = new BeliefMap(W, H, 8);
    applyPrior(b, prior(1, { "2,2": PRIOR_OCCUPIED, "4,2": PRIOR_OCCUPIED }, { "2,2": 100, "4,2": 100 }));
    b.observeHit(2, 2, 30, 20); // the obstacle reaches 30 m: taller than the prior's 10 m
    expect(b.knownMinM(2, 2)).toBe(30);
    expect(b.knownMaxM(2, 2)).toBe(Number.POSITIVE_INFINITY);
    b.observeUnder(4, 2, 4, 20); // its top is below 4 m: lower than the prior's 10 m
    expect(b.knownMaxM(4, 2)).toBe(4);
    expect(b.knownMinM(4, 2)).toBeLessThanOrEqual(4);
  });

  it("rejects a prior of another size", () => {
    expect(() => applyPrior(new BeliefMap(W + 1, H, 8), prior(1, {}))).toThrow(RangeError);
  });
});
