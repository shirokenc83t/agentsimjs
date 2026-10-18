import { xxHash32, type StateHasher } from "@agentsim/core";

/** Log-odds clamp and belief thresholds (ADR-0028 addition of 2026-10-09). */
export const LOGODDS_CLAMP = 100;
export const BELIEF_THRESHOLD = 20;

export const BELIEF_UNKNOWN = 0;
export const BELIEF_FREE = 1;
export const BELIEF_OCCUPIED = 2;
export type BeliefState = typeof BELIEF_UNKNOWN | typeof BELIEF_FREE | typeof BELIEF_OCCUPIED;

/** Height sentinel (dm): no upper bound known. */
const HEIGHT_UNKNOWN = 0xffff;

/** A lower bound in dm, floored so it stays a lower bound. */
function floorDm(m: number): number {
  return Math.min(HEIGHT_UNKNOWN - 1, Math.max(0, Math.floor(m * 10 + 1e-9)));
}

/** Believed state of a log-odds value. */
function classOf(l: number): BeliefState {
  return l <= -BELIEF_THRESHOLD ? BELIEF_FREE : l >= BELIEF_THRESHOLD ? BELIEF_OCCUPIED : BELIEF_UNKNOWN;
}

/** An upper bound in dm, ceiled so it stays an upper bound. */
function ceilDm(m: number): number {
  return Math.min(HEIGHT_UNKNOWN - 1, Math.max(0, Math.ceil(m * 10 - 1e-9)));
}

interface Chunk {
  readonly logOdds: Int8Array;
  /** Materialized at the first occupied evidence in the chunk. */
  knownMinDm: Uint16Array | undefined;
  knownMaxDm: Uint16Array | undefined;
}

/** A belief map as plain data (see `BeliefMap.snapshot`). Large: up to ~20 MiB for a fully explored 1 km² map. */
export interface BeliefMapSnapshot {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly chunkSize: number;
  readonly versionCounter: number;
  readonly planVersionCounter: number;
  /** Plan version of the first valid entry of the change log. */
  readonly logFirst: number;
  readonly chunkVersion: Uint32Array;
  readonly chunkPlanVersion: Uint32Array;
  /** The valid entries of the change log: the cell (j · sizeX + i) of each recent planning-relevant change, oldest first. */
  readonly planLog: Int32Array;
  /** The materialized chunks, ascending by index. */
  readonly chunks: readonly { readonly index: number; readonly logOdds: Int8Array; readonly knownMinDm: Uint16Array | undefined; readonly knownMaxDm: Uint16Array | undefined }[];
}

/**
 * The cells that changed between two sync points, with the values they have now (a belief delta of a recording, ADR-0035 addition of
 * 2026-10-18): cell indices `j · sizeX + i` ascending, their log-odds, and the height bounds of those that lie in a chunk that has them.
 */
export interface BeliefCellDelta {
  readonly cells: Int32Array;
  readonly logOdds: Int8Array;
  /** Positions in `cells` that carry height bounds, and the bounds (dm): present when any changed cell lies in a chunk with heights. */
  readonly heights?: { readonly at: Int32Array; readonly knownMinDm: Uint16Array; readonly knownMaxDm: Uint16Array };
}

/**
 * An agent's belief occupancy map (ADR-0012 belief map; heights from the ADR-0012 addition of 2026-10-09):
 * per cell, log-odds occupancy (int8, clamped at ±100, 0 = never observed) and an interval [knownMin, knownMax]
 * for an obstacle's top, in dm (a lower bound floored, an upper bound ceiled, so both stay conservative).
 * Chunked like the grid and sparse: a chunk is materialized at its first observation, and its height arrays at
 * its first occupied evidence. Every change bumps the version and stamps the chunk; observations that change
 * nothing (already at the clamp, bounds not tightened) leave both alone.
 */
