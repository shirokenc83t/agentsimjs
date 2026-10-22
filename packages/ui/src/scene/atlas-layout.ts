/** Texels per side of an atlas page, at most (ADR-0027). */
export const MAX_PAGE_TEXELS = 2048;
/** Chunk uploads per frame, at most (ADR-0027); the rest wait in the queue. */
export const CHUNK_UPLOADS_PER_FRAME = 16;

export interface GridDims {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly chunkSize: number;
  readonly resolutionM: number;
}

/**
 * Atlas page layout (ADR-0027): pages of `pageCells²` texels (the largest multiple of the chunk size within
 * min(2048, MAX_TEXTURE_SIZE)), tiled row-major; one texel per cell.
 */
export class AtlasLayout {
  readonly pageCells: number;
  readonly chunksPerPage: number;
  readonly pagesX: number;
  readonly pagesY: number;
  readonly chunksX: number;

  constructor(
    readonly dims: GridDims,
    maxTextureSize = MAX_PAGE_TEXELS,
  ) {
    const limit = Math.min(MAX_PAGE_TEXELS, maxTextureSize);
    if (dims.chunkSize > limit) throw new RangeError(`chunk size ${dims.chunkSize} exceeds the texture limit ${limit}`);
    this.chunksPerPage = Math.floor(limit / dims.chunkSize);
    this.pageCells = this.chunksPerPage * dims.chunkSize;
    this.pagesX = Math.ceil(dims.sizeX / this.pageCells);
    this.pagesY = Math.ceil(dims.sizeY / this.pageCells);
    this.chunksX = Math.ceil(dims.sizeX / dims.chunkSize);
  }

  get pageCount(): number {
    return this.pagesX * this.pagesY;
  }

  /** Page index of a chunk and the chunk's texel offset in that page. */
  locate(ci: number, cj: number): { page: number; x: number; y: number } {
    const px = Math.floor(ci / this.chunksPerPage);
    const py = Math.floor(cj / this.chunksPerPage);
    return {
      page: py * this.pagesX + px,
      x: (ci - px * this.chunksPerPage) * this.dims.chunkSize,
      y: (cj - py * this.chunksPerPage) * this.dims.chunkSize,
    };
  }

  /** Cells of the grid a page covers (edge pages are partly empty). */
  coveredCells(page: number): { x0: number; y0: number; w: number; h: number } {
    const px = page % this.pagesX;
    const py = (page - px) / this.pagesX;
    const x0 = px * this.pageCells;
    const y0 = py * this.pageCells;
    return { x0, y0, w: Math.min(this.pageCells, this.dims.sizeX - x0), h: Math.min(this.pageCells, this.dims.sizeY - y0) };
  }
}

/**
 * Pending chunk uploads (ADR-0027): a newer version of a chunk replaces the queued one, uploads drain in
 * arrival order with a per-frame budget. Entries are views into the received buffers (no copy).
 */
export class ChunkQueue {
  private readonly pending = new Map<number, { ci: number; cj: number; data: Uint8Array }>();

  /** Every chunk received, at its latest version (kept only when asked: a grid that more than one renderer may attach to over its life). */
  private readonly latest: Map<number, { ci: number; cj: number; data: Uint8Array }> | undefined;

  constructor(
    private readonly chunksX: number,
    retain = false,
  ) {
    this.latest = retain ? new Map() : undefined;
  }

  /** Adds a received batch: `coords` (ci, cj) pairs, `data` the chunks back to back. */
  push(coords: Uint16Array, data: Uint8Array): void {
    const n = coords.length / 2;
    if (n === 0) return;
    const bytes = data.length / n;
    for (let k = 0; k < n; k++) {
      const ci = coords[k * 2] ?? 0;
      const cj = coords[k * 2 + 1] ?? 0;
      const key = cj * this.chunksX + ci;
      this.pending.delete(key); // re-insert: the latest version keeps its place at the end
      const chunk = { ci, cj, data: data.subarray(k * bytes, (k + 1) * bytes) };
      this.pending.set(key, chunk);
      this.latest?.delete(key);
      this.latest?.set(key, chunk);
    }
  }

  /** Up to `max` chunks, oldest first; they leave the queue. */
  take(max: number, visit: (ci: number, cj: number, data: Uint8Array) => void): number {
    let n = 0;
    for (const [key, c] of this.pending) {
      if (n >= max) break;
      this.pending.delete(key);
      visit(c.ci, c.cj, c.data);
      n++;
    }
    return n;
  }

  /** Queues every chunk received so far again (a renderer that attaches after another one drained the queue draws the whole grid, not what arrived since). */
  requeueAll(): void {
    if (!this.latest) return;
    for (const [key, c] of this.latest) if (!this.pending.has(key)) this.pending.set(key, c);
  }

  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }
}
