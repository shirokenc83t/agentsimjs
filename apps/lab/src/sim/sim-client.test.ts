import type { SimToMain } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { SimClient } from "./sim-client.ts";

/** A worker stand-in: records what the client posts and lets the test deliver worker messages. */
function fakeWorker() {
  const listeners: ((ev: MessageEvent<SimToMain>) => void)[] = [];
  const posted: unknown[] = [];
  const worker = {
    addEventListener: (type: string, l: (ev: MessageEvent<SimToMain>) => void) => {
      if (type === "message") listeners.push(l);
    },
    postMessage: (m: unknown) => posted.push(m),
    terminate: () => undefined,
  };
  const deliver = (m: SimToMain) => {
    for (const l of listeners) l({ data: m } as MessageEvent<SimToMain>);
  };
  return { worker: worker as unknown as Worker, deliver, posted };
}

describe("SimClient: planning preparation (ADR-0024)", () => {
  it("shows progress while the worker prepares, then keeps what was built and its wall time", () => {
    const { worker, deliver } = fakeWorker();
    const c = new SimClient(worker, 10);
    expect(c.snapshot().preparing).toBeUndefined();
    deliver({ type: "preparing", runId: "run-000001", done: 0, total: 2 });
    expect(c.snapshot().preparing).toEqual({ runId: "run-000001", done: 0, total: 2 });
    deliver({ type: "preparing", runId: "run-000001", done: 1, total: 2 });
    expect(c.snapshot().preparing).toEqual({ runId: "run-000001", done: 1, total: 2 });
    deliver({ type: "prepared", runId: "run-000001", views: 2, graphs: 1, ms: 1650 });
    expect(c.snapshot().preparing).toBeUndefined();
    expect(c.snapshot().prepared).toEqual({ runId: "run-000001", views: 2, graphs: 1, ms: 1650 });
  });

  it("a failed load clears the progress", () => {
    const { worker, deliver } = fakeWorker();
    const c = new SimClient(worker, 10);
    deliver({ type: "preparing", runId: "run-000001", done: 0, total: 2 });
    deliver({ type: "error", code: "budget_out_of_range", message: "x" });
    expect(c.snapshot().preparing).toBeUndefined();
  });
});

describe("SimClient: the strategy sandbox request (F2b M4)", () => {
  it("posts one request with its own id and resolves the promise with the answer for that id only", async () => {
    const { worker, deliver, posted } = fakeWorker();
    const c = new SimClient(worker, 10);
    const a = c.strategyTest({ agentId: "ugv-001", to: { xM: 1, yM: 2 }, planOn: "belief" });
    const b = c.strategyTest({ agentId: "ugv-002", to: { xM: 3, yM: 4 }, planOn: "truth", strategy: { ref: "astar-only", version: 1 } });
    const [pa, pb] = posted.filter((m) => (m as { type: string }).type === "strategyTest") as { requestId: number; agentId: string }[];
    expect(pa?.requestId).not.toBe(pb?.requestId);
    deliver({ type: "strategyTestResult", requestId: pb?.requestId ?? -1, ok: false, error: { code: "unknown_agent", message: "x" } });
    expect(await b).toMatchObject({ ok: false, error: { code: "unknown_agent" } });
    deliver({ type: "strategyTestResult", requestId: pa?.requestId ?? -1, ok: true, result: { map: "belief" } });
    expect(await a).toMatchObject({ ok: true });
  });
});
