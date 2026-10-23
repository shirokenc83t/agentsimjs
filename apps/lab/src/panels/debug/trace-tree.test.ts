import { createMemoryPorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildTraceTree, recordBySeq, seqOfId, type TreeNode } from "./trace-tree.ts";

// The trace tree (UI-SPEC section 4): parents, causes, children and effects of a record, a few levels each, with "more…", read through the storage ports.

const RUN = "run-000001";
const rec = (seq: number, over: Partial<TraceRecord> = {}): TraceRecord => ({ id: `${RUN}#${seq}`, runId: RUN, seq, simTime: seq * 0.1, wallTime: 1, source: "uav-001/actions", kind: "action", agentId: "uav-001", payload: { op: "x", seq }, ...over });
const ref = (seq: number) => `${RUN}#${seq}`;

async function ports(records: TraceRecord[]) {
  const p = createMemoryPorts();
  await p.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running" });
  const r = await p.trace.append(records);
  if (!r.ok) throw new Error(r.error.message);
  return p;
}
const seqs = (nodes: readonly TreeNode[]) => nodes.map((n) => n.record.seq);

describe("seqOfId", () => {
  it("is the number after the #, or undefined", () => {
    expect(seqOfId("run-000001#42")).toBe(42);
    expect(seqOfId("run-000001#0")).toBe(0);
    expect(seqOfId("run-000001")).toBeUndefined();
    expect(seqOfId("run-000001#x")).toBeUndefined();
    expect(seqOfId(undefined)).toBeUndefined();
  });
});

describe("buildTraceTree", () => {
  // 0 ← 1 ← 2 ← 10 (the record) ; causes 5 (itself caused by 3 and 4) and 6 ; children 20 (with child 30) and 21 ; effects 40 (with effect 50)
  const records = [
    rec(0),
    rec(1, { parentId: ref(0) }),
    rec(2, { parentId: ref(1) }),
    rec(3),
    rec(4),
    rec(5, { causeIds: [ref(3), ref(4)] }),
    rec(6),
    rec(10, { parentId: ref(2), causeIds: [ref(5), ref(6)] }),
    rec(20, { parentId: ref(10) }),
    rec(21, { parentId: ref(10) }),
    rec(30, { parentId: ref(20) }),
    rec(40, { causeIds: [ref(10)] }),
    rec(50, { causeIds: [ref(40)] }),
    rec(60),
  ];

  it("gives the parent chain nearest first, the causes with theirs, the children with theirs and the effects with theirs", async () => {
    const t = await buildTraceTree(await ports(records), RUN, 10);
    expect(t?.selected.record.seq).toBe(10);
    expect(seqs(t?.ancestors ?? [])).toEqual([2, 1, 0]);
    expect(t?.ancestorsMore).toBe(false);
    expect(seqs(t?.causes ?? [])).toEqual([5, 6]);
    expect(seqs(t?.causes[0]?.below ?? [])).toEqual([3, 4]);
    expect(seqs(t?.children ?? [])).toEqual([20, 21]);
    expect(seqs(t?.children[0]?.below ?? [])).toEqual([30]);
    expect(seqs(t?.effects ?? [])).toEqual([40]);
    expect(seqs(t?.effects[0]?.below ?? [])).toEqual([50]);
  });

  it("is empty around a record that has no relations, and undefined for a record that is not there", async () => {
    const p = await ports(records);
    const t = await buildTraceTree(p, RUN, 60);
    expect([t?.ancestors, t?.causes, t?.children, t?.effects].map((x) => x?.length)).toEqual([0, 0, 0, 0]);
    expect(await buildTraceTree(p, RUN, 999)).toBeUndefined();
    expect(await recordBySeq(p, RUN, 999)).toBeUndefined();
  });

  it("stops at the depth asked and says there is more: the chain, the causes and the children", async () => {
    const p = await ports(records);
    const t = await buildTraceTree(p, RUN, 10, { depthUp: 2, depthCauses: 1, depthDown: 1 });
    expect(seqs(t?.ancestors ?? [])).toEqual([2, 1]);
    expect(t?.ancestorsMore).toBe(true);
    expect(t?.causes[0]?.below).toEqual([]);
    expect(t?.children[0]?.below).toEqual([]);
    // "more…" on the chain: the limit of `up` raised.
    const more = await buildTraceTree(p, RUN, 10, { depthUp: 2, limits: new Map([["up", 3]]) });
    expect(seqs(more?.ancestors ?? [])).toEqual([2, 1, 0]);
    expect(more?.ancestorsMore).toBe(false);
  });

  it("shows a few per node and counts the rest; a node asked for more shows more", async () => {
    const many = [rec(0), ...Array.from({ length: 30 }, (_, i) => rec(1 + i, { parentId: ref(0) }))];
    const p = await ports(many);
    const t = await buildTraceTree(p, RUN, 0, { perNode: 5 });
    expect(seqs(t?.children ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(t?.childrenMore).toBeGreaterThanOrEqual(1);
    const more = await buildTraceTree(p, RUN, 0, { perNode: 5, limits: new Map([["children:0", 40]]) });
    expect(more?.children.length).toBe(30);
    expect(more?.childrenMore).toBe(0);
  });

  it("a record in a cycle is not repeated on its own path", async () => {
    const cyc = [rec(0, { parentId: ref(1), causeIds: [ref(1)] }), rec(1, { parentId: ref(0), causeIds: [ref(0)] })];
    const t = await buildTraceTree(await ports(cyc), RUN, 0, { depthUp: 6, depthCauses: 6, depthDown: 6 });
    expect(seqs(t?.ancestors ?? [])).toEqual([1]);
    expect(seqs(t?.causes ?? [])).toEqual([1]);
    expect(t?.causes[0]?.below).toEqual([]);
    expect(seqs(t?.children ?? [])).toEqual([1]);
    expect(t?.children[0]?.below).toEqual([]);
  });

  it("marks a record that a derived run copied from its parent, with the ID it had there", async () => {
    const copy = rec(7, { payload: { op: "config", copyOf: "run-000001#7" } });
    const t = await buildTraceTree(await ports([copy, rec(8, { parentId: ref(7) })]), RUN, 8);
    expect(t?.ancestors[0]?.copyOf).toBe("run-000001#7");
    expect(t?.selected.copyOf).toBeUndefined();
  });

  it("a cause that is not in the run is left out, not an error", async () => {
    const t = await buildTraceTree(await ports([rec(1, { causeIds: [ref(99), ref(0)] }), rec(0)]), RUN, 1);
    expect(seqs(t?.causes ?? [])).toEqual([0]);
  });
});
