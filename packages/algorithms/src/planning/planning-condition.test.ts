import { describe, expect, it } from "vitest";
import { knownFractionAlong, type KnownFractionGrid } from "./planning-condition.ts";

/** A fake map: 40 × 40 cells of `res` metres; `unknown(i, j)` says which cells were never observed. */
function grid(unknown: ((i: number, j: number) => boolean) | undefined, res = 1): KnownFractionGrid {
  return {
    sizeX: 40,
    sizeY: 40,
    resolutionM: res,
    hasUnknown: unknown !== undefined,
    isUnknown: (i, j) => unknown?.(i, j) ?? false,
    cellI: (x) => Math.floor(x / res),
    cellJ: (y) => Math.floor(y / res),
  };
}
const at = (x: number, y: number) => ({ x, y });

describe("known.frac (ADR-0037 addition of 2026-10-13)", () => {
  it("is exactly 1 on a map without unknown cells: ground truth, which is an ideal agent's map", () => {
    expect(knownFractionAlong(grid(undefined), at(0.5, 0.5), at(30.5, 22.5))).toBe(1);
    expect(knownFractionAlong(grid(undefined), at(5.5, 5.5), at(5.5, 5.5))).toBe(1);
  });

  it("is computed on a belief map, cell by cell: a prior counts only where it knows", () => {
    const g = grid((i) => i >= 5); // columns 5 and beyond are unknown
    expect(knownFractionAlong(g, at(0.5, 0.5), at(9.5, 0.5))).toBe(0.5); // 10 cells along a row, 5 known
    expect(knownFractionAlong(g, at(9.5, 0.5), at(0.5, 0.5))).toBe(0.5); // the same either way
    expect(knownFractionAlong(g, at(0.5, 3.5), at(4.5, 3.5))).toBe(1); // wholly inside the known part
    expect(knownFractionAlong(g, at(6.5, 3.5), at(20.5, 3.5))).toBe(0);
  });

  it("is a single cell when start and goal share one, known or not", () => {
    expect(knownFractionAlong(grid((i) => i >= 5), at(2.2, 2.2), at(2.8, 2.9))).toBe(1);
    expect(knownFractionAlong(grid((i) => i >= 5), at(7.2, 2.2), at(7.8, 2.9))).toBe(0);
  });

  it("goes diagonally through an exact cell corner without visiting the side cells (fixed rule)", () => {
    const calls: string[] = [];
    const g = { ...grid(() => false), isUnknown: (i: number, j: number) => (calls.push(`${i},${j}`), false) };
    expect(knownFractionAlong(g, at(0.5, 0.5), at(3.5, 3.5))).toBe(1);
    expect(calls).toEqual(["0,0", "1,1", "2,2", "3,3"]);
  });

  it("visits every cell a shallow line crosses", () => {
    const seen: string[] = [];
    const g = { ...grid(() => false), isUnknown: (i: number, j: number) => (seen.push(`${i},${j}`), false) };
    knownFractionAlong(g, at(0.5, 0.5), at(5.5, 1.5));
    expect(seen[0]).toBe("0,0");
    expect(seen.at(-1)).toBe("5,1");
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.length).toBeLessThanOrEqual(7);
    // Cells are 4-connected steps or exact diagonals only.
    const cells = seen.map((s) => s.split(",").map(Number) as [number, number]);
    for (let k = 1; k < cells.length; k++) {
      const [pi, pj] = cells[k - 1] ?? [0, 0];
      const [ci, cj] = cells[k] ?? [0, 0];
      expect(Math.max(Math.abs(ci - pi), Math.abs(cj - pj))).toBe(1);
    }
    // Same inputs, same value (no hidden state).
    const g2 = grid((i, j) => (i + 2 * j) % 3 === 0);
    expect(knownFractionAlong(g2, at(0.5, 0.5), at(25.5, 11.5))).toBe(knownFractionAlong(g2, at(0.5, 0.5), at(25.5, 11.5)));
  });

  it("works at any resolution and clamps endpoints to the map", () => {
    const g = grid((i) => i >= 5, 0.5); // unknown from x = 2.5 m on
    expect(knownFractionAlong(g, at(0.25, 0.25), at(4.75, 0.25))).toBe(0.5);
    expect(knownFractionAlong(grid((i) => i >= 5), at(-3, 0.5), at(9.5, 0.5))).toBe(5 / 10);
    expect(knownFractionAlong(grid((i) => i >= 5), at(0.5, 0.5), at(999, 0.5))).toBeLessThan(0.2);
  });
});
