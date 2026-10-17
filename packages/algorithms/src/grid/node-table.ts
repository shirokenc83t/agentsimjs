/**
 * Sparse per-search node storage (open addressing): memory grows with the nodes a search touches, not with
 * the map size, so many concurrent queries on a 4 M-cell map stay cheap. Deterministic (no Map iteration).
 */
export class NodeTable {
  private keys: Int32Array;
  private slotOf: Int32Array; // hash slot -> node slot
  private mask: number;
  g: Float64Array;
  parent: Int32Array; // parent state id, -1 for none
  closed: Uint8Array;
  stateOf: Int32Array;
  count = 0;

  constructor(initial = 1024) {
    let cap = 1;
    while (cap < initial * 2) cap <<= 1;
    this.keys = new Int32Array(cap).fill(-1);
    this.slotOf = new Int32Array(cap);
    this.mask = cap - 1;
    this.g = new Float64Array(initial);
    this.parent = new Int32Array(initial);
    this.closed = new Uint8Array(initial);
    this.stateOf = new Int32Array(initial);
  }

  private hash(state: number): number {
    return Math.imul(state, 0x9e3779b1) >>> 0;
  }

  /** Node slot of `state`, or -1. */
  find(state: number): number {
    let h = this.hash(state) & this.mask;
    for (;;) {
      const k = this.keys[h] ?? -1;
      if (k === -1) return -1;
      if (k === state) return this.slotOf[h] ?? -1;
      h = (h + 1) & this.mask;
    }
  }

  /** Node slot of `state`, inserting it (g = +Infinity) if absent — one probe sequence for both cases. */
  findOrInsert(state: number): number {
    if ((this.count + 1) * 2 > this.keys.length) this.growHash();
    let h = this.hash(state) & this.mask;
    for (;;) {
      const k = this.keys[h] ?? -1;
      if (k === state) return this.slotOf[h] ?? -1;
      if (k === -1) break;
      h = (h + 1) & this.mask;
    }
    if (this.count >= this.g.length) this.growNodes();
    const slot = this.count++;
    this.keys[h] = state;
    this.slotOf[h] = slot;
    this.g[slot] = Number.POSITIVE_INFINITY;
    this.parent[slot] = -1;
    this.closed[slot] = 0;
    this.stateOf[slot] = state;
    return slot;
  }

  /** Inserts `state` (must be absent) with g = +Infinity; returns its node slot. */
  insert(state: number): number {
    if ((this.count + 1) * 2 > this.keys.length) this.growHash();
    if (this.count >= this.g.length) this.growNodes();
    const slot = this.count++;
    let h = this.hash(state) & this.mask;
    while ((this.keys[h] ?? -1) !== -1) h = (h + 1) & this.mask;
    this.keys[h] = state;
    this.slotOf[h] = slot;
    this.g[slot] = Number.POSITIVE_INFINITY;
    this.parent[slot] = -1;
    this.closed[slot] = 0;
    this.stateOf[slot] = state;
    return slot;
  }

  private growNodes(): void {
    const n = this.g.length * 2;
    const g = new Float64Array(n);
    g.set(this.g);
    this.g = g;
    const p = new Int32Array(n);
    p.set(this.parent);
    this.parent = p;
    const c = new Uint8Array(n);
    c.set(this.closed);
    this.closed = c;
    const s = new Int32Array(n);
    s.set(this.stateOf);
    this.stateOf = s;
  }

  private growHash(): void {
    const cap = this.keys.length * 2;
    const keys = new Int32Array(cap).fill(-1);
    const slotOf = new Int32Array(cap);
    const mask = cap - 1;
    for (let s = 0; s < this.count; s++) {
      const state = this.stateOf[s] ?? 0;
      let h = this.hash(state) & mask;
      while ((keys[h] ?? -1) !== -1) h = (h + 1) & mask;
      keys[h] = state;
      slotOf[h] = s;
    }
    this.keys = keys;
    this.slotOf = slotOf;
    this.mask = mask;
  }
}

/**
 * Binary min-heap of (f, h, state) with lazy deletion. Ordering: lower f, then lower h, then lower state
 * id (ADR-0024 fixed tie-breaking).
 */
export class OpenHeap {
  private f = new Float64Array(256);
  private h = new Float64Array(256);
  private s = new Int32Array(256);
  size = 0;

  private less(a: number, b: number): boolean {
    const fa = this.f[a] ?? 0;
    const fb = this.f[b] ?? 0;
    if (fa !== fb) return fa < fb;
    const ha = this.h[a] ?? 0;
    const hb = this.h[b] ?? 0;
    if (ha !== hb) return ha < hb;
    return (this.s[a] ?? 0) < (this.s[b] ?? 0);
  }

  private swap(a: number, b: number): void {
    const f = this.f[a] ?? 0;
    this.f[a] = this.f[b] ?? 0;
    this.f[b] = f;
    const h = this.h[a] ?? 0;
    this.h[a] = this.h[b] ?? 0;
    this.h[b] = h;
    const s = this.s[a] ?? 0;
    this.s[a] = this.s[b] ?? 0;
    this.s[b] = s;
  }

  push(f: number, h: number, state: number): void {
    if (this.size === this.f.length) {
      const n = this.size * 2;
      const nf = new Float64Array(n);
      nf.set(this.f);
      this.f = nf;
      const nh = new Float64Array(n);
      nh.set(this.h);
      this.h = nh;
      const ns = new Int32Array(n);
      ns.set(this.s);
      this.s = ns;
    }
    let i = this.size++;
    this.f[i] = f;
    this.h[i] = h;
    this.s[i] = state;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Pops the minimum; returns its state and sets `poppedF`. */
  poppedF = 0;
  pop(): number {
    const top = this.s[0] ?? -1;
    this.poppedF = this.f[0] ?? 0;
    this.size--;
    if (this.size > 0) {
      this.f[0] = this.f[this.size] ?? 0;
      this.h[0] = this.h[this.size] ?? 0;
      this.s[0] = this.s[this.size] ?? 0;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}
