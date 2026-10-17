import type { GridSpace } from "../grid/grid-space.ts";

/** Bytes per cell in the render encoding (ADR-0027): R occupancy, G terrain cost, B + A height in dm (little-endian). */
export const ATLAS_BYTES_PER_CELL = 4;

/**
 * Encodes one chunk of the grid for rendering (ADR-0027): `chunkSize² × 4` bytes, row-major from the chunk's
 * south-west cell, R = occupancy, G = terrain cost, B = height low byte, A = height high byte. Pure data:
 * the renderer maps it to colours in a shader. Reuses `scratch` buffers to avoid per-chunk allocation.
 */
export function encodeAtlasChunk(
  grid: GridSpace,
  ci: number,
  cj: number,
  out: Uint8Array,
  scratch: { readonly u8: Uint8Array; readonly u16: Uint16Array } = atlasScratch(grid.chunkSize),
): void {
  const n = grid.chunkSize * grid.chunkSize;
  if (out.length < n * ATLAS_BYTES_PER_CELL) throw new RangeError("atlas chunk buffer too small");
  grid.occupancy.readChunk(ci, cj, scratch.u8);
  for (let k = 0; k < n; k++) out[k * 4] = scratch.u8[k] ?? 0;
  grid.terrainCost.readChunk(ci, cj, scratch.u8);
  for (let k = 0; k < n; k++) out[k * 4 + 1] = scratch.u8[k] ?? 0;
  grid.heightDm.readChunk(ci, cj, scratch.u16);
  for (let k = 0; k < n; k++) {
    const h = scratch.u16[k] ?? 0;
    out[k * 4 + 2] = h & 0xff;
    out[k * 4 + 3] = h >>> 8;
  }
}

export function atlasScratch(chunkSize: number): { readonly u8: Uint8Array; readonly u16: Uint16Array } {
  const n = chunkSize * chunkSize;
  return { u8: new Uint8Array(n), u16: new Uint16Array(n) };
}
