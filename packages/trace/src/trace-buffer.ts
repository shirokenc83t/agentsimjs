import type { DegradationEvent } from "@agentsim/core";
import { isValidSource } from "./source.ts";
import type { TraceRecord } from "./trace-record.ts";

type RecordInput = Omit<TraceRecord, "id" | "runId" | "seq" | "wallTime" | "source">;

/** The position of a `TraceBuffer` in its run: the next sequence number and the time of the latest record. */
export interface TraceCursor {
  readonly seq: number;
  readonly lastSimTime: number;
}

/**
 * A component's handle on the trace (ADR-0031): every record it appends carries its bound source, so
 * components never pass (or forge) a source themselves.
 */
export interface Tracer {
  readonly source: string;
  append(r: RecordInput): TraceRecord;
}

/**
 * The trace of a run in memory (ADR-0004 and ADR-0035 additions of 2026-10-17, item 6): assigns per-run sequence numbers and IDs, and
 * is the UI cache of the run. In a recorded run (`holdUnpersisted`) it forgets a record only once the record is persisted, down to
 * `capacity` (it may hold more while records wait for their flush); in an opted-out run it forgets the oldest beyond `capacity` and
 * counts them (`dropped`).
 */
export class TraceBuffer {
  private readonly records: TraceRecord[] = [];
  private seq = 0;
  private lastSimTime = 0;
  private droppedCount = 0;
  /** Recorded run: records leave the cache only once persisted (up to `persistedSeq`, inclusive). */
  private holding = false;
  private persistedSeq = -1;
  private readonly tracers = new Map<string, Tracer>();

  constructor(
    readonly runId: string,
    private readonly nowWallMs: () => number,
    private readonly capacity = 10_000,
  ) {}

  /** The tracer for `source`; an invalid source is a programmer error. */
  for(source: string): Tracer {
    let t = this.tracers.get(source);
    if (!t) {
      if (!isValidSource(source)) throw new Error(`invalid trace source "${source}"`);
      t = { source, append: (r) => this.push(r, source) };
      this.tracers.set(source, t);
    }
    return t;
  }

  private push(r: RecordInput, source: string): TraceRecord {
    // Run invariant (ADR-0031 amendment): seq order is sim-time order.
    if (r.simTime < this.lastSimTime) throw new Error(`trace time went backwards: ${r.simTime} < ${this.lastSimTime}`);
    this.lastSimTime = r.simTime;
    const seq = this.seq++;
    const rec: TraceRecord = { ...r, source, id: `${this.runId}#${seq}`, runId: this.runId, seq, wallTime: this.nowWallMs() };
    this.records.push(rec);
    if (this.records.length > this.capacity) {
      if (this.holding) this.forgetPersisted();
      else {
        this.records.shift();
        this.droppedCount++;
      }
    }
    return rec;
  }

  /** Maps a scheduler degradation (ADR-0013) to a `degradation` record emitted by `world/sim`. */
  degradation(e: DegradationEvent): TraceRecord {
    return this.for("world/sim").append({
      simTime: e.simTimeS,
      kind: "degradation",
      detail: "full",
      payload: { reason: e.kind, tick: e.tick, skippedTicks: e.skippedTicks, maxTicksPerAdvance: e.maxTicksPerAdvance },
    });
  }

  /**
   * The wait for the writer in a realtime run (ADR-0035 §6, ADR-0013 addition of 2026-10-17): a `degradation` record `storage_backpressure` with
   * the backlog that caused it and how long the run waited. (Lockstep and headless runs wait too, but only wall time is lost: no record.)
   */
  storageBackpressure(e: { tick: number; simTimeS: number; backlogRecords: number; backlogBytes: number; waitMs: number }): TraceRecord {
    return this.for("world/sim").append({
      simTime: e.simTimeS,
      kind: "degradation",
      detail: "full",
      payload: { reason: "storage_backpressure", tick: e.tick, backlogRecords: e.backlogRecords, backlogBytes: e.backlogBytes, waitMs: e.waitMs },
    });
  }

  /**
   * Where the buffer's sequence and its sim-time order stand: what a snapshot carries (F3a M1; ADR-0035 addition of
   * 2026-10-17, item 8). The records themselves are output, persisted by the recorder (F3a M2), not run state.
   */
  cursor(): TraceCursor {
    return { seq: this.seq, lastSimTime: this.lastSimTime };
  }

  /**
   * Seeds an empty buffer so that the records written after a restore continue the sequence (`<run>#<seq>`) and keep the
   * sim-time order. The buffer must hold no record: a restored run skips genesis, so it has written none.
   */
  restoreCursor(c: TraceCursor): void {
    if (this.records.length > 0 || this.seq !== 0) throw new Error("the trace cursor can only be restored into an empty buffer");
    if (!Number.isInteger(c.seq) || c.seq < 0 || !(c.lastSimTime >= 0)) throw new RangeError(`bad trace cursor ${JSON.stringify(c)}`);
    this.seq = c.seq;
    this.lastSimTime = c.lastSimTime;
  }

  /** Recorded run: from now on a record is forgotten only once it is persisted (`markPersisted`). */
  holdUnpersisted(): void {
    this.holding = true;
  }

  /** Records up to `seq` (inclusive) are persisted; the cache may now forget them, oldest first, beyond its capacity. */
  markPersisted(seq: number): void {
    this.persistedSeq = Math.max(this.persistedSeq, Math.min(seq, this.seq - 1));
    if (this.holding) this.forgetPersisted();
  }

  private forgetPersisted(): void {
    let n = 0;
    while (this.records.length - n > this.capacity && (this.records[n] as TraceRecord).seq <= this.persistedSeq) n++;
    if (n > 0) this.records.splice(0, n);
  }

  /** Sequence number the next record gets. */
  get nextSeq(): number {
    return this.seq;
  }

  /** The records with `seq` at or after the given one that the cache still holds, in order. */
  since(seq: number): TraceRecord[] {
    const first = this.records[0];
    if (!first) return [];
    return this.records.slice(Math.max(0, seq - first.seq));
  }

  all(): readonly TraceRecord[] {
    return this.records;
  }

  ofKind(kind: TraceRecord["kind"]): TraceRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
