import { Rng, StateHasher } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { BeliefMap } from "./belief-map.ts";

/**
 * Seeded property test of the per-chunk hash cache (F2 M2b): after random sequences of belief updates, the hash of
 * a map hashed along the way (cached chunk hashes) equals the hash of a map that replayed the same updates and is
 * hashed once (every chunk computed from scratch). Few cells and chunks, so the sequences hit the clamp
 * fast paths (updates that change nothing), contact bumps, height allocation without a raise, and priors that
 * sensing contradicts.
 */
const SEQUENCES = 300;
const STEPS = 160;
const SIZE = 48; // 3 × 3 chunks of 16
const CELLS = 6; // per axis, spread over the chunks

type Op = (m: BeliefMap) => void;

function randomOp(r: Rng): Op {
  const pick = (n: number) => r.nextU32() % n;
  const i = pick(CELLS) * 8 + pick(2);
  const j = pick(CELLS) * 8 + pick(2);
  const inc = 20 + pick(21);
  const heightM = pick(400) / 10;
  switch (pick(8)) {
    case 0:
    case 1:
      return (m) => m.observeFree(i, j, inc);
    case 2:
      return (m) => m.observeUnder(i, j, heightM, inc);
    case 3:
    case 4: {
      const lowerM = pick(4) === 0 ? 0 : heightM; // 0: may allocate heights without a raise
      return (m) => m.observeHit(i, j, lowerM, inc);
    }
    case 5:
      return (m) => m.observeContact(i, j, heightM);
    case 6: {
      const l = pick(3) === 0 ? 100 : pick(121) - 60;
      return (m) => m.setPrior(i, j, l);
    }
    default: {
      const dm = 1 + pick(500);
      return (m) => m.setPriorHeightDm(i, j, dm);
    }
  }
}

function hex(m: BeliefMap): string {
  const h = new StateHasher();
  m.hashInto(h);
  return h.hex();
}

describe("belief map hash cache (F2 M2b): cached hash = full recompute", () => {
  it(`${SEQUENCES} random sequences of ${STEPS} updates, checked at random points`, () => {
    let checks = 0;
    for (let s = 0; s < SEQUENCES; s++) {
      const r = Rng.fromSeed(2026).derive(`belief-hash/${s}`);
      const ops: Op[] = [];
      const live = new BeliefMap(SIZE, SIZE, 16);
      for (let k = 0; k < STEPS; k++) {
        const op = randomOp(r);
        ops.push(op);
        op(live);
        // Hash the live map often (so its cache is exercised between updates), and compare at random points.
        if (r.nextU32() % 2 === 0) hex(live);
        if (r.nextU32() % 10 === 0 || k === STEPS - 1) {
          const fresh = new BeliefMap(SIZE, SIZE, 16);
          for (const o of ops) o(fresh);
          expect(hex(live), `sequence ${s}, step ${k}`).toBe(hex(fresh));
          checks++;
        }
      }
    }
    expect(checks).toBeGreaterThan(SEQUENCES * 10);
  });
});
