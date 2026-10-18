import type { SimLoadedMessage, SimToMain } from "@agentsim/core";
import type { PersistedHeadMessage, QuotaMessage } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { ChunkQueue } from "@agentsim/ui";
import { describe, expect, it } from "vitest";
import { LiveRunSource } from "./live-run-source.ts";
import { filterRecords, latestPlans } from "./run-source.ts";
import { SimClient } from "./sim-client.ts";

function fakeWorker() {
  const listeners: ((ev: MessageEvent<SimToMain>) => void)[] = [];
  const posted: { type?: string; [k: string]: unknown }[] = [];
  const worker = {
    addEventListener: (type: string, l: (ev: MessageEvent<SimToMain>) => void) => {
      if (type === "message") listeners.push(l);
    },
    postMessage: (m: { type?: string }) => posted.push(m),
    terminate: () => undefined,
  };
  const deliver = (m: SimToMain) => {
    for (const l of listeners) l({ data: m } as MessageEvent<SimToMain>);
  };
  return { worker: worker as unknown as Worker, deliver, posted };
}

function feed() {
  const ls = new Set<(m: PersistedHeadMessage | QuotaMessage) => void>();
  return { onRecording: (l: (m: PersistedHeadMessage | QuotaMessage) => void) => (ls.add(l), () => ls.delete(l)), emit: (m: PersistedHeadMessage) => ls.forEach((l) => l(m)), count: () => ls.size };
}

const loaded = (runId: string): SimLoadedMessage =>
  ({ type: "loaded", runId, agents: [{ id: "uav-001", kind: "uav" }], idealAgents: [] }) as unknown as SimLoadedMessage;

const taken = (q: ChunkQueue) => q.take(100, () => {});

const rec = (seq: number, kind: string, agentId?: string, payload: unknown = {}): TraceRecord => ({ seq, simTime: seq / 10, kind, ...(agentId ? { agentId } : {}), payload }) as unknown as TraceRecord;