export class BeliefMap {
  private readonly chunks: (Chunk | undefined)[];
  private readonly chunkVersion: Uint32Array;
  private versionCounter = 0;
  /** Planning-relevant changes only: a cell's believed state (free / unknown / occupied) or its height bounds. */
  private readonly chunkPlanVersion: Uint32Array;
  private planVersionCounter = 0;
  /** Cells of the most recent planning-relevant changes (bounded): entry n is plan version logFirst + n. */
  private readonly planLog = new Int32Array(1 << 15);
  private logLength = 0;
  private logFirst = 1;
  private materialized = 0;
  /** Cells changed since the last `takeCellDelta`, while a recording tracks them (undefined: not tracking, no cost). */
  private cellLog: Set<number> | undefined;
  /** Chunk version each cached content hash was taken at (−1: never). */
  private readonly hashedAt: Float64Array;
  /** Cached xxHash32 of each chunk's log-odds, knownMin and knownMax arrays. */
  private readonly chunkHash: Uint32Array;
  readonly chunksX: number;
  readonly chunksY: number;
  private readonly shift: number;
  private readonly mask: number;

  constructor(
    readonly sizeX: number,
    readonly sizeY: number,
    readonly chunkSize: number,
  ) {
    if (chunkSize < 1 || (chunkSize & (chunkSize - 1)) !== 0) throw new RangeError(`chunkSize must be a power of two: ${chunkSize}`);
    this.shift = 31 - Math.clz32(chunkSize);
    this.mask = chunkSize - 1;
    this.chunksX = Math.ceil(sizeX / chunkSize);
    this.chunksY = Math.ceil(sizeY / chunkSize);
    this.chunks = new Array<Chunk | undefined>(this.chunksX * this.chunksY).fill(undefined);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.chunkPlanVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.hashedAt = new Float64Array(this.chunksX * this.chunksY).fill(-1);
    this.chunkHash = new Uint32Array(3 * this.chunksX * this.chunksY);
  }

  get version(): number {
    return this.versionCounter;
  }

  /**
   * A deep, independent copy at this moment (F2b M4, ADR-0037 item 16: the strategy sandbox plans on a frozen map): same
   * content hash, versions and change log; later changes to either side never show on the other. Cost is one pass
   * over the materialized chunks, so it belongs to a researcher's request, not to a tick.
   */
  clone(): BeliefMap {
    const c = new BeliefMap(this.sizeX, this.sizeY, this.chunkSize);
    for (let k = 0; k < this.chunks.length; k++) {
      const s = this.chunks[k];
      if (s) c.chunks[k] = { logOdds: s.logOdds.slice(), knownMinDm: s.knownMinDm?.slice(), knownMaxDm: s.knownMaxDm?.slice() };
    }
    c.chunkVersion.set(this.chunkVersion);
    c.versionCounter = this.versionCounter;
    c.chunkPlanVersion.set(this.chunkPlanVersion);
    c.planVersionCounter = this.planVersionCounter;
    c.planLog.set(this.planLog);
    c.logLength = this.logLength;
    c.logFirst = this.logFirst;
    c.materialized = this.materialized;
    c.hashedAt.set(this.hashedAt);
    c.chunkHash.set(this.chunkHash);
    return c;
  }

  /**
   * The map as plain data for the snapshot codec (F3a M1; ADR-0035 addition of 2026-10-17, item 8): the materialized
   * chunks (log-odds and height bounds), the change stamps of every chunk, both version counters and the change log (its
   * valid entries). Hash caches are not part of it: they are rebuilt. The same map, unchanged, gives the same snapshot
   * bytes, so the snapshot can be stored once as a content-addressed section however many snapshots refer to it.
   */
  snapshot(): BeliefMapSnapshot {
    const chunks: BeliefMapSnapshot["chunks"][number][] = [];
    for (let k = 0; k < this.chunks.length; k++) {
      const c = this.chunks[k];
      if (c) chunks.push({ index: k, logOdds: c.logOdds.slice(), knownMinDm: c.knownMinDm?.slice(), knownMaxDm: c.knownMaxDm?.slice() });
    }
    return {
      sizeX: this.sizeX,
      sizeY: this.sizeY,
      chunkSize: this.chunkSize,
      versionCounter: this.versionCounter,
      planVersionCounter: this.planVersionCounter,
      logFirst: this.logFirst,
      chunkVersion: this.chunkVersion.slice(),
      chunkPlanVersion: this.chunkPlanVersion.slice(),
      planLog: this.planLog.slice(0, this.logLength),
      chunks,
    };
  }

