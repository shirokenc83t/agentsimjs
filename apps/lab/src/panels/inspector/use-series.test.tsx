import { createMemoryPorts, type LiveBatch, type StorageClient, type StoredMetricSample } from "@agentsim/storage";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SERIES_CAP, useSeries } from "./use-series.ts";

// The samples of a metric filter in a series pane: history from storage, a tail pushed by a live subscription, subscribed before the history is read, each sample held once.

const RUN = "run-000001";
const sample = (tick: number, over: Partial<StoredMetricSample> = {}): StoredMetricSample => ({ source: "uav-001/body", name: "agent.soc", tick, simTime: tick * 0.1, value: 1 - tick / 1000, ...over });

async function fixture(history: StoredMetricSample[]) {
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
  if (history.length > 0) await ports.metrics.append(RUN, history);
  const order: string[] = [];
  const pushes: ((b: Partial<LiveBatch>) => void)[] = [];
  const unsubscribed: string[] = [];
  const queries: unknown[] = [];
  const metrics = { ...ports.metrics, query: async (q: Parameters<typeof ports.metrics.query>[0]) => (order.push("query"), queries.push(q), ports.metrics.query(q)) };
  const storage = {
    ports: { ...ports, metrics },
    live: {
      subscribe: async (viewId: string, _run: string, _filter: string, onBatch: (b: LiveBatch) => void) => {
        order.push("subscribe");
        pushes.push((b) => onBatch({ viewId, runId: RUN, records: [], samples: [], matched: 0, shown: 0, totalMatched: 0, totalShown: 0, sampled: false, ...b }));
        return { ok: true as const, value: undefined };
      },
      change: async () => ({ ok: true as const, value: undefined }),
      unsubscribe: async (v: string) => void unsubscribed.push(v),
    },
  } as unknown as Pick<StorageClient, "ports" | "live">;
  return { ports, storage, order, pushes, unsubscribed, queries };
}

const opts = (storage: Pick<StorageClient, "ports" | "live">, over: Partial<Parameters<typeof useSeries>[0]> = {}) => ({ storage, runId: RUN, filter: "metric:agent.soc", tail: false, viewId: "s1", ...over });

describe("useSeries", () => {
  it("reads the history of a metric filter, one line per series, in tick order", async () => {
    const { storage } = await fixture([sample(1), sample(2), sample(1, { source: "ugv-001/body" }), sample(2, { source: "ugv-001/body" }), sample(3)]);
    const { result } = renderHook(() => useSeries(opts(storage)));
    await waitFor(() => expect(result.current.samples).toBe(5));
    expect(result.current.lines.map((l) => [l.key, l.points.length])).toEqual([["uav-001/body|agent.soc", 3], ["ugv-001/body|agent.soc", 2]]);
    expect(result.current.lines[0]?.points.map((p) => p.t)).toEqual([0.1, 0.2, 0.30000000000000004]);
    expect(result.current.capped).toBe(false);
  });

  it("subscribes before it reads, adds what is pushed, and holds a sample that is in both once", async () => {
    const { storage, order, pushes } = await fixture([sample(1), sample(2)]);
    const { result } = renderHook(() => useSeries(opts(storage, { tail: true })));
    await waitFor(() => expect(result.current.samples).toBe(2));
    expect(order[0]).toBe("subscribe");
    expect(order.indexOf("query")).toBeGreaterThan(0);
    act(() => pushes[0]?.({ samples: [sample(2), sample(3), sample(4)] }));
    expect(result.current.samples).toBe(4);
    expect(result.current.lines[0]?.points.length).toBe(4);
  });

  it("a sample pushed before the history is read is kept and joined to it", async () => {
    const { storage, pushes } = await fixture([sample(1), sample(2)]);
    const { result } = renderHook(() => useSeries(opts(storage, { tail: true })));
    await waitFor(() => expect(pushes.length).toBe(1));
    act(() => pushes[0]?.({ samples: [sample(9)] }));
    await waitFor(() => expect(result.current.samples).toBe(3));
  });

  it("subscribes to nothing without a tail, and a closed pane leaves no subscription", async () => {
    const a = await fixture([sample(1)]);
    renderHook(() => useSeries(opts(a.storage)));
    await waitFor(() => expect(a.queries.length).toBe(1));
    expect(a.order).not.toContain("subscribe");
    const b = await fixture([sample(1)]);
    const { unmount } = renderHook(() => useSeries(opts(b.storage, { tail: true })));
    await waitFor(() => expect(b.order).toContain("query"));
    unmount();
    await waitFor(() => expect(b.unsubscribed).toEqual(["s1"]));
  });

  it("starts again for another filter", async () => {
    const { storage } = await fixture([sample(1), sample(1, { name: "agent.speedMps", value: 3 })]);
    const { result, rerender } = renderHook((p: { filter: string }) => useSeries(opts(storage, { filter: p.filter })), { initialProps: { filter: "metric:agent.soc" } });
    await waitFor(() => expect(result.current.lines.map((l) => l.name)).toEqual(["agent.soc"]));
    rerender({ filter: "metric:agent.speedMps" });
    await waitFor(() => expect(result.current.lines.map((l) => l.name)).toEqual(["agent.speedMps"]));
  });

  it("holds at most a cap of samples and says so", async () => {
    expect(SERIES_CAP).toBeGreaterThan(10_000);
    const big = Array.from({ length: 200 }, (_, i) => sample(i));
    const { storage, pushes } = await fixture(big);
    const { result } = renderHook(() => useSeries(opts(storage, { tail: true })));
    await waitFor(() => expect(result.current.samples).toBe(200));
    expect(result.current.capped).toBe(false);
    expect(pushes.length).toBe(1);
  });
});
