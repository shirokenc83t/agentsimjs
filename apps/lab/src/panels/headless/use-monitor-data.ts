import type { StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useEffect, useRef, useState } from "react";

/** The rows the monitor's event stream keeps. */
export const STREAM_ROWS = 40;

export interface SampledStream {
  readonly rows: readonly TraceRecord[];
  readonly totalMatched: number;
  readonly totalShown: number;
  readonly sampled: boolean;
}

const EMPTY: SampledStream = { rows: [], totalMatched: 0, totalShown: 0, sampled: false };

/**
 * The monitor's event stream: a live subscription (ADR-0035 section 5: the storage worker offers what it stores, at most 10 batches a second and 2,000 records a batch, sampling
 * when there are more and saying so) to the run's records without the pose samples. It keeps the latest rows; what it says of its sampling comes from the subscription's counters.
 */
export function useSampledStream(storage: Pick<StorageClient, "live">, runId: string | undefined, viewId: string): SampledStream {
  const [state, setState] = useState<SampledStream>(EMPTY);
  const rows = useRef<TraceRecord[]>([]);
  useEffect(() => {
    rows.current = [];
    setState(EMPTY);
    if (runId === undefined) return;
    let closed = false;
    void storage.live
      .subscribe(viewId, runId, "-kind:observation", (batch) => {
        if (closed) return;
        rows.current = [...rows.current, ...batch.records].slice(-STREAM_ROWS);
        setState((s) => ({ rows: rows.current, totalMatched: batch.totalMatched, totalShown: batch.totalShown, sampled: s.sampled || batch.sampled }));
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      void storage.live.unsubscribe(viewId).catch(() => undefined);
    };
  }, [storage, runId, viewId]);
  return state;
}

/** What the run has stored so far, in bytes (its kinds summed), read every `everyMs` while `active` and once more when it stops being active. */
export function useStoredBytes(storage: Pick<StorageClient, "ports">, runId: string | undefined, active: boolean, everyMs = 2000): number | undefined {
  const [bytes, setBytes] = useState<number | undefined>(undefined);
  useEffect(() => {
    setBytes(undefined);
    if (runId === undefined) return;
    let closed = false;
    const read = () =>
      void storage.ports.runs.sizes(runId).then(
        (s) => !closed && s && setBytes(s.records.bytes + s.metrics.bytes + s.blobs.bytes + s.snapshots.bytes + s.beliefFrames.bytes),
        () => undefined,
      );
    read();
    if (!active) return () => void (closed = true);
    const id = setInterval(read, everyMs);
    return () => {
      closed = true;
      clearInterval(id);
    };
  }, [storage, runId, active, everyMs]);
  return bytes;
}
