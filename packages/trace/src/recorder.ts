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

export interface RunRecorderOptions {
  readonly buffer: TraceBuffer;
  readonly profile: RecordingProfile;
  /** Hands a batch to the storage worker. Called once per `collect` that has something to say. */
  readonly send: (batch: RecorderBatch) => void;
}

interface InFlight {
  readonly throughSeq: number;
  readonly records: number;
}

export class RunRecorder {
  private readonly buffer: TraceBuffer;
  private readonly profile: RecordingProfile;
  private readonly send: (batch: RecorderBatch) => void;
  private cursor = 0;
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
    return this.inFlight.reduce((n, b) => n + b.records, 0) + this.held.length;
  }

  /** The storage worker has the run header: what was gathered before goes out now, in one batch. */
  headerStored(): void {
    if (this.header) return;
    this.header = true;
    this.flush();
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
          this.panel.push(safe);
        }
      }
    }
    if (this.header) this.flush();
  }

  private flush(): void {
    const records = this.held;
    // Nothing new and nothing waiting to be saved: everything up to this tick is saved already.
    if (records.length === 0 && this.inFlight.length === 0) {
      if (this.persistedAt) this.persistedAt = { ...this.persistedAt, tick: this.sim.tick, simTimeS: this.sim.simTimeS };
      return;
    }
    this.held = [];
    this.inFlight.push({ throughSeq: this.lastThroughSeq, records: records.length });
    this.send({ runId: this.buffer.runId, records, throughSeq: this.lastThroughSeq, tick: this.sim.tick, simTimeS: this.sim.simTimeS });
  }

  /** The storage worker reports a batch saved (batches are saved in order). Moves the persisted head and frees the cache. */
  persisted(head: PersistedHead): void {
    if (head.runId !== this.buffer.runId) return;
    if (this.persistedAt && head.tick < this.persistedAt.tick) return;
    while (this.inFlight.length > 0 && (this.inFlight[0] as InFlight).throughSeq <= head.throughSeq) this.inFlight.shift();
    this.buffer.markPersisted(head.throughSeq);
    this.persistedAt = head;
  }

  /** Records for the panel stream (≤ 10 Hz) that it has not had yet, profile applied: fed from what the recorder gathered, not from a ring scan. */
  takePanel(): TraceRecord[] {
    const out = this.panel;
    this.panel = [];
    return out;
  }
}
