import { describe, expect, it } from "vitest";
import { AtlasLayout, ChunkQueue } from "./atlas-layout.ts";

describe("atlas layout (ADR-0027)", () => {
  it("1 km² at 0.5 m with 64-cell chunks fits one 2048² page: one draw call", () => {
    const l = new AtlasLayout({ sizeX: 2000, sizeY: 2000, chunkSize: 64, resolutionM: 0.5 });
    expect(l.pageCells).toBe(2048);
    expect(l.pageCount).toBe(1);
    expect(l.locate(31, 31)).toEqual({ page: 0, x: 1984, y: 1984 });
    expect(l.coveredCells(0)).toEqual({ x0: 0, y0: 0, w: 2000, h: 2000 });
  });

  it("larger maps tile pages row-major; the page size is a multiple of the chunk size within the device limit", () => {
    const l = new AtlasLayout({ sizeX: 4096, sizeY: 3000, chunkSize: 64, resolutionM: 0.5 });
    expect([l.pagesX, l.pagesY, l.pageCount]).toEqual([2, 2, 4]);
    expect(l.locate(32, 33)).toEqual({ page: 3, x: 0, y: 64 });
    expect(l.coveredCells(3)).toEqual({ x0: 2048, y0: 2048, w: 2048, h: 952 });
    const small = new AtlasLayout({ sizeX: 4000, sizeY: 4000, chunkSize: 48, resolutionM: 1 }, 1024);
    expect(small.pageCells).toBe(1008);
  });
});

describe("chunk upload queue", () => {
  const batch = (pairs: number[], fill: number[]) => {
    const coords = new Uint16Array(pairs);
    const data = new Uint8Array(fill.flatMap((v) => [v, v, v, v]));
    return { coords, data };
  };

  it("drains in arrival order within the per-frame budget; the latest version of a chunk replaces the queued one", () => {
    const q = new ChunkQueue(4);
    const a = batch([0, 0, 1, 0, 2, 0], [1, 2, 3]);
    q.push(a.coords, a.data);
    const b = batch([0, 0], [9]); // chunk (0, 0) again: replaces version 1, moves to the end
    q.push(b.coords, b.data);
    expect(q.size).toBe(3);
    const seen: [number, number, number][] = [];
    expect(q.take(2, (ci, cj, d) => seen.push([ci, cj, d[0] ?? -1]))).toBe(2);
    expect(q.take(16, (ci, cj, d) => seen.push([ci, cj, d[0] ?? -1]))).toBe(1);
    expect(seen).toEqual([
      [1, 0, 2],
      [2, 0, 3],
      [0, 0, 9],
    ]);
    expect(q.size).toBe(0);
  });
});
