import { xxHash32 } from "@agentsim/core";

export type LayerArray = Uint8Array | Uint16Array;
type LayerCtor<A extends LayerArray> = { new (length: number): A; readonly BYTES_PER_ELEMENT: number };

/**
 * One grid layer stored in square chunks (ADR-0012). A chunk is either **uniform** (a single value, no
 * memory) or **materialized** (a typed array of chunkSize² cells, row-major). Large, mostly empty maps
 * stay cheap; edits materialize only the chunks they touch.
 */
export class ChunkedLayer<A extends LayerArray> {
  private readonly data: (A | null)[];
  private readonly fill: number[];
  private readonly hashes: number[];
  private readonly hashValid: boolean[];
  readonly chunkCells: number;

  constructor(
    readonly chunksX: number,
    readonly chunksY: number,
    readonly chunkSize: number,
    readonly defaultValue: number,
    private readonly ctor: LayerCtor<A>,
  ) {
    const n = chunksX * chunksY;
    this.chunkCells = chunkSize * chunkSize;
    this.data = new Array<A | null>(n).fill(null);
    this.fill = new Array<number>(n).fill(defaultValue);
    this.hashes = new Array<number>(n).fill(0);
    this.hashValid = new Array<boolean>(n).fill(false);
  }

  private chunkIndex(ci: number, cj: number): number {
    return cj * this.chunksX + ci;
  }

  /** Value of cell (i, j) (caller guarantees bounds). */
  get(i: number, j: number): number {
    const cs = this.chunkSize;
    const ci = (i / cs) | 0;
    const cj = (j / cs) | 0;
    const k = this.chunkIndex(ci, cj);
    const arr = this.data[k];
    if (!arr) return this.fill[k] ?? this.defaultValue;
    return arr[(j - cj * cs) * cs + (i - ci * cs)] ?? this.defaultValue;
  }

  /** Sets cell (i, j); returns true if the value changed (the caller marks the chunk dirty). */
  set(i: number, j: number, value: number): boolean {
    const cs = this.chunkSize;
    const ci = (i / cs) | 0;
    const cj = (j / cs) | 0;
    const k = this.chunkIndex(ci, cj);
    let arr = this.data[k];
    if (!arr) {
      const f = this.fill[k] ?? this.defaultValue;
      if (f === value) return false;
      arr = new this.ctor(this.chunkCells);
      if (f !== 0) arr.fill(f);
      this.data[k] = arr;
    }
    const idx = (j - cj * cs) * cs + (i - ci * cs);
    if (arr[idx] === value) return false;
    arr[idx] = value;
    this.hashValid[k] = false;
    return true;
  }

  /** Sets a whole chunk to one value (frees its array). */
  fillChunk(ci: number, cj: number, value: number): void {
    const k = this.chunkIndex(ci, cj);
    this.data[k] = null;
    this.fill[k] = value;
    this.hashValid[k] = false;
  }

  /** Replaces a chunk with `values` (copied); collapses to uniform when all values are equal. */
  setChunk(ci: number, cj: number, values: ArrayLike<number>): void {
    if (values.length !== this.chunkCells) throw new RangeError(`chunk needs ${this.chunkCells} values, got ${values.length}`);
    const first = values[0] ?? 0;
    let uniform = true;
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== first) {
        uniform = false;
        break;
      }
    }
    if (uniform) return this.fillChunk(ci, cj, first);
    const k = this.chunkIndex(ci, cj);
    const arr = new this.ctor(this.chunkCells);
    for (let i = 0; i < values.length; i++) arr[i] = values[i] ?? 0;
    this.data[k] = arr;
    this.hashValid[k] = false;
  }

  /** Uniform value of the chunk, or null if materialized. */
  uniformValue(ci: number, cj: number): number | null {
    const k = this.chunkIndex(ci, cj);
    return this.data[k] ? null : (this.fill[k] ?? this.defaultValue);
  }

  /** Copies the chunk's cells into `out` (row-major). */
  readChunk(ci: number, cj: number, out: { [i: number]: number; length: number }): void {
    const k = this.chunkIndex(ci, cj);
    const arr = this.data[k];
    if (arr) {
      for (let i = 0; i < this.chunkCells; i++) out[i] = arr[i] ?? 0;
    } else {
      const f = this.fill[k] ?? this.defaultValue;
      for (let i = 0; i < this.chunkCells; i++) out[i] = f;
    }
  }

  /** xxHash32 of the chunk's canonical bytes (little-endian cells), cached until the chunk changes. */
  chunkHash(ci: number, cj: number): number {
    const k = this.chunkIndex(ci, cj);
    if (this.hashValid[k]) return this.hashes[k] ?? 0;
    const bytesPer = this.ctor.BYTES_PER_ELEMENT;
    const bytes = new Uint8Array(this.chunkCells * bytesPer);
    const arr = this.data[k];
    const f = this.fill[k] ?? this.defaultValue;
    for (let c = 0; c < this.chunkCells; c++) {
      const v = arr ? (arr[c] ?? 0) : f;
      bytes[c * bytesPer] = v & 0xff;
      if (bytesPer === 2) bytes[c * bytesPer + 1] = (v >>> 8) & 0xff;
    }
    const h = xxHash32(bytes, 0);
    this.hashes[k] = h;
    this.hashValid[k] = true;
    return h;
  }

  /** Bytes held by materialized chunks (memory report). */
  materializedBytes(): number {
    let n = 0;
    for (const a of this.data) if (a) n += a.byteLength;
    return n;
  }
}
