import { describe, expect, it } from "vitest";
import { blockedGridFrom, MAX_MAP_CELLS } from "./world-map.ts";

describe("blockedGridFrom", () => {
  it("is the world's cells one to one when the world fits, with y = 0 in the first row", () => {
    const wall = new Set(["2,0", "2,1", "0,3"]);
    const r = blockedGridFrom({ sizeX: 4, sizeY: 4, resolutionM: 0.5 }, (i, j) => ({ occupancy: wall.has(`${i},${j}`) ? 1 : 0 }));
    expect(r.loaded).toBe(true);
    expect(r.readCells).toBe(16);
    expect(r.grid).toMatchObject({ cols: 4, rows: 4, cellM: 0.5 });
    expect([...r.grid.cells]).toEqual([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("samples a big world down to the cells the map can hold, a block of cells being one cell of the map", () => {
    const r = blockedGridFrom({ sizeX: 2000, sizeY: 1000, resolutionM: 0.5 }, (i) => ({ occupancy: i >= 1000 ? 1 : 0 }));
    expect(r.grid.cols).toBeLessThanOrEqual(MAX_MAP_CELLS);
    expect(r.grid.rows).toBeLessThanOrEqual(MAX_MAP_CELLS);
    expect(r.grid.cellM).toBe(2); // 4 cells of half a metre
    const left = r.grid.cells[0];
    const right = r.grid.cells[r.grid.cols - 1];
    expect([left, right]).toEqual([0, 1]);
  });

  it("is not loaded when no chunk has arrived, and a cell that has not arrived is not blocked", () => {
    expect(blockedGridFrom({ sizeX: 8, sizeY: 8, resolutionM: 1 }, () => undefined)).toMatchObject({ loaded: false, readCells: 0 });
    const some = blockedGridFrom({ sizeX: 2, sizeY: 1, resolutionM: 1 }, (i) => (i === 0 ? { occupancy: 1 } : undefined));
    expect(some).toMatchObject({ loaded: true, readCells: 1 });
    expect([...some.grid.cells]).toEqual([1, 0]);
  });
});
