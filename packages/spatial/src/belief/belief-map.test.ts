import { StateHasher } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { BELIEF_FREE, BELIEF_OCCUPIED, BELIEF_UNKNOWN, BeliefMap, LOGODDS_CLAMP } from "./belief-map.ts";

const map = () => new BeliefMap(64, 64, 16);

describe("belief occupancy map (ADR-0012, ADR-0028 additions of 2026-10-09)", () => {
  it("starts unknown everywhere without materializing any chunk", () => {
    const m = map();
    expect(m.state(10, 10)).toBe(BELIEF_UNKNOWN);
    expect(m.logOdds(10, 10)).toBe(0);
    expect(m.knownMaxM(10, 10)).toBe(Infinity);
    expect(m.materializedChunks).toBe(0);
  });

  it("free observations make a cell free; hits make it occupied with a lower bound; both clamp at ±100", () => {
    const m = map();
    m.observeFree(1, 1, 20);
    expect(m.state(1, 1)).toBe(BELIEF_FREE);
    for (let k = 0; k < 10; k++) m.observeFree(1, 1, 20);
    expect(m.logOdds(1, 1)).toBe(-LOGODDS_CLAMP);
    m.observeHit(2, 2, 3.25, 30);
    expect(m.state(2, 2)).toBe(BELIEF_OCCUPIED);
    expect(m.knownMinM(2, 2)).toBe(3.2); // dm, floored: a lower bound stays a lower bound
    m.observeHit(2, 2, 1, 30);
    expect(m.knownMinM(2, 2)).toBe(3.2); // only ever raised
    expect(m.knownMaxM(2, 2)).toBe(Infinity);
  });

  it("an obstacle under the beam is occupied with an upper bound, lowered only", () => {
    const m = map();
    m.observeUnder(5, 5, 28.04, 30);
    expect(m.state(5, 5)).toBe(BELIEF_OCCUPIED);
    expect(m.knownMaxM(5, 5)).toBe(28.1); // dm, ceiled: an upper bound stays an upper bound
    m.observeUnder(5, 5, 40, 30);
    expect(m.knownMaxM(5, 5)).toBe(28.1);
    m.observeUnder(5, 5, 12, 30);
    expect(m.knownMaxM(5, 5)).toBe(12);
  });

  it("at most 4 contradicting observations flip a prior cell at confidence 1, and 6 flip a cell at the clamp", () => {
    const m = map();
    m.setPrior(3, 3, 60); // a wrong prior wall at confidence 1
    let n = 0;
    while (m.state(3, 3) !== BELIEF_FREE) {
      m.observeFree(3, 3, 20);
      n++;
    }
    expect(n).toBeLessThanOrEqual(4);
    m.observeContact(4, 4, 0); // clamp
    n = 0;
    while (m.state(4, 4) !== BELIEF_FREE) {
      m.observeFree(4, 4, 20);
      n++;
    }
    expect(n).toBeLessThanOrEqual(6);
  });

  it("contact sets the clamp and a height lower bound at the contact altitude", () => {
    const m = map();
    m.observeContact(7, 7, 30);
    expect(m.logOdds(7, 7)).toBe(LOGODDS_CLAMP);
    expect(m.knownMinM(7, 7)).toBe(30);
  });

  it("tracks versions per chunk; unchanged updates leave the version alone", () => {
    const m = map();
    const v0 = m.version;
    m.observeFree(1, 1, 20);
    expect(m.version).toBeGreaterThan(v0);
    expect(m.chunksChangedSince(v0)).toEqual([0]);
    const v1 = m.version;
    for (let k = 0; k < 10; k++) m.observeFree(1, 1, 20); // reaches the clamp, then no change
    const v2 = m.version;
    m.observeFree(1, 1, 20);
    expect(m.version).toBe(v2);
    m.observeHit(40, 40, 0, 30);
    expect(m.chunksChangedSince(v1)).toEqual([0, 10]);
  });

  it("hashes its content deterministically, independent of observation order within one cell set", () => {
    const a = map();
    const b = map();
    a.observeFree(1, 1, 20);
    a.observeHit(40, 40, 2, 30);
    b.observeHit(40, 40, 2, 30);
    b.observeFree(1, 1, 20);
    const ha = new StateHasher();
    const hb = new StateHasher();
    a.hashInto(ha);
    b.hashInto(hb);
    expect(ha.hex()).toBe(hb.hex());
    const c = map();
    const hc = new StateHasher();
    c.hashInto(hc);
    expect(hc.hex()).not.toBe(ha.hex());
  });

  it("the cached (incremental) hash equals a fresh hash after every step of a mixed observation sequence", () => {
    const hex = (m: BeliefMap) => {
      const h = new StateHasher();
      m.hashInto(h);
      return h.hex();
    };
    const live = map(); // hashed after every step: exercises the per-chunk cache
    const ops: ((m: BeliefMap) => void)[] = [
      (m) => m.observeFree(1, 1, 20),
      (m) => m.observeHit(40, 40, 0, 30), // allocates heights without raising the lower bound
      (m) => m.observeHit(40, 40, 0, 30), // at the clamp after a few: nothing changes
      (m) => m.observeHit(40, 40, 0, 30),
      (m) => m.observeHit(40, 40, 0, 30),
      (m) => m.observeHit(41, 40, 0, 30), // same chunk, heights already there, no raise
      (m) => m.observeUnder(10, 40, 3.2, 25),
      (m) => m.observeContact(5, 5, 1.5),
      (m) => m.setPriorHeightDm(60, 60, 55),
      (m) => m.setPrior(50, 20, 100), // at the clamp, no height arrays in its chunk
      (m) => m.observeHit(50, 20, 0, 30), // allocates them and changes nothing else
      (m) => m.observeFree(1, 1, 20),
    ];
    for (let n = 1; n <= ops.length; n++) {
      ops[n - 1]?.(live);
      const fresh = map();
      for (let k = 0; k < n; k++) ops[k]?.(fresh);
      expect(hex(live)).toBe(hex(fresh));
    }
  });
});

