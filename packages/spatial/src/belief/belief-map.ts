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
