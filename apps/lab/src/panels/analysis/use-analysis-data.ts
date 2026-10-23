import { poseWindowQuery, type StorageClient, type StoredMetricSample } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useState } from "react";
import { trajectoriesOf, type Trajectory } from "./analysis-model.ts";

/** What the Analysis workspace holds of a run: more than this and it says so (the exports read the storage again, whole). */
export const ANALYSIS_CAPS = { poses: 400_000, events: 200_000, compute: 100_000, metrics: 400_000 } as const;
const PAGE = 10_000;

export interface RunData {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error?: string;
  readonly trajectories: ReadonlyMap<string, Trajectory>;
  /** Action starts and ends, reflexes, injected commands and degradations: the events of the map and the timeline. */
  readonly events: readonly TraceRecord[];
  readonly compute: readonly TraceRecord[];
  readonly metrics: readonly StoredMetricSample[];
  /** A kind of data had more than the cap: what is drawn is its first part. */
  readonly capped: readonly string[];
  /** Pose samples and events read (a progress while it loads). */
  readonly counts: { readonly poses: number; readonly events: number };
}

const EMPTY: RunData = { status: "idle", trajectories: new Map(), events: [], compute: [], metrics: [], capped: [], counts: { poses: 0, events: 0 } };

async function readAll<T extends { seq: number }>(page: (after: number | undefined) => Promise<readonly T[]>, cap: number): Promise<{ list: T[]; capped: boolean }> {
  const list: T[] = [];
  for (let after: number | undefined; ; ) {
    const got = await page(after);
    list.push(...got);
    if (list.length >= cap) return { list: list.slice(0, cap), capped: got.length === PAGE };
    if (got.length < PAGE) return { list, capped: false };
    after = (got[got.length - 1] as T).seq;
  }
}

/**
 * Reads a recorded run for analysis through the storage ports (paged queries in the storage worker; nothing is simulated): the pose samples, the events of the map, the
 * `compute` records of the planner and the metrics of the battery and the speed. `reload` reads again (a run that is still being recorded has grown).
 */
export function useRunData(storage: Pick<StorageClient, "ports">, runId: string | undefined): RunData & { readonly reload: () => void } {
  const [data, setData] = useState<RunData>(EMPTY);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (runId === undefined) {
      setData(EMPTY);
      return;
    }
    let closed = false;
    setData((d) => ({ ...EMPTY, status: "loading", counts: d.counts }));
    void (async () => {
      try {
        const poses = await readAll((after) => storage.ports.trace.query({ ...poseWindowQuery({ runId, from: 0, to: Number.MAX_SAFE_INTEGER, limit: PAGE, ...(after === undefined ? {} : { afterSeq: after }) }), source: { include: [{ owner: null, component: "body" }] } }), ANALYSIS_CAPS.poses);
        if (closed) return;
        const events = await readAll((after) => storage.ports.trace.query({ runId, kinds: ["action", "reflex", "injected", "degradation"], limit: PAGE, ...(after === undefined ? {} : { afterSeq: after }) }), ANALYSIS_CAPS.events);
        if (closed) return;
        const compute = await readAll((after) => storage.ports.trace.query({ runId, kinds: ["compute"], op: "plan", limit: PAGE, ...(after === undefined ? {} : { afterSeq: after }) }), ANALYSIS_CAPS.compute);
        if (closed) return;
        const metrics: StoredMetricSample[] = [];
        let metricsCapped = false;
        for (let after: StoredMetricSample | undefined; ; ) {
          const got = await storage.ports.metrics.query({ runId, filter: "metric:agent.soc,agent.speedMps", limit: PAGE, ...(after === undefined ? {} : { after: { source: after.source, name: after.name, tick: after.tick } }) });
          metrics.push(...got);
          if (got.length < PAGE) break;
          if (metrics.length >= ANALYSIS_CAPS.metrics) {
            metricsCapped = true;
            break;
          }
          after = got[got.length - 1];
        }
        if (closed) return;
        setData({
          status: "ready",
          trajectories: trajectoriesOf(poses.list),
          events: events.list,
          compute: compute.list,
          metrics,
          capped: [...(poses.capped ? ["pose samples"] : []), ...(events.capped ? ["events"] : []), ...(compute.capped ? ["planner records"] : []), ...(metricsCapped ? ["metrics"] : [])],
          counts: { poses: poses.list.length, events: events.list.length },
        });
      } catch (e) {
        if (!closed) setData({ ...EMPTY, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      closed = true;
    };
  }, [storage, runId, version]);
  return { ...data, reload };
}