describe("filterRecords (agent and kind filters, paging)", () => {
  const list = [rec(1, "action", "a"), rec(2, "compute", "b"), rec(3, "action", "b"), rec(4, "reflex", "a"), rec(5, "action", "a")];
  it("filters by agent and kind, pages by afterSeq and limit, in seq order", () => {
    expect(filterRecords(list, { limit: 10 }).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(filterRecords(list, { limit: 10, agentId: "a" }).map((r) => r.seq)).toEqual([1, 4, 5]);
    expect(filterRecords(list, { limit: 10, kinds: ["action"] }).map((r) => r.seq)).toEqual([1, 3, 5]);
    expect(filterRecords(list, { limit: 2, agentId: "a", kinds: ["action", "reflex"], afterSeq: 1 }).map((r) => r.seq)).toEqual([4, 5]);
    expect(filterRecords(list, { limit: 1, afterSeq: 2 }).map((r) => r.seq)).toEqual([3]);
  });
});

describe("latestPlans", () => {
  it("keeps the latest found plan of each agent and ignores other records", () => {
    const plan = (seq: number, agent: string, status = "found") => rec(seq, "compute", agent, { op: "plan", status, waypoints: [[seq, 0]] });
    const m = latestPlans([plan(1, "a"), plan(2, "b"), plan(3, "a"), plan(4, "b", "failed"), rec(5, "action", "a")]);
    expect([...m.entries()].map(([k, v]) => [k, v.seq])).toEqual([["a", 3], ["b", 2]]);
  });
});

describe("LiveRunSource", () => {
  it("shows what the client shows and returns the same snapshot object while nothing changed", () => {
    const { worker, deliver } = fakeWorker();
    const sim = new SimClient(worker, 10);
    const src = new LiveRunSource(sim);
    deliver(loaded("run-000001") as unknown as SimToMain);
    const a = src.snapshot();
    expect(a).toMatchObject({ mode: "live", runId: "run-000001", entityIds: [], tick: 0, persistedHeadTick: undefined });
    expect(src.snapshot()).toBe(a);
    deliver({ type: "state", tick: 7, simTimeS: 0.7, poses: new Float32Array(4), entityIds: ["uav-001"] } as unknown as SimToMain);
    const b = src.snapshot();
    expect(b).not.toBe(a);
    expect(b).toMatchObject({ tick: 7, simHeadTick: 7, entityIds: ["uav-001"], simTimeS: 0.7 });
    expect(src.snapshot()).toBe(b);
  });

  it("reports the persisted head of the run that is loaded, next to the sim head", () => {
    const { worker, deliver } = fakeWorker();
    const f = feed();
    const src = new LiveRunSource(new SimClient(worker, 10), f);
    let heads = 0;
    src.onHead(() => heads++);
    deliver(loaded("run-000002") as unknown as SimToMain);
    f.emit({ type: "persisted", head: { runId: "run-000001", throughSeq: 5, tick: 3, simTimeS: 0.3 } } as PersistedHeadMessage);
    expect(src.snapshot().persistedHeadTick).toBeUndefined(); // another run's head
    f.emit({ type: "persisted", head: { runId: "run-000002", throughSeq: 9, tick: 6, simTimeS: 0.6 } } as PersistedHeadMessage);
    expect(src.snapshot().persistedHeadTick).toBe(6);
    expect(heads).toBe(2);
    src.dispose();
    expect(f.count()).toBe(0);
  });

  it("derives planned paths from the records once per change and answers record queries", async () => {
    const { worker, deliver } = fakeWorker();
    const src = new LiveRunSource(new SimClient(worker, 10));
    deliver(loaded("run-000001") as unknown as SimToMain);
    deliver({ type: "events", runId: "run-000001", records: [rec(1, "compute", "uav-001", { op: "plan", status: "found", waypoints: [[1, 2]] }), rec(2, "action", "uav-001")] } as unknown as SimToMain);
    const p1 = src.plannedPaths();
    expect(p1.get("uav-001")?.seq).toBe(1);
    expect(src.plannedPaths()).toBe(p1);
    deliver({ type: "events", runId: "run-000001", records: [rec(3, "compute", "uav-001", { op: "plan", status: "found", waypoints: [[3, 4]] })] } as unknown as SimToMain);
    expect(src.plannedPaths().get("uav-001")?.seq).toBe(3);
    expect((await src.queryRecords({ limit: 10, kinds: ["action"] })).map((r) => r.seq)).toEqual([2]);
  });

  it("feeds belief chunks of the watched agent and run into the queue and releases the stream", () => {
    const { worker, deliver, posted } = fakeWorker();
    const src = new LiveRunSource(new SimClient(worker, 10));
    const queue = new ChunkQueue(2);
    const stop = src.watchBelief("run-000001", "uav-001", queue);
    expect(posted.at(-1)).toEqual({ type: "beliefWatch", agentId: "uav-001" });
    const chunk = (runId: string, agentId: string) => ({ type: "beliefChunks", runId, agentId, coords: new Uint16Array([0, 0]), data: new Uint8Array(4) }) as unknown as SimToMain;
    deliver(chunk("run-000001", "uav-002"));
    deliver(chunk("run-000009", "uav-001"));
    expect(taken(queue)).toBe(0);
    deliver(chunk("run-000001", "uav-001"));
    expect(taken(queue)).toBe(1);
    stop();
    expect(posted.at(-1)).toEqual({ type: "beliefWatch", agentId: null });
    deliver(chunk("run-000001", "uav-001"));
    expect(taken(queue)).toBe(0);
  });

  it("has every feature available and passes commands and panel messages to the worker", () => {
    const { worker, posted } = fakeWorker();
    const src = new LiveRunSource(new SimClient(worker, 10));
    for (const f of ["commands", "strategyTest", "mindView", "researcher", "rays", "topology"] as const) expect(src.unavailable(f)).toBeUndefined();
    src.command("uav-001", "hold");
    expect(posted.at(-1)).toEqual({ type: "command", op: "hold", agentId: "uav-001" });
    src.send({ type: "view", agentId: "uav-001" });
    expect(posted.at(-1)).toEqual({ type: "view", agentId: "uav-001" });
  });
});
