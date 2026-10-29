import { describe, expect, it } from "vitest";
import { unionKnown, type BeliefMapBytes } from "./knowledge-union.ts";

// The union of what the agents know equals a brute-force union over the cells, on fixtures with several chunks, a map whose size is not a multiple of the chunk, and maps that overlap.

const SIZE_X = 10;
const SIZE_Y = 7;
const CS = 4;

/** A belief map of the fixture world from a function of the cell: the chunks that hold at least one known cell are in the map (as replay returns them). */
function mapOf(state: (i: number, j: number) => 0 | 1 | 2): BeliefMapBytes {
  const coords: number[] = [];
  const data: number[] = [];
  for (let cj = 0; cj * CS < SIZE_Y; cj++) {
    for (let ci = 0; ci * CS < SIZE_X; ci++) {
      const cells: number[] = [];
      let any = false;
      for (let lj = 0; lj < CS; lj++) {
        for (let li = 0; li < CS; li++) {
          const i = ci * CS + li;
          const j = cj * CS + lj;
          const v = i < SIZE_X && j < SIZE_Y ? state(i, j) : 0;
          if (v !== 0) any = true;
          cells.push(v);
        }
      }
      if (any) {
        coords.push(ci, cj);
        data.push(...cells);
      }
    }
  }
  return { sizeX: SIZE_X, sizeY: SIZE_Y, chunkSize: CS, coords: Uint16Array.from(coords), data: Uint8Array.from(data) };
}

const brute = (states: ((i: number, j: number) => number)[]): number => {
  let n = 0;
  for (let j = 0; j < SIZE_Y; j++) for (let i = 0; i < SIZE_X; i++) if (states.some((s) => s(i, j) !== 0)) n++;
  return n;
};

describe("the union of what the swarm knows", () => {
  it("equals a brute-force union on overlapping maps, over a world that is not a multiple of the chunk", () => {
    const a = (i: number, j: number): 0 | 1 | 2 => (i < 6 && j < 4 ? 1 : 0);
    const b = (i: number, j: number): 0 | 1 | 2 => (i >= 4 && j >= 2 ? (i === 9 ? 2 : 1) : 0);
    const c = (i: number, j: number): 0 | 1 | 2 => ((i + j) % 5 === 0 ? 2 : 0);
    const u = unionKnown([mapOf(a), mapOf(b), mapOf(c)]);
    expect(u.known).toBe(brute([a, b, c]));
    expect(u.total).toBe(SIZE_X * SIZE_Y);
    expect(u.pct).toBe(Math.round((10000 * brute([a, b, c])) / (SIZE_X * SIZE_Y)) / 100);
    // The union is never less than the best agent and never more than the sum.
    const single = unionKnown([mapOf(a)]).known;
    expect(u.known).toBeGreaterThanOrEqual(single);
    expect(u.known).toBeLessThanOrEqual(brute([a]) + brute([b]) + brute([c]));
  });

  it("is zero for no map and for maps that know nothing, and the whole map for a map that knows everything", () => {
    expect(unionKnown([])).toEqual({ known: 0, total: 0, pct: 0 });
    expect(unionKnown([mapOf(() => 0)]).known).toBe(0);
    const all = unionKnown([mapOf(() => 1)]);
    expect(all.known).toBe(SIZE_X * SIZE_Y);
    expect(all.pct).toBe(100);
  });

  it("counts a cell known to two agents once", () => {
    const same = (i: number, j: number): 0 | 1 | 2 => (i < 3 && j < 3 ? 1 : 0);
    expect(unionKnown([mapOf(same), mapOf(same)]).known).toBe(9);
  });

  it("refuses maps of different worlds", () => {
    const a = mapOf(() => 1);
    expect(() => unionKnown([a, { ...a, sizeX: 11 }])).toThrow(RangeError);
  });
});
