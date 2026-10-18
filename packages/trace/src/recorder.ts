import { filterRecord } from "./levels.ts";
import { redactSecrets } from "./redact.ts";
import type { RecordingProfile } from "./recording-profile.ts";
import type { TraceBuffer } from "./trace-buffer.ts";
import type { TraceRecord } from "./trace-record.ts";

// The recorder at the producer (ADR-0035 addition of 2026-10-17, items 6 and 12; ADR-0004 and ADR-0019 additions of the same date):
// it sits in the sim worker next to the run's TraceBuffer, applies the recording profile to what the run emitted, and hands batches
// to the storage worker (over a channel the main thread set up; records never cross the main thread). It knows the sim head (the
// latest tick it was told about) and the persisted head (what the storage worker reported flushed), and it tells the buffer, which is the
// UI cache, which records are saved, so the cache never forgets a record that is not.

/** What the sim worker hands the storage worker: the records of one or more ticks, profile applied, and where the run stands. */
export interface RecorderBatch {
  readonly runId: string;
  /** The records, in seq order (those the profile drops are not here: seqs may skip). */
  readonly records: readonly TraceRecord[];
  /** Highest seq the batch covers, including the records the profile dropped. */
  readonly throughSeq: number;
  /** The sim head when the batch was made. */
  readonly tick: number;
  readonly simTimeS: number;
}

/** What the storage worker reports after it flushed a batch: everything up to here is saved. */
export interface PersistedHead {
  readonly runId: string;
  readonly throughSeq: number;
  readonly tick: number;
  readonly simTimeS: number;
}

/** A snapshot of the run, as the storage worker takes it: its container and the blobs its sections are, when not stored yet (ADR-0004 addition of 2026-10-18). */
export interface RecorderSnapshotItem {
  readonly type: "snapshot";
  readonly runId: string;
  /** Seq of the run's `snapshot` trace record. */
  readonly seq: number;
  readonly simTimeS: number;
  readonly tick: number;
  readonly bytes: Uint8Array;
  readonly blobs: readonly { readonly id: string; readonly bytes: Uint8Array }[];
}

/** Belief-map frames of agents (keyframes with their blobs, deltas inline), as the storage worker takes them. */
export interface RecorderFramesItem {
  readonly type: "frames";
  readonly runId: string;
  readonly frames: readonly {
    readonly agentId: string;
    readonly seq: number;
    readonly tick: number;
    readonly simTime: number;
    readonly kind: "keyframe" | "delta";
    readonly chunks: readonly number[];
    readonly blobId?: string;
    readonly data?: Uint8Array;
  }[];
  readonly blobs: readonly { readonly id: string; readonly bytes: Uint8Array }[];
}

/** What a recorder hands over besides batches of records. Items go out in order with the batches, and before the batch that refers to them. */
export type RecorderItem = RecorderSnapshotItem | RecorderFramesItem;

/** The bytes an item weighs in the backlog. */
export function itemBytes(i: RecorderItem): number {
  return i.type === "snapshot"
    ? i.bytes.length + i.blobs.reduce((n, b) => n + b.bytes.length, 0)
    : i.blobs.reduce((n, b) => n + b.bytes.length, 0) + i.frames.reduce((n, f) => n + (f.data?.length ?? 0) + f.chunks.length * 4 + 64, 0);
}

export interface SimHead {
  readonly tick: number;
  readonly simTimeS: number;
}

export type GapState = "none-yet" | "behind" | "saved";

export interface Gap {
  readonly state: GapState;
  readonly ticks: number;
  readonly simTimeS: number;
}

/**
 * How far the saved part of a recorded run is behind the live one: `none-yet` (nothing flushed yet: the gap is all of it), `behind`
 * (a flush happened, newer ticks are not saved yet) or `saved` (no gap).
 */