  /**
   * Puts a snapshot back in place. The map is shared by the belief grid, the observer's trackers and the planner's views, so
   * it is not replaced. Restore into a map of the same geometry that has seen no observation (a freshly assembled run): the
   * derived layers (views, topology) catch up from the restored change stamps as they do from any change.
   */
  restore(s: BeliefMapSnapshot): void {
    if (s.sizeX !== this.sizeX || s.sizeY !== this.sizeY || s.chunkSize !== this.chunkSize) {
      throw new RangeError(`belief snapshot is ${s.sizeX} × ${s.sizeY} in chunks of ${s.chunkSize}, the map ${this.sizeX} × ${this.sizeY} in ${this.chunkSize}`);
    }
    if (s.chunkVersion.length !== this.chunkVersion.length || s.chunkPlanVersion.length !== this.chunkPlanVersion.length) throw new RangeError("belief snapshot has the wrong number of chunk stamps");
    if (s.planLog.length > this.planLog.length) throw new RangeError("belief snapshot's change log is longer than the map's");
    this.chunks.fill(undefined);
    this.materialized = 0;
    const cells = this.chunkSize * this.chunkSize;
    for (const c of s.chunks) {
      if (c.index < 0 || c.index >= this.chunks.length || this.chunks[c.index] !== undefined) throw new RangeError(`belief snapshot chunk ${c.index} is out of range or repeated`);
      if (c.logOdds.length !== cells || (c.knownMinDm && c.knownMinDm.length !== cells) || (c.knownMaxDm && c.knownMaxDm.length !== cells)) throw new RangeError(`belief snapshot chunk ${c.index} has the wrong size`);
      this.chunks[c.index] = { logOdds: c.logOdds.slice(), knownMinDm: c.knownMinDm?.slice(), knownMaxDm: c.knownMaxDm?.slice() };
      this.materialized++;
    }
    this.chunkVersion.set(s.chunkVersion);
    this.chunkPlanVersion.set(s.chunkPlanVersion);
    this.versionCounter = s.versionCounter;
    this.planVersionCounter = s.planVersionCounter;
    this.planLog.fill(0);
    this.planLog.set(s.planLog);
    this.logLength = s.planLog.length;
    this.logFirst = s.logFirst;
    this.hashedAt.fill(-1);
    this.chunkHash.fill(0);
  }

  /**
   * The content of the named chunks as plain data, copied (a belief delta of the recording, ADR-0035 addition of 2026-10-17, item 9: the
   * chunks that changed at a sync point). A chunk that was never observed has no content and is left out.
   */
  chunksSnapshot(indices: readonly number[]): BeliefMapSnapshot["chunks"][number][] {
    const out: BeliefMapSnapshot["chunks"][number][] = [];
    for (const k of indices) {
      if (!Number.isInteger(k) || k < 0 || k >= this.chunks.length) throw new RangeError(`chunk ${k} is out of range`);
      const c = this.chunks[k];
      if (c) out.push({ index: k, logOdds: c.logOdds.slice(), knownMinDm: c.knownMinDm?.slice(), knownMaxDm: c.knownMaxDm?.slice() });
    }
    return out;
  }

  /**
   * Replaces the content of the given chunks, in place (a replay rebuilds a map from a keyframe and the deltas after it). Every chunk is
   * checked before any is changed. The chunks are stamped as changed (so the content hash and overlays see them); the change log of
   * planning is not touched: a rebuilt map is read by overlays, never planned on.
   */
  applyChunks(entries: BeliefMapSnapshot["chunks"]): void {
    const cells = this.chunkSize * this.chunkSize;
    for (const c of entries) {
      if (!Number.isInteger(c.index) || c.index < 0 || c.index >= this.chunks.length) throw new RangeError(`belief chunk ${c.index} is out of range`);
      if (c.logOdds.length !== cells || (c.knownMinDm && c.knownMinDm.length !== cells) || (c.knownMaxDm && c.knownMaxDm.length !== cells)) throw new RangeError(`belief chunk ${c.index} has the wrong size`);
    }
    if (entries.length === 0) return;
    this.versionCounter++;
    for (const c of entries) {
      if (this.chunks[c.index] === undefined) this.materialized++;
      this.chunks[c.index] = { logOdds: c.logOdds.slice(), knownMinDm: c.knownMinDm?.slice(), knownMaxDm: c.knownMaxDm?.slice() };
      this.chunkVersion[c.index] = this.versionCounter;
    }
  }

  /** From now on, the cells that change are remembered until `takeCellDelta` (the recording's belief deltas). Off by default: nothing is kept and nothing costs. */
  trackCellChanges(): void {
    this.cellLog ??= new Set<number>();
  }

