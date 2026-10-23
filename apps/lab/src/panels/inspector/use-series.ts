import type { StorageClient, StoredMetricSample } from "@agentsim/storage";
import { useEffect, useMemo, useRef, useState } from "react";

/** The most samples a series pane holds (a long run at a high rate has more than a pane can draw: the pane says so). */
export const SERIES_CAP = 50_000;
const PAGE = 5_000;

export interface SeriesLine {
  readonly key: string;
  readonly source: string;
  readonly name: string;
  readonly points: readonly { readonly t: number; readonly v: number }[];
}

export interface SeriesState {
  readonly lines: readonly SeriesLine[];
  readonly samples: number;
  /** More samples exist than the pane holds. */
  readonly capped: boolean;
}

export interface SeriesOptions {
  readonly storage: Pick<StorageClient, "ports" | "live">;
  readonly runId: string | undefined;
  /** A filter with a `metric:` term (the log console's language). */
  readonly filter: string;
  /** A tail: the samples stored from now on are pushed here. */
  readonly tail: boolean;
  readonly viewId: string;
}

const keyOf = (s: Pick<StoredMetricSample, "source" | "name" | "tick">): string => `${s.source}|${s.name}|${s.tick}`;

/**
 * The samples of a metric filter: read from storage (the SQL backend, a page at a time up to a cap) and, for a run that is being recorded, pushed by a live subscription (the
 * live backend). The subscription is registered first and the history read after it, so no sample falls between them; a sample in both is held once (by its series and tick).
 */
export function useSeries(o: SeriesOptions): SeriesState {
  const { storage, runId, filter, tail, viewId } = o;
  const held = useRef(new Map<string, StoredMetricSample>());
  const [version, setVersion] = useState(0);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    held.current = new Map();
    setCapped(false);
    setVersion((v) => v + 1);
    if (runId === undefined) return;
    let closed = false;
    const add = (list: readonly StoredMetricSample[]) => {
      let changed = false;
      for (const s of list) {
        const k = keyOf(s);
        if (held.current.has(k)) continue;
        if (held.current.size >= SERIES_CAP) {
          setCapped(true);
          break;
        }
        held.current.set(k, s);
        changed = true;
      }
      if (changed && !closed) setVersion((v) => v + 1);
    };
    const readHistory = async () => {
      try {
        for (let after: StoredMetricSample | undefined; !closed; ) {
          const page = await storage.ports.metrics.query({ runId, filter, limit: PAGE, ...(after === undefined ? {} : { after: { source: after.source, name: after.name, tick: after.tick } }) });
          add(page);
          if (page.length < PAGE || held.current.size >= SERIES_CAP) return;
          after = page[page.length - 1];
        }
      } catch {
        // a filter the store refuses: nothing to draw
      }
    };
    if (!tail) {
      void readHistory();
      return () => {
        closed = true;
      };
    }
    void storage.live
      .subscribe(viewId, runId, filter, (batch) => add(batch.samples))
      .then(() => readHistory())
      .catch(() => readHistory());
    return () => {
      closed = true;
      void storage.live.unsubscribe(viewId).catch(() => undefined);
    };
  }, [storage, runId, filter, tail, viewId]);

  return useMemo(() => {
    const by = new Map<string, { source: string; name: string; points: { t: number; v: number; tick: number }[] }>();
    for (const s of held.current.values()) {
      const k = `${s.source}|${s.name}`;
      const line = by.get(k) ?? { source: s.source, name: s.name, points: [] };
      line.points.push({ t: s.simTime, v: s.value, tick: s.tick });
      by.set(k, line);
    }
    const lines = [...by.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, l]) => ({ key, source: l.source, name: l.name, points: l.points.sort((a, b) => a.tick - b.tick).map(({ t, v }) => ({ t, v })) }));
    return { lines, samples: held.current.size, capped };
    // `version` is what says the held samples changed
  }, [version, capped]);
}