export function gapOf(sim: SimHead, persisted: SimHead | undefined): Gap {
  if (!persisted) return { state: "none-yet", ticks: sim.tick, simTimeS: sim.simTimeS };
  const ticks = Math.max(0, sim.tick - persisted.tick);
  return ticks === 0 ? { state: "saved", ticks: 0, simTimeS: 0 } : { state: "behind", ticks, simTimeS: Math.max(0, sim.simTimeS - persisted.simTimeS) };
}

/**
 * Flow control (ADR-0035 §6): the backlog is the records handed over (or held for the header) and not yet reported saved. Above a high
 * mark the run waits at the end of the tick; it goes on once the backlog is at or below the low mark. Records are never dropped.
 */
export interface FlowControl {
  readonly highRecords: number;
  readonly lowRecords: number;
  readonly highBytes: number;
  readonly lowBytes: number;
}

/** The starting values (ADR-0035 §6: "e.g. 50,000 records or 32 MB", the low mark half of it); reported by the F3a M2 measurement. */
export const DEFAULT_FLOW_CONTROL: FlowControl = { highRecords: 50_000, lowRecords: 25_000, highBytes: 32 * 1024 * 1024, lowBytes: 16 * 1024 * 1024 };

const RECORD_OVERHEAD_BYTES = 160;

/** What a record weighs in the backlog: its fields and its payload as JSON text. An estimate: it only has to be stable and about right. */
export function estimateRecordBytes(r: TraceRecord): number {
  return RECORD_OVERHEAD_BYTES + (r.payload === undefined ? 0 : JSON.stringify(r.payload).length);
}

export interface Backlog {
  readonly records: number;
  readonly bytes: number;
}

export interface RunRecorderOptions {
  readonly buffer: TraceBuffer;
  readonly profile: RecordingProfile;
  /** Hands a batch to the storage worker. Called once per `collect` that has something to say. */
  readonly send: (batch: RecorderBatch) => void;
  /** Hands a snapshot or belief frames to the storage worker (items are refused without it). */
  readonly sendItem?: (item: RecorderItem) => void;
  /** The marks of the backlog (default: `DEFAULT_FLOW_CONTROL`). */
  readonly flow?: FlowControl;
}

interface InFlight {
  readonly throughSeq: number;
  readonly records: number;
  readonly bytes: number;
}

export class RunRecorder {
  private readonly buffer: TraceBuffer;
  private readonly profile: RecordingProfile;
  private readonly send: (batch: RecorderBatch) => void;
  private readonly flow: FlowControl;
  private readonly sendItem: ((item: RecorderItem) => void) | undefined;
  /** Items given before the header is stored, in order. */
  private outbox: RecorderItem[] = [];
  /** Items sent since the last batch: a batch follows them even without records, so the persisted head can pass them. */
  private itemsSent = 0;
  private cursor = 0;
  private heldBytes = 0;
  private isWaiting = false;
  private header = false;
  private held: TraceRecord[] = [];
  private panel: TraceRecord[] = [];
  private inFlight: InFlight[] = [];
  private lastThroughSeq = -1;
  private sim: SimHead = { tick: 0, simTimeS: 0 };
  private persistedAt: PersistedHead | undefined;

  constructor(o: RunRecorderOptions) {
    this.buffer = o.buffer;
    this.profile = o.profile;
    this.send = o.send;
    this.flow = o.flow ?? DEFAULT_FLOW_CONTROL;
    this.sendItem = o.sendItem;
    // From now on the cache forgets a record only once it is persisted.
    this.buffer.holdUnpersisted();
  }

  /** The run header is not stored yet: records are gathered but nothing is sent. */
  get awaitingHeader(): boolean {
    return !this.header;
  }

  get simHead(): SimHead {
    return this.sim;
  }

  get persistedHead(): PersistedHead | undefined {
    return this.persistedAt;
  }

  /** Records handed over and not yet reported saved. */
  get backlogRecords(): number {
    return this.backlog.records;
  }

  /** The backlog in records and (estimated) bytes: what was handed over or held for the header, and is not reported saved. */
  get backlog(): Backlog {
    return { records: this.inFlight.reduce((n, b) => n + b.records, this.held.length), bytes: this.inFlight.reduce((n, b) => n + b.bytes, this.heldBytes) };
  }