  /**
   * The cells that changed since the last call, with the values they have now, and the chunks they lie in (ascending); undefined when none
   * changed or when changes are not tracked. A keyframe taken at this point covers the changes, so it also calls this to forget them.
   */
  takeCellDelta(): { readonly delta: BeliefCellDelta; readonly chunks: number[] } | undefined {
    const log = this.cellLog;
    if (!log || log.size === 0) return undefined;
    const cells = Int32Array.from(log).sort();
    log.clear();
    const logOdds = new Int8Array(cells.length);
    const at: number[] = [];
    const inChunks = new Set<number>();
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k] as number;
      const i = cell % this.sizeX;
      const j = (cell - i) / this.sizeX;
      const ci = this.chunkIndex(i, j);
      inChunks.add(ci);
      const c = this.chunks[ci];
      if (!c) continue; // a touched cell always has its chunk
      const o = this.offset(i, j);
      logOdds[k] = c.logOdds[o] ?? 0;
      if (c.knownMinDm && c.knownMaxDm) at.push(k);
    }
    const chunks = [...inChunks].sort((a, b) => a - b); // cells are in row-major order, so their chunks are not
    if (at.length === 0) return { delta: { cells, logOdds }, chunks };
    const knownMinDm = new Uint16Array(at.length);
    const knownMaxDm = new Uint16Array(at.length);
    at.forEach((k, n) => {
      const cell = cells[k] as number;
      const i = cell % this.sizeX;
      const c = this.chunks[this.chunkIndex(i, (cell - i) / this.sizeX)];
      const o = this.offset(i, (cell - i) / this.sizeX);
      knownMinDm[n] = c?.knownMinDm?.[o] ?? 0;
      knownMaxDm[n] = c?.knownMaxDm?.[o] ?? HEIGHT_UNKNOWN;
    });
    return { delta: { cells, logOdds, heights: { at: Int32Array.from(at), knownMinDm, knownMaxDm } }, chunks };
  }

  /**
   * Sets the cells of a delta to the values it holds, in place (a replay rebuilds a map from a keyframe and the deltas after it). A chunk
   * that was never observed is made with log-odds 0 everywhere, and one that gains height bounds gets them at their starting values (0 and
   * unknown) for the cells the delta does not name, which is what the live map had. Everything is checked before anything changes; the changed chunks
   * are stamped as changed; the planning change log is not touched (a rebuilt map is read by overlays, never planned on).
   */
  applyCellDelta(d: BeliefCellDelta): void {
    const n = d.cells.length;
    if (d.logOdds.length !== n) throw new RangeError("a cell delta's cells and log-odds must have the same length");
    const total = this.sizeX * this.sizeY;
    for (let k = 0; k < n; k++) {
      const cell = d.cells[k] as number;
      if (cell < 0 || cell >= total) throw new RangeError(`cell ${cell} is out of range`);
    }
    const h = d.heights;
    if (h) {
      if (h.knownMinDm.length !== h.at.length || h.knownMaxDm.length !== h.at.length) throw new RangeError("a cell delta's heights must have the same length");
      for (const p of h.at) if (p < 0 || p >= n) throw new RangeError(`a cell delta's heights name position ${p} of ${n} cells`);
    }
    if (n === 0) return;
    this.versionCounter++;
    for (let k = 0; k < n; k++) {
      const cell = d.cells[k] as number;
      const i = cell % this.sizeX;
      const j = (cell - i) / this.sizeX;
      const c = this.materialize(i, j) as Chunk;
      c.logOdds[this.offset(i, j)] = d.logOdds[k] as number;
      this.chunkVersion[this.chunkIndex(i, j)] = this.versionCounter;
    }
    if (h) {
      for (let m = 0; m < h.at.length; m++) {
        const cell = d.cells[h.at[m] as number] as number;
        const i = cell % this.sizeX;
        const j = (cell - i) / this.sizeX;
        const c = this.materialize(i, j) as Chunk;
        if (!c.knownMinDm || !c.knownMaxDm) {
          const cells = this.chunkSize * this.chunkSize;
          c.knownMinDm = new Uint16Array(cells);
          c.knownMaxDm = new Uint16Array(cells).fill(HEIGHT_UNKNOWN);
        }
        const o = this.offset(i, j);
        c.knownMinDm[o] = h.knownMinDm[m] as number;
        c.knownMaxDm[o] = h.knownMaxDm[m] as number;
      }
    }
  }

  /**
   * Version of what planning reads (ADR-0024 addition of 2026-10-09: views change only when planning would): it
   * moves when a cell's believed state or height bounds change, not on every log-odds step.
   */
  get planVersion(): number {
    return this.planVersionCounter;
  }

  /** Chunk indices whose planning-relevant content changed after `planVersion`, ascending. */
  chunksPlanChangedSince(planVersion: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.chunkPlanVersion.length; k++) if ((this.chunkPlanVersion[k] ?? 0) > planVersion) out.push(k);
    return out;
  }

  /** Indices of the chunks that hold any observation, ascending (what a belief keyframe covers). */
  materializedIndices(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.chunks.length; k++) if (this.chunks[k]) out.push(k);
    return out;
  }

  /** Chunks that hold any observation (memory diagnostics). */
  get materializedChunks(): number {
    return this.materialized;
  }

  /** Chunk indices (cj · chunksX + ci) changed after `version`, ascending. */
  chunksChangedSince(version: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.chunkVersion.length; k++) if ((this.chunkVersion[k] ?? 0) > version) out.push(k);
    return out;
  }

  logOdds(i: number, j: number): number {
    const c = this.chunkAt(i, j);
    return c ? (c.logOdds[this.offset(i, j)] ?? 0) : 0;
  }

  state(i: number, j: number): BeliefState {
    const l = this.logOdds(i, j);
    return l <= -BELIEF_THRESHOLD ? BELIEF_FREE : l >= BELIEF_THRESHOLD ? BELIEF_OCCUPIED : BELIEF_UNKNOWN;
  }

  /** Lower bound of an obstacle's top (m); 0 when none is known. */
  knownMinM(i: number, j: number): number {
    const c = this.chunkAt(i, j);
    return c?.knownMinDm ? (c.knownMinDm[this.offset(i, j)] ?? 0) / 10 : 0;
  }

  /** Upper bound of an obstacle's top (m); +Infinity when none is known (an unknown upper bound blocks aircraft). */
  knownMaxM(i: number, j: number): number {
    const c = this.chunkAt(i, j);
    const v = c?.knownMaxDm ? (c.knownMaxDm[this.offset(i, j)] ?? HEIGHT_UNKNOWN) : HEIGHT_UNKNOWN;
    return v === HEIGHT_UNKNOWN ? Number.POSITIVE_INFINITY : v / 10;
  }

  /** Free ground observed: log-odds −= `miss`. A cell already at −clamp is left alone (fast path). */
  observeFree(i: number, j: number, miss: number): void {
    const c = this.chunkAt(i, j);
    if (c && c.logOdds[this.offset(i, j)] === -LOGODDS_CLAMP) return;
    this.addLogOdds(i, j, -miss);
  }

  /** An obstacle under the beam: log-odds += `hit`, its top below `upperM`. No-op when nothing would change. */
  observeUnder(i: number, j: number, upperM: number, hit: number): void {
    const c = this.chunkAt(i, j);
    if (c?.knownMaxDm) {
      const o = this.offset(i, j);
      if (c.logOdds[o] === LOGODDS_CLAMP && (c.knownMaxDm[o] ?? HEIGHT_UNKNOWN) <= ceilDm(upperM)) return;
    }
    const changed = this.addLogOdds(i, j, hit);
    const tightened = this.lowerMax(i, j, upperM);
    if (tightened && !changed) this.touch(i, j);
  }

  /** An obstacle reaching the beam: log-odds += `hit`, its top at least `lowerM`. No-op when nothing would change. */
  observeHit(i: number, j: number, lowerM: number, hit: number): void {
    const c = this.chunkAt(i, j);
    if (c?.knownMinDm) {
      const o = this.offset(i, j);
      if (c.logOdds[o] === LOGODDS_CLAMP && (c.knownMinDm[o] ?? 0) >= floorDm(lowerM)) return;
    }
    const changed = this.addLogOdds(i, j, hit);
    const raised = this.raiseMin(i, j, lowerM);
    if (raised && !changed) this.touch(i, j);
  }

  /** Contact (a bump): occupied at the clamp, its top at least the contact altitude. */
  observeContact(i: number, j: number, lowerM: number): void {
    const changed = this.setLogOdds(i, j, LOGODDS_CLAMP);
    const raised = this.raiseMin(i, j, lowerM);
    if (raised && !changed) this.touch(i, j);
  }

  /**
   * Believed state of every cell of chunk (ci, cj), row-major (BELIEF_UNKNOWN / FREE / OCCUPIED). Returns false,
   * leaving `out` untouched, for a chunk never observed (all unknown).
   */
  classifyChunk(ci: number, cj: number, out: Uint8Array): boolean {
    const c = this.chunks[cj * this.chunksX + ci];
    if (!c) return false;
    const l = c.logOdds;
    for (let n = 0; n < l.length; n++) {
      const v = l[n] ?? 0;
      out[n] = v <= -BELIEF_THRESHOLD ? BELIEF_FREE : v >= BELIEF_THRESHOLD ? BELIEF_OCCUPIED : BELIEF_UNKNOWN;
    }
    return true;
  }

  /** A prior's starting log-odds (ADR-0028 addition: ±round(60 × confidence)). */
  setPrior(i: number, j: number, logOdds: number): void {
    this.setLogOdds(i, j, logOdds);
  }

  /** A prior's obstacle top (dm, > 0): both bounds start at it (ADR-0012 belief-map heights). */
  setPriorHeightDm(i: number, j: number, dm: number): void {
    const c = this.materialize(i, j);
    if (!c) return;
    const h = this.heights(c, i, j);
    const o = this.offset(i, j);
    const v = Math.min(HEIGHT_UNKNOWN - 1, Math.max(0, Math.round(dm)));
    if (h.min[o] === v && h.max[o] === v) return;
    h.min[o] = v;
    h.max[o] = v;
    this.touch(i, j);
    this.touchPlan(i, j);
  }

  /**
   * Content hash (state hash, F2 M2b): chunks in index order, unmaterialized chunks as a marker. The state hash
   * is taken every tick, so each chunk's content hashes are cached and recomputed only when its version moved:
   * the cost per tick is one pass over the chunk table plus the chunks changed since the last hash.
   */
  hashInto(h: StateHasher): void {
    h.u32(this.sizeX).u32(this.sizeY).u32(this.chunkSize);
    for (let k = 0; k < this.chunks.length; k++) {
      const c = this.chunks[k];
      if (!c) {
        h.u32(0);
        continue;
      }
      const v = this.chunkVersion[k] ?? 0;
      if (this.hashedAt[k] !== v) {
        this.chunkHash[3 * k] = xxHash32(new Uint8Array(c.logOdds.buffer, c.logOdds.byteOffset, c.logOdds.byteLength));
        this.chunkHash[3 * k + 1] = c.knownMinDm ? xxHash32(new Uint8Array(c.knownMinDm.buffer, c.knownMinDm.byteOffset, c.knownMinDm.byteLength)) : 0;
        this.chunkHash[3 * k + 2] = c.knownMaxDm ? xxHash32(new Uint8Array(c.knownMaxDm.buffer, c.knownMaxDm.byteOffset, c.knownMaxDm.byteLength)) : 0;
        this.hashedAt[k] = v;
      }
      h.u32(1).bytesHash(this.chunkHash[3 * k] ?? 0);
      h.bytesHash(this.chunkHash[3 * k + 1] ?? 0);
      h.bytesHash(this.chunkHash[3 * k + 2] ?? 0);
    }
  }

  private inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.sizeX && j < this.sizeY;
  }

  // Chunk sizes are powers of two (the grid's): shifts and masks address cells.
  private chunkIndex(i: number, j: number): number {
    return (j >> this.shift) * this.chunksX + (i >> this.shift);
  }

  private offset(i: number, j: number): number {
    return ((j & this.mask) << this.shift) | (i & this.mask);
  }

  private chunkAt(i: number, j: number): Chunk | undefined {
    return this.inBounds(i, j) ? this.chunks[this.chunkIndex(i, j)] : undefined;
  }

  private materialize(i: number, j: number): Chunk | undefined {
    if (!this.inBounds(i, j)) return undefined;
    const k = this.chunkIndex(i, j);
    let c = this.chunks[k];
    if (!c) {
      c = { logOdds: new Int8Array(this.chunkSize * this.chunkSize), knownMinDm: undefined, knownMaxDm: undefined };
      this.chunks[k] = c;
      this.materialized++;
    }
    return c;
  }

  /** The chunk's height arrays, allocated on first use; allocating changes the chunk's content hash, so it stamps it. */
  private heights(c: Chunk, i: number, j: number): { min: Uint16Array; max: Uint16Array } {
    if (!c.knownMinDm || !c.knownMaxDm) {
      const n = this.chunkSize * this.chunkSize;
      c.knownMinDm = new Uint16Array(n);
      c.knownMaxDm = new Uint16Array(n).fill(HEIGHT_UNKNOWN);
      this.touch(i, j);
    }
    return { min: c.knownMinDm, max: c.knownMaxDm };
  }

  private touch(i: number, j: number): void {
    this.versionCounter++;
    this.chunkVersion[this.chunkIndex(i, j)] = this.versionCounter;
    this.cellLog?.add(j * this.sizeX + i);
  }

  private addLogOdds(i: number, j: number, delta: number): boolean {
    const c = this.materialize(i, j);
    if (!c) return false;
    const o = this.offset(i, j);
    const prev = c.logOdds[o] ?? 0;
    return this.write(i, j, c, o, prev, Math.max(-LOGODDS_CLAMP, Math.min(LOGODDS_CLAMP, prev + delta)));
  }

  private setLogOdds(i: number, j: number, value: number): boolean {
    const c = this.materialize(i, j);
    if (!c) return false;
    const o = this.offset(i, j);
    return this.write(i, j, c, o, c.logOdds[o] ?? 0, Math.max(-LOGODDS_CLAMP, Math.min(LOGODDS_CLAMP, Math.round(value))));
  }

  private write(i: number, j: number, c: Chunk, o: number, prev: number, next: number): boolean {
    if (next === prev) return false;
    c.logOdds[o] = next;
    this.touch(i, j);
    if (classOf(prev) !== classOf(next)) this.touchPlan(i, j);
    return true;
  }

  private touchPlan(i: number, j: number): void {
    this.planVersionCounter++;
    this.chunkPlanVersion[this.chunkIndex(i, j)] = this.planVersionCounter;
    // Change log: entry n is the cell of plan version logFirst + n (one entry per version).
    if (this.logLength === this.planLog.length) {
      // Keep the newer half: views synced at every sync point never need older entries.
      const half = this.planLog.length >> 1;
      this.planLog.copyWithin(0, half);
      this.logLength -= half;
      this.logFirst += half;
    }
    this.planLog[this.logLength++] = j * this.sizeX + i;
  }

  /**
   * Cells (j · sizeX + i) whose planning-relevant content changed after `planVersion`, in change order (a cell can
   * appear more than once), or undefined when that version is older than the retained log (use the chunk lists).
   * A view of the log: valid until the next change.
   */
  cellsPlanChangedSince(planVersion: number): Int32Array | undefined {
    if (planVersion < this.logFirst - 1) return undefined;
    const from = Math.max(0, planVersion - (this.logFirst - 1));
    return this.planLog.subarray(Math.min(from, this.logLength), this.logLength);
  }

  private raiseMin(i: number, j: number, lowerM: number): boolean {
    const c = this.materialize(i, j);
    if (!c) return false;
    const h = this.heights(c, i, j);
    const o = this.offset(i, j);
    const dm = floorDm(lowerM);
    if (dm <= (h.min[o] ?? 0)) return false;
    h.min[o] = dm;
    // Sensing bounds always bracket the true top; only a wrong prior can leave the upper bound below the new
    // lower one. The observation wins and the top is unknown again (conservative for aircraft).
    if ((h.max[o] ?? HEIGHT_UNKNOWN) < dm) h.max[o] = HEIGHT_UNKNOWN;
    this.touchPlan(i, j);
    return true;
  }

  private lowerMax(i: number, j: number, upperM: number): boolean {
    const c = this.materialize(i, j);
    if (!c) return false;
    const h = this.heights(c, i, j);
    const o = this.offset(i, j);
    const dm = ceilDm(upperM);
    if (dm >= (h.max[o] ?? HEIGHT_UNKNOWN)) return false;
    h.max[o] = dm;
    // As in raiseMin: a wrong prior's lower bound gives way to the observation.
    if ((h.min[o] ?? 0) > dm) h.min[o] = dm;
    this.touchPlan(i, j);
    return true;
  }
}
