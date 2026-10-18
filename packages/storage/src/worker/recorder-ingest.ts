import type { CodedError, Result } from "@agentsim/core";
import type { RecorderBatch, RecorderItem } from "@agentsim/trace";
import type { PersistedHeadMessage, RecorderPortLike } from "./recorder-protocol.ts";

/** A recorder batch as the worker's queue holds it: a `trace.append` of the batch's records, in order with every other request. */
export interface RecorderAppend {
  readonly type: "request";
  /** Not a request of the main thread: no response is sent for it. */
  readonly id: 0;
  readonly op: "trace.append";
  readonly args: readonly [readonly RecorderBatch["records"][number][]];
  readonly recorder: RecorderBatch;
}

/** A snapshot or belief frames from the recorder, as the worker's queue holds them: stored in order with everything else. */
export interface RecorderSide {
  readonly type: "request";
  readonly id: 0;
  readonly op: "recorder.item";
  readonly args: readonly [];
  readonly recorderItem: RecorderItem;
}

export function recorderSide(item: RecorderItem): RecorderSide {
  return { type: "request", id: 0, op: "recorder.item", args: [], recorderItem: item };
}

export function recorderAppend(batch: RecorderBatch): RecorderAppend {
  return { type: "request", id: 0, op: "trace.append", args: [batch.records], recorder: batch };
}

/**
 * After a transaction committed some recorder batches: tells the sim worker (for flow control) and the main thread (for the status line
 * and the timeline) how far the run is saved, and the sim worker if a batch was refused. Batches are judged in order: the persisted head
 * is the last batch before the first refusal, and a refused batch stops the head (a record missing from a run is never papered over).
 */
export function reportCommit(
  items: readonly { readonly batch: RecorderBatch; readonly result: Result<void, CodedError> }[],
  port: Pick<RecorderPortLike, "postMessage"> | undefined,
  toMain: (m: PersistedHeadMessage) => void,
): void {
  let saved: RecorderBatch | undefined;
  for (const { batch, result } of items) {
    if (!result.ok) {
      if (saved) announce(saved);
      port?.postMessage({ type: "rejected", runId: batch.runId, code: result.error.code, message: result.error.message });
      return;
    }
    saved = batch;
  }
  if (saved) announce(saved);

  function announce(b: RecorderBatch): void {
    const head = { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS };
    port?.postMessage({ type: "persisted", head });
    toMain({ type: "persisted", head });
  }
}
