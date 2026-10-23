import type { StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useRef, useState } from "react";

/** Records read from storage a page at a time. */
export const LOG_PAGE = 200;

/** What a live tail says of itself: how many records matched the filter, how many the display shows (less when it sampled), and whether it ever had to. */
export interface TailStats {
  readonly matched: number;
  readonly shown: number;
  readonly sampled: boolean;
}

export interface LogRows {
  readonly rows: readonly TraceRecord[];
  /** True while storage has more of the result than the rows read so far. */
  readonly more: boolean;
  /** Records that arrived while the tail was paused (the list was not at its end): they are not in `rows` yet. */
  readonly pending: number;
  /** The live tail's counts, or undefined when there is no tail. */
  readonly tail: TailStats | undefined;
  /** Reads the next page of the result. */
  loadMore(): void;
  /** Takes the records that arrived while paused into the rows. */
  flush(): void;
}

export interface LogRowsOptions {
  readonly storage: Pick<StorageClient, "ports" | "live">;
  readonly runId: string | undefined;
  /** A filter that parsed (the console never queries with one that did not). */
  readonly filter: string;
  /** The end of what is stored, in sim seconds: a history that is not a tail is read up to it. */
  readonly headS: number;
  /** A tail: the run is being recorded, and the records that are stored from now on are pushed here. */
  readonly tail: boolean;
  /** The list is not at its end (the researcher scrolled up): what arrives waits, counted, until the list is back at its end. */
  readonly paused: boolean;
  /** A name for this list's subscription, unique among the lists that are open. */
  readonly viewId: string;
}

/**
 * The rows of a log list: the result of a filter read from storage a page at a time (the SQL backend), and, for a run that is being recorded, a tail: the records stored
 * from now on pushed by a live subscription (the same filter, the live backend).
 *
 * A tail has no hole by construction. It subscribes first, and reads the history only once the subscription is registered, with no upper bound: everything committed
 * before the subscription is in the history, everything committed after it is pushed. Pushes that arrive before the history reaches its end are kept, and joined to it
 * at the end (a record in both is in the rows once: only what is after the last row is added). A history that is not a tail (a recording) is read up to its head.
 */
