import { describe, expect, it } from "vitest";
import { GridSpace, TERRAIN_NOMINAL } from "../grid/grid-space.ts";
import { encodeAtlasChunk } from "./atlas-chunk.ts";

describe("atlas chunk encoding (ADR-0027)", () => {
  it("packs occupancy, terrain cost and 16-bit height per cell, row-major per chunk", () => {
    const g = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 0.5, chunkSize: 32 });
    g.setCell("occupancy", 33, 2, 1); // chunk (1, 0), local (1, 2)
    g.setCell("terrainCost", 33, 2, 200);
    g.setCell("heightDm", 33, 2, 0x1234);
    const out = new Uint8Array(32 * 32 * 4);
    encodeAtlasChunk(g, 1, 0, out);
    const k = (2 * 32 + 1) * 4;
    expect([...out.subarray(k, k + 4)]).toEqual([1, 200, 0x34, 0x12]);
    // An untouched (uniform) cell: free, nominal terrain, no height.
    expect([...out.subarray(0, 4)]).toEqual([0, TERRAIN_NOMINAL, 0, 0]);
  });

  it("rejects a buffer that is too small", () => {
    const g = new GridSpace({ sizeX: 32, sizeY: 32, resolutionM: 1, chunkSize: 32 });
    expect(() => encodeAtlasChunk(g, 0, 0, new Uint8Array(10))).toThrow(RangeError);
  });
});
