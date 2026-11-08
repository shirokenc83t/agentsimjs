import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { randomGrid, space, UGV } from "../testing/fixtures.ts";
import { GridSearch, type GridAlgorithm } from "./grid-search.ts";
import { SearchSpace } from "./search-space.ts";

// F4 M2 (T-118): a search can avoid cells of its own, consulted next to the view and never written into it (the alternatives of a mind's `kShortestPaths`). It must give what a copy of the view with those
// cells closed gives, leave the shared view untouched, and cost the searches that pass nothing nothing.

const SIZE = 48;
const run = (s: SearchSpace, a: number, b: number, alg: GridAlgorithm, blocked?: ReadonlySet<number>) => {
  const q = new GridSearch(s, a, b, alg, 1e9, blocked === undefined ? {} : { blocked });
  q.runToCompletion();
  return q;
};

/** What the first version of the tool did: a copy of the view, the cells closed in its mask. */
function closedCopy(s: SearchSpace, cells: ReadonlySet<number>): SearchSpace {
  const copy = new SearchSpace(s.grid, s.traversal, s.profile);
  for (const c of cells) copy.mask[c] = 0;
  return copy;
}

describe("a search with cells of its own to avoid (T-118)", () => {
  it("gives the same path, cost and expansions as a copy of the view with those cells closed (A*, Dijkstra, weighted A*)", () => {
    const rng = Rng.fromSeed(5).derive("blocked");
    for (let trial = 0; trial < 8; trial++) {
      const s = space(randomGrid(trial, SIZE), UGV);
      const a = rng.intRange(0, SIZE * SIZE - 1);
      const b = rng.intRange(0, SIZE * SIZE - 1);
      const first = run(s, a, b, { kind: "astar" });
      if (first.status !== "found") continue;
      const path = first.path();
      const blocked = new Set(path.slice(3, -3));
      const copy = closedCopy(s, blocked);
      for (const alg of [{ kind: "astar" }, { kind: "dijkstra" }, { kind: "weighted-astar", weight: 1.5 }] as const) {
        const withSet = run(s, a, b, alg, blocked);
        const withCopy = run(copy, a, b, alg);
        expect(withSet.status).toBe(withCopy.status);
        expect(withSet.path()).toEqual(withCopy.path());
        expect(withSet.expanded).toBe(withCopy.expanded);
        if (withSet.status === "found") expect(withSet.cost).toBe(withCopy.cost);
      }
    }
  });

  it("never touches the view it searches: its mask is the same bytes after, and another search on it is unchanged", () => {
    const s = space(randomGrid(2, SIZE), UGV);
    const a = 0;
    const b = SIZE * SIZE - 1;
    const before = run(s, a, b, { kind: "astar" });
    const mask = Uint8Array.from(s.mask);
    const blocked = new Set(before.path().slice(2, -2));
    run(s, a, b, { kind: "astar" }, blocked);
    expect(Uint8Array.from(s.mask)).toEqual(mask);
    const after = run(s, a, b, { kind: "astar" });
    expect(after.path()).toEqual(before.path());
    expect(after.expanded).toBe(before.expanded);
  });

  it("a search that passes nothing, or an empty set, is the search it was: same path, cost and expansions", () => {
    const s = space(randomGrid(4, SIZE), UGV);
    const plain = run(s, 0, SIZE * SIZE - 1, { kind: "astar" });
    const empty = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }, new Set());
    expect(empty.path()).toEqual(plain.path());
    expect(empty.expanded).toBe(plain.expanded);
    expect(empty.cost).toBe(plain.cost);
  });

  it("is deterministic: the same blocked set gives the same search twice", () => {
    const s = space(randomGrid(6, SIZE), UGV);
    const route = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }).path();
    const blocked = new Set(route.slice(4, -4));
    const x = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }, blocked);
    const y = run(s, 0, SIZE * SIZE - 1, { kind: "astar" }, blocked);
    expect(y.path()).toEqual(x.path());
    expect(y.expanded).toBe(x.expanded);
  });
});
