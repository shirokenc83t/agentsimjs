import { createMemoryPorts, type LiveBatch, type StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOG_PAGE, useLogRows } from "./use-log-rows.ts";

// The rows of a log list (UI-SPEC section 5.1): history read with the filter, a tail pushed by a live subscription, paused when the list is not at its end.

const RUN = "run-000001";
const rec = (seq: number, over: Partial<TraceRecord> = {}): TraceRecord => ({ id: `${RUN}#${seq}`, runId: RUN, seq, simTime: seq * 0.1, wallTime: 1, source: "uav-001/actions", kind: "action", agentId: "uav-001", payload: { op: "start", seq }, ...over });

async function fixture(history: TraceRecord[]) {
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
  if (history.length > 0) await ports.trace.append(history);
  const subscribed: { viewId: string; filter: string; push: (b: Partial<LiveBatch>) => void }[] = [];
  const unsubscribed: string[] = [];
  const storage = {
    ports,
    live: {
      subscribe: async (viewId: string, _run: string, filter: string, onBatch: (b: LiveBatch) => void) => {
        subscribed.push({ viewId, filter, push: (b) => onBatch({ viewId, runId: RUN, records: [], samples: [], matched: 0, shown: 0, totalMatched: 0, totalShown: 0, sampled: false, ...b }) });
        return { ok: true as const, value: undefined };
      },
      change: async () => ({ ok: true as const, value: undefined }),
      unsubscribe: async (viewId: string) => void unsubscribed.push(viewId),
    },
  } as unknown as Pick<StorageClient, "ports" | "live">;
  return { ports, storage, subscribed, unsubscribed };
}

const opts = (storage: Pick<StorageClient, "ports" | "live">, over: Partial<Parameters<typeof useLogRows>[0]> = {}) => ({ storage, runId: RUN, filter: "", headS: 100, tail: false, paused: false, viewId: "log-test", ...over });

describe("useLogRows: history", () => {
  it("reads the result of a filter from storage a page at a time, in seq order", async () => {
    const history = Array.from({ length: LOG_PAGE * 2 + 50 }, (_, i) => rec(i, { kind: i % 2 === 0 ? "action" : "event", simTime: i * 0.01 })); // 225 actions: a page and a bit
    const { storage } = await fixture(history);
    const { result } = renderHook(() => useLogRows(opts(storage, { filter: "kind:action" })));
    await waitFor(() => expect(result.current.rows.length).toBe(LOG_PAGE));
    expect(result.current.more).toBe(true);
    expect(result.current.rows.every((r) => r.kind === "action")).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.more).toBe(false));
    expect(result.current.rows.map((r) => r.seq)).toEqual(history.filter((r) => r.kind === "action").map((r) => r.seq));
  });

  it("starts again when the filter changes", async () => {
    const { storage } = await fixture([rec(0), rec(1, { kind: "event" }), rec(2)]);
    const { result, rerender } = renderHook((p: { filter: string }) => useLogRows(opts(storage, { filter: p.filter })), { initialProps: { filter: "kind:action" } });
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([0, 2]));
    rerender({ filter: "kind:event" });
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([1]));
  });
});