describe("BeliefMap.clone: a snapshot copy for the strategy sandbox (F2b M4, ADR-0037 item 16)", () => {
  const hex = (m: BeliefMap) => {
    const h = new StateHasher();
    m.hashInto(h);
    return h.hex();
  };
  const seeded = () => {
    const m = new BeliefMap(64, 64, 16);
    m.observeFree(3, 3, 20);
    m.observeFree(3, 3, 20);
    m.observeHit(40, 40, 2, 30);
    m.observeUnder(41, 40, 5, 30);
    m.setPrior(10, 10, 40);
    m.setPriorHeightDm(10, 10, 25);
    return m;
  };

  it("has the same content hash, version and plan version as the original", () => {
    const a = seeded();
    const b = a.clone();
    expect(hex(b)).toBe(hex(a));
    expect([b.version, b.planVersion, b.materializedChunks]).toEqual([a.version, a.planVersion, a.materializedChunks]);
    expect(b.chunksChangedSince(0)).toEqual(a.chunksChangedSince(0));
    expect(b.chunksPlanChangedSince(0)).toEqual(a.chunksPlanChangedSince(0));
    expect(Array.from(b.cellsPlanChangedSince(0) ?? [])).toEqual(Array.from(a.cellsPlanChangedSince(0) ?? []));
  });

  it("is independent: a change to either side never shows on the other", () => {
    const a = seeded();
    const b = a.clone();
    const before = hex(a);
    b.observeHit(3, 3, 2, 30);
    b.observeFree(50, 50, 20);
    expect(hex(a)).toBe(before);
    expect(a.state(50, 50)).toBe(0);
    const frozen = hex(b);
    a.observeHit(20, 20, 2, 30);
    a.observeHit(20, 20, 2, 30);
    expect(hex(b)).toBe(frozen);
    expect(b.state(20, 20)).toBe(0);
  });

  it("changes after the copy behave as on the original (hash cache and change log carry over)", () => {
    const a = seeded();
    hex(a); // warm the hash cache before copying
    const b = a.clone();
    for (const m of [a, b]) {
      m.observeHit(40, 40, 3, 30);
      m.observeFree(7, 7, 25);
    }
    expect(hex(b)).toBe(hex(a));
    expect(b.planVersion).toBe(a.planVersion);
    expect(Array.from(b.cellsPlanChangedSince(0) ?? [])).toEqual(Array.from(a.cellsPlanChangedSince(0) ?? []));
  });
});
