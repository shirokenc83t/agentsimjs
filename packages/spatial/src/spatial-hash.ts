/**
 * Spatial hash for neighbor queries (ADR-0012), with buckets aligned to grid chunks. Results are always
 * sorted by entity id (deterministic, never insertion or Map order). Entities are points in metres.
 */
export class SpatialHash {
  private readonly buckets = new Map<number, Set<string>>();
  private readonly positions = new Map<string, { x: number; y: number; bucket: number }>();

  constructor(
    /** Bucket edge in metres (e.g. chunkSize × resolution). */
    readonly bucketSizeM: number,
    private readonly bucketsX: number,
  ) {
    if (!(bucketSizeM > 0)) throw new RangeError("bucketSizeM must be positive");
  }

  private bucketOf(x: number, y: number): number {
    return Math.floor(y / this.bucketSizeM) * this.bucketsX + Math.floor(x / this.bucketSizeM);
  }

  /** Inserts or moves an entity. */
  set(id: string, x: number, y: number): void {
    const b = this.bucketOf(x, y);
    const prev = this.positions.get(id);
    if (prev && prev.bucket !== b) this.buckets.get(prev.bucket)?.delete(id);
    if (!prev || prev.bucket !== b) {
      let set = this.buckets.get(b);
      if (!set) {
        set = new Set();
        this.buckets.set(b, set);
      }
      set.add(id);
    }
    this.positions.set(id, { x, y, bucket: b });
  }

  remove(id: string): void {
    const prev = this.positions.get(id);
    if (!prev) return;
    this.buckets.get(prev.bucket)?.delete(id);
    this.positions.delete(id);
  }

  get size(): number {
    return this.positions.size;
  }

  /** Ids within `radiusM` of (x, y) (inclusive), sorted by id. */
  queryRadius(x: number, y: number, radiusM: number, excludeId?: string): string[] {
    const r2 = radiusM * radiusM;
    const b0x = Math.floor((x - radiusM) / this.bucketSizeM);
    const b1x = Math.floor((x + radiusM) / this.bucketSizeM);
    const b0y = Math.floor((y - radiusM) / this.bucketSizeM);
    const b1y = Math.floor((y + radiusM) / this.bucketSizeM);
    const out: string[] = [];
    for (let by = b0y; by <= b1y; by++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        if (bx < 0 || by < 0 || bx >= this.bucketsX) continue;
        const set = this.buckets.get(by * this.bucketsX + bx);
        if (!set) continue;
        for (const id of set) {
          if (id === excludeId) continue;
          const p = this.positions.get(id);
          if (!p) continue;
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy <= r2) out.push(id);
        }
      }
    }
    return out.sort();
  }
}
