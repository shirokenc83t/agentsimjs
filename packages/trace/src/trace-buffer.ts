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
 * In-memory trace recorder v0 (F1). Assigns per-run sequence numbers and IDs; persistence through the
 * TraceStore arrives with the F3 recorder. Bounded: the oldest records are dropped beyond `capacity`
 * (counted), which is acceptable only until F3.
 */
export class TraceBuffer {
  private readonly records: TraceRecord[] = [];
  private seq = 0;
  private lastSimTime = 0;
  private droppedCount = 0;
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
      this.records.shift();
      this.droppedCount++;
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