  /** True from the moment the backlog reaches a high mark until it is at or below both low marks: the run waits at the end of the tick. */
  get waiting(): boolean {
    return this.isWaiting;
  }

  private updateWaiting(): void {
    const b = this.backlog;
    if (!this.isWaiting) this.isWaiting = b.records >= this.flow.highRecords || b.bytes >= this.flow.highBytes;
    else if (b.records <= this.flow.lowRecords && b.bytes <= this.flow.lowBytes) this.isWaiting = false;
  }

  /** The storage worker has the run header: what was gathered before goes out now, in one batch. */
  headerStored(): void {
    if (this.header) return;
    this.header = true;
    const items = this.outbox;
    this.outbox = [];
    for (const i of items) this.dispatch(i);
    this.flush();
    this.updateWaiting();
  }

  /**
   * Hands over a snapshot or belief frames, in order with the batches: held until the header is stored, then sent at once, and before the
   * batch that holds the records collected after it. Give it after the record that refers to it was emitted and before the next `collect`.
   */
  enqueue(item: RecorderItem): void {
    if (!this.sendItem) throw new Error("this recorder has no channel for snapshots and frames");
    this.heldBytes += itemBytes(item);
    if (this.header) this.dispatch(item);
    else this.outbox.push(item);
    this.updateWaiting();
  }

  private dispatch(item: RecorderItem): void {
    this.itemsSent++;
    (this.sendItem as (i: RecorderItem) => void)(item);
  }

  /**
   * Gathers the records the run emitted since the last call (the cache keeps them until they are saved), applies the profile and
   * credential redaction, and hands the batch over once the header is stored. `tick` and `simTimeS` are the sim head.
   */
  collect(tick: number, simTimeS: number): void {
    this.sim = { tick, simTimeS };
    const fresh = this.buffer.since(this.cursor);
    const last = fresh[fresh.length - 1];
    if (last) {
      this.cursor = last.seq + 1;
      this.lastThroughSeq = last.seq;
      for (const r of fresh) {
        const kept = filterRecord(this.profile, r);
        if (kept) {
          const safe = redactSecrets(kept);
          this.held.push(safe);
          this.heldBytes += estimateRecordBytes(safe);
          this.panel.push(safe);
        }
      }
    }
    if (this.header) this.flush();
    this.updateWaiting();
  }

  private flush(): void {
    const records = this.held;
    // Nothing new and nothing waiting to be saved: everything up to this tick is saved already.
    if (records.length === 0 && this.inFlight.length === 0 && this.itemsSent === 0) {
      if (this.persistedAt) this.persistedAt = { ...this.persistedAt, tick: this.sim.tick, simTimeS: this.sim.simTimeS };
      return;
    }
    this.held = [];
    this.itemsSent = 0;
    this.inFlight.push({ throughSeq: this.lastThroughSeq, records: records.length, bytes: this.heldBytes });
    this.heldBytes = 0;
    this.send({ runId: this.buffer.runId, records, throughSeq: this.lastThroughSeq, tick: this.sim.tick, simTimeS: this.sim.simTimeS });
  }

  /** The storage worker reports a batch saved (batches are saved in order). Moves the persisted head and frees the cache. */
  persisted(head: PersistedHead): void {
    if (head.runId !== this.buffer.runId) return;
    if (this.persistedAt && head.tick < this.persistedAt.tick) return;
    while (this.inFlight.length > 0 && (this.inFlight[0] as InFlight).throughSeq <= head.throughSeq) this.inFlight.shift();
    this.buffer.markPersisted(head.throughSeq);
    this.persistedAt = head;
    this.updateWaiting();
  }

  /** Records for the panel stream (≤ 10 Hz) that it has not had yet, profile applied: fed from what the recorder gathered, not from a ring scan. */
  takePanel(): TraceRecord[] {
    const out = this.panel;
    this.panel = [];
    return out;
  }
}