export function useLogRows(o: LogRowsOptions): LogRows {
  const { storage, runId, filter, headS, tail: wantTail, paused, viewId } = o;
  const [rows, setRows] = useState<readonly TraceRecord[]>([]);
  const [more, setMore] = useState(true);
  const [pending, setPending] = useState(0);
  const [tail, setTail] = useState<TailStats | undefined>(undefined);
  /** The subscription is registered (or there is none to wait for): the history may be read. */
  const [ready, setReady] = useState(!wantTail);
  /** The tail's pushes work: false when the subscription was refused, and the list then follows by reading as the head moves. */
  const [pushing, setPushing] = useState(wantTail);
  const have = useRef<TraceRecord[]>([]);
  /** Pushes that came before the history reached its end. */
  const early = useRef<TraceRecord[]>([]);
  /** Pushes that came while the list was not at its end. */
  const waiting = useRef<TraceRecord[]>([]);
  const loading = useRef(false);
  const generation = useRef(0);
  const complete = useRef(false);
  /** The display sampled at some point of this tail: the counts say so from then on. */
  const sampledEver = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const lastSeq = () => (have.current.length > 0 ? (have.current[have.current.length - 1] as TraceRecord).seq : -1);
  const append = useCallback((list: readonly TraceRecord[]) => {
    const fresh = list.filter((r) => r.seq > lastSeq());
    if (fresh.length === 0) return;
    have.current = [...have.current, ...fresh];
    setRows(have.current);
  }, []);

  /** The head of storage now, and the head the last finished read went up to (a history that is not a tail). */
  const headRef = useRef(headS);
  headRef.current = headS;
  const readThrough = useRef(-1);
  /** Something asked for a read while one was running: it must run again, with what the head is by then. */
  const again = useRef(false);
  const tailing = wantTail && pushing;
  const tailingRef = useRef(tailing);
  tailingRef.current = tailing;

  /**
   * Reads the result from storage after the last row. A tail reads on to the end by itself (no upper bound); a history reads a page when the list asks, up to the head. A read
   * asked for while one is running is not lost: it runs again once the first is done (for a history, to the head as it is by then).
   */
  const pump = useCallback(async () => {
    if (runId === undefined) return;
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    const mine = generation.current;
    try {
      for (;;) {
        again.current = false;
        const to = headRef.current;
        const page = await storage.ports.trace.query({ runId, afterSeq: lastSeq(), limit: LOG_PAGE, ...(tailingRef.current ? {} : { simTime: { to } }), ...(filter === "" ? {} : { filter }) });
        if (mine !== generation.current) return;
        const fresh = page.filter((r) => r.seq > lastSeq());
        if (fresh.length > 0) {
          have.current = [...have.current, ...fresh];
          setRows(have.current);
        }
        const full = page.length === LOG_PAGE;
        complete.current = !full;
        setMore(full);
        if (!full) {
          readThrough.current = to;
          // The history has reached its end: what was pushed meanwhile is joined to it.
          if (tailingRef.current && early.current.length > 0) {
            const joined = early.current;
            early.current = [];
            append(joined);
          }
        }
        const newer = !full && !tailingRef.current && (again.current || headRef.current > to);
        if (!newer && !(full && tailingRef.current)) break;
      }
    } catch {
      if (mine === generation.current) {
        complete.current = true;
        setMore(false);
      }
    } finally {
      loading.current = false;
    }
  }, [storage, runId, filter, append]);

  // A new run or a new filter starts the list again.
  useEffect(() => {
    generation.current++;
    loading.current = false;
    again.current = false;
    readThrough.current = -1;
    complete.current = false;
    have.current = [];
    early.current = [];
    waiting.current = [];
    sampledEver.current = false;
    setRows([]);
    setPending(0);
    setTail(undefined);
    setMore(true);
  }, [runId, filter]);

  // The live tail: the same filter, pushed. It is registered before the history is read.
  useEffect(() => {
    if (!wantTail || runId === undefined) {
      setReady(true);
      return;
    }
    let closed = false;
    setReady(false);
    setPushing(true);
    void storage.live
      .subscribe(viewId, runId, filter, (batch) => {
        if (closed) return;
        if (batch.sampled) sampledEver.current = true;
        setTail({ matched: batch.totalMatched, shown: batch.totalShown, sampled: sampledEver.current });
        if (!complete.current) {
          early.current = [...early.current, ...batch.records];
          return;
        }
        if (pausedRef.current) {
          waiting.current = [...waiting.current, ...batch.records.filter((r) => r.seq > lastSeq())];
          setPending(waiting.current.length);
        } else append(batch.records);
      })
      .then((r) => {
        if (closed) return;
        if (!r.ok) setPushing(false); // no tail: the list reads as the head moves
        setReady(true);
      })
      .catch(() => {
        if (closed) return;
        setPushing(false);
        setReady(true);
      });
    return () => {
      closed = true;
      void storage.live.unsubscribe(viewId).catch(() => undefined);
    };
  }, [wantTail, storage, runId, filter, viewId, append]);

  // The first read, once the subscription (if any) is registered.
  useEffect(() => {
    if (ready && have.current.length === 0 && more && runId !== undefined) void pump();
  }, [ready, rows, more, pump, runId]);
  // A history that is not a tail: a head that moved gives a list that had reached the end more to read, without a page to wait for.
  useEffect(() => {
    if (!tailing && ready && headS > readThrough.current && complete.current) void pump();
  }, [headS, pump, tailing, ready]);

  const flush = useCallback(() => {
    const list = waiting.current;
    waiting.current = [];
    setPending(0);
    append(list);
  }, [append]);
  // Back at the end of the list: what waited is taken.
  useEffect(() => {
    if (!paused && waiting.current.length > 0) flush();
  }, [paused, flush]);

  return { rows, more, pending, tail: wantTail && pushing ? tail : undefined, loadMore: () => void pump(), flush };
}