describe("useLogRows: the live tail", () => {
  it("subscribes with the same filter, appends what is pushed once the history has reached the end, and never repeats a record", async () => {
    const { storage, subscribed } = await fixture([rec(0), rec(1)]);
    const { result } = renderHook(() => useLogRows(opts(storage, { filter: "kind:action", tail: true })));
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([0, 1]));
    await waitFor(() => expect(subscribed.length).toBe(1));
    expect(subscribed[0]?.filter).toBe("kind:action");
    act(() => subscribed[0]?.push({ records: [rec(1), rec(2), rec(3)], matched: 3, shown: 3, totalMatched: 3, totalShown: 3 })); // 1 is already there
    expect(result.current.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(result.current.tail).toEqual({ matched: 3, shown: 3, sampled: false });
  });

  it("reads its history to the end by itself, then appends what is pushed; a push that comes before the end is left to the read", async () => {
    const history = Array.from({ length: LOG_PAGE + 10 }, (_, i) => rec(i, { simTime: i * 0.01 }));
    const { storage, subscribed } = await fixture(history);
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: true })));
    await waitFor(() => expect(subscribed.length).toBe(1));
    await waitFor(() => expect(result.current.rows.length).toBe(LOG_PAGE + 10)); // no scrolling needed: a tail goes to the end
    expect(result.current.more).toBe(false);
    act(() => subscribed[0]?.push({ records: [rec(LOG_PAGE + 10)] }));
    expect(result.current.rows.length).toBe(LOG_PAGE + 11);
  });

  it("keeps what is pushed before the history reaches its end and joins it there: a record stored after the history was read is not lost, and none is repeated", async () => {
    const history = Array.from({ length: LOG_PAGE + 10 }, (_, i) => rec(i, { simTime: i * 0.01 }));
    const { storage, subscribed } = await fixture(history);
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: true })));
    await waitFor(() => expect(subscribed.length).toBe(1));
    // The subscription is registered and the history is being read: records stored after it are pushed, whenever they come.
    act(() => subscribed[0]?.push({ records: [rec(LOG_PAGE + 5), rec(LOG_PAGE + 10), rec(LOG_PAGE + 11), rec(LOG_PAGE + 12)] })); // two of them are in the history too
    await waitFor(() => expect(result.current.rows.length).toBe(LOG_PAGE + 13));
    expect(result.current.rows.map((r) => r.seq)).toEqual(Array.from({ length: LOG_PAGE + 13 }, (_, i) => i));
  });

  it("the history of a tail is read only once the subscription is registered, and without an upper bound on time", async () => {
    const ports = createMemoryPorts();
    await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
    await ports.trace.append([rec(0, { simTime: 500 })]); // far beyond the head the console was told of
    const order: string[] = [];
    const queries: unknown[] = [];
    const trace = { ...ports.trace, query: async (q: Parameters<typeof ports.trace.query>[0]) => (order.push("query"), queries.push(q), ports.trace.query(q)) };
    const storage = {
      ports: { ...ports, trace },
      live: { subscribe: async () => (order.push("subscribe"), { ok: true as const, value: undefined }), unsubscribe: async () => undefined, change: async () => ({ ok: true as const, value: undefined }) },
    } as unknown as Pick<StorageClient, "ports" | "live">;
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: true, headS: 1 })));
    await waitFor(() => expect(result.current.rows.length).toBe(1));
    expect(order[0]).toBe("subscribe");
    expect((queries[0] as { simTime?: unknown }).simTime).toBeUndefined();
  });

  it("a refused subscription is no tail: the list reads as the head moves instead", async () => {
    const ports = createMemoryPorts();
    await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
    await ports.trace.append([rec(0, { simTime: 1 })]);
    const storage = { ports, live: { subscribe: async () => ({ ok: false as const, error: { code: "too_many_subscriptions", message: "no" } }), unsubscribe: async () => undefined, change: async () => ({ ok: true as const, value: undefined }) } } as unknown as Pick<StorageClient, "ports" | "live">;
    const { result, rerender } = renderHook((p: { headS: number }) => useLogRows(opts(storage, { tail: true, headS: p.headS })), { initialProps: { headS: 1 } });
    await waitFor(() => expect(result.current.rows.length).toBe(1));
    expect(result.current.tail).toBeUndefined();
    await ports.trace.append([rec(1, { simTime: 2 })]);
    rerender({ headS: 2 });
    await waitFor(() => expect(result.current.rows.length).toBe(2));
  });

  it("a head that moves while a read is running is read next, not forgotten: no record stored after the first read's head is missing", async () => {
    const ports = createMemoryPorts();
    await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
    await ports.trace.append([rec(0, { simTime: 1 }), rec(1, { simTime: 2 })]);
    // The first query is held until the test lets it go, as a slow storage worker would.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const trace = { ...ports.trace, query: async (q: Parameters<typeof ports.trace.query>[0]) => ((calls++ === 0 ? await held : undefined), ports.trace.query(q)) };
    const storage = { ports: { ...ports, trace }, live: { subscribe: async () => ({ ok: true as const, value: undefined }), unsubscribe: async () => undefined, change: async () => ({ ok: true as const, value: undefined }) } } as unknown as Pick<StorageClient, "ports" | "live">;
    const { result, rerender } = renderHook((p: { headS: number }) => useLogRows(opts(storage, { tail: false, headS: p.headS })), { initialProps: { headS: 2 } });
    await waitFor(() => expect(calls).toBe(1));
    // While that read is running, more is stored and the head moves: nothing can be read for it yet.
    await ports.trace.append([rec(2, { simTime: 3 }), rec(3, { simTime: 4 })]);
    rerender({ headS: 4 });
    release();
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("pauses while the list is not at its end: what arrives is counted, and taken when the list is back at its end", async () => {
    const { storage, subscribed } = await fixture([rec(0)]);
    const { result, rerender } = renderHook((p: { paused: boolean }) => useLogRows(opts(storage, { tail: true, paused: p.paused })), { initialProps: { paused: false } });
    await waitFor(() => expect(result.current.rows.length).toBe(1));
    await waitFor(() => expect(subscribed.length).toBe(1));
    rerender({ paused: true });
    act(() => subscribed[0]?.push({ records: [rec(1), rec(2)] }));
    expect(result.current.rows.map((r) => r.seq)).toEqual([0]);
    expect(result.current.pending).toBe(2);
    act(() => subscribed[0]?.push({ records: [rec(3)] }));
    expect(result.current.pending).toBe(3);
    rerender({ paused: false });
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]));
    expect(result.current.pending).toBe(0);
  });

  it("flush takes what waited at once, in order", async () => {
    const { storage, subscribed } = await fixture([]);
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: true, paused: true })));
    await waitFor(() => expect(subscribed.length).toBe(1));
    await waitFor(() => expect(result.current.more).toBe(false));
    act(() => subscribed[0]?.push({ records: [rec(5), rec(6)] }));
    expect(result.current.pending).toBe(2);
    act(() => result.current.flush());
    expect(result.current.rows.map((r) => r.seq)).toEqual([5, 6]);
  });

  it("says shown / recorded when the display sampled, and keeps saying it", async () => {
    const { storage, subscribed } = await fixture([]);
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: true })));
    await waitFor(() => expect(subscribed.length).toBe(1));
    await waitFor(() => expect(result.current.more).toBe(false));
    act(() => subscribed[0]?.push({ records: [rec(0), rec(1)], matched: 10, shown: 2, totalMatched: 10, totalShown: 2, sampled: true }));
    expect(result.current.tail).toEqual({ matched: 10, shown: 2, sampled: true });
    act(() => subscribed[0]?.push({ records: [rec(20)], matched: 1, shown: 1, totalMatched: 11, totalShown: 3, sampled: false }));
    expect(result.current.tail).toEqual({ matched: 11, shown: 3, sampled: true });
  });

  it("a closed list leaves no subscription behind, and a new filter replaces the subscription", async () => {
    const { storage, subscribed, unsubscribed } = await fixture([]);
    const { rerender, unmount } = renderHook((p: { filter: string }) => useLogRows(opts(storage, { tail: true, filter: p.filter })), { initialProps: { filter: "kind:action" } });
    await waitFor(() => expect(subscribed.length).toBe(1));
    rerender({ filter: "kind:event" });
    await waitFor(() => expect(subscribed.length).toBe(2));
    expect(subscribed.map((s) => s.filter)).toEqual(["kind:action", "kind:event"]);
    expect(unsubscribed).toEqual(["log-test"]);
    unmount();
    await waitFor(() => expect(unsubscribed).toEqual(["log-test", "log-test"]));
  });

  it("no tail without a run being recorded: nothing is subscribed", async () => {
    const { storage, subscribed } = await fixture([rec(0)]);
    const { result } = renderHook(() => useLogRows(opts(storage, { tail: false })));
    await waitFor(() => expect(result.current.rows.length).toBe(1));
    expect(subscribed).toEqual([]);
    expect(result.current.tail).toBeUndefined();
  });
});
