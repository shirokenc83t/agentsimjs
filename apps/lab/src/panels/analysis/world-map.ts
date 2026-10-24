import type { MapModel } from "./analysis-model.ts";

/** Cells of the blocked image the map holds at most on a side: a 1 km² world at half a metre is 2,000 cells a side, and the map is a few hundred pixels wide. */
export const MAX_MAP_CELLS = 512;

/**
 * The blocked cells of a world as the map draws them, sampled to at most `MAX_MAP_CELLS` a side (one cell of the map is a block of `stride` cells of the world, read at its middle):
 * `cellAt` is the run source's (occupancy 1 is blocked). `loaded` says whether any cell could be read at all (a chunk that has not arrived is no cell), `readCells` how many.
 */
export function blockedGridFrom(
  dims: { readonly sizeX: number; readonly sizeY: number; readonly resolutionM: number },
  cellAt: (i: number, j: number) => { readonly occupancy: number } | undefined,
): { readonly grid: NonNullable<MapModel["blocked"]>; readonly loaded: boolean; readonly readCells: number } {
  const stride = Math.max(1, Math.ceil(Math.max(dims.sizeX, dims.sizeY) / MAX_MAP_CELLS));
  const cols = Math.ceil(dims.sizeX / stride);
  const rows = Math.ceil(dims.sizeY / stride);
  const cells = new Uint8Array(cols * rows);
  let loaded = false;
  let readCells = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const c = cellAt(Math.min(dims.sizeX - 1, i * stride + (stride >> 1)), Math.min(dims.sizeY - 1, j * stride + (stride >> 1)));
      if (c === undefined) continue;
      loaded = true;
      readCells++;
      if (c.occupancy === 1) cells[j * cols + i] = 1;
    }
  return { grid: { cols, rows, cellM: stride * dims.resolutionM, cells }, loaded, readCells };
}
