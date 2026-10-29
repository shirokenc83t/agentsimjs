import type { StoragePorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useEffect, useRef, useState } from "react";
import { seqOfId } from "../debug/trace-tree.ts";
import type { HistoryNode } from "./history-model.ts";

// The reading behind the agent history (T-102): the first rows of one agent from storage, and the children of a node that is opened, by the parent and cause links (the indexes of
// schema v13 make both a lookup). A run that is being recorded is read again as its persisted head moves; a recording once.

const PAGE = 5000;
/** The most records of one kind a row reads: a longer history is cut at the end and says so. */
const CAP = 40_000;

type Ports = Pick<StoragePorts, "trace">;
type Query = Parameters<Ports["trace"]["query"]>[0];

async function readAll(ports: Ports, q: Query, cap = CAP): Promise<{ records: TraceRecord[]; cut: boolean }> {
  const out: TraceRecord[] = [];
  let after = q.afterSeq ?? -1;
  for (;;) {
    const page = await ports.trace.query({ ...q, afterSeq: after, limit: PAGE });
    out.push(...page);
    if (page.length < PAGE) return { records: out, cut: false };
    if (out.length >= cap) return { records: out, cut: true };
    after = (page[page.length - 1] as TraceRecord).seq;
  }
}

/** The records of the first two rows of an agent's history: its action starts, ends and refusals, its commands, its reflexes and its mission decisions. */
export async function readRootRecords(ports: Ports, runId: string, agentId: string): Promise<{ records: TraceRecord[]; cut: boolean }> {
  const parts = await Promise.all([
    readAll(ports, { runId, agentId, kinds: ["action"], op: "start", limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["action"], op: "end", limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["action"], op: "rejected", limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["injected"], op: "command", limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["reflex"], limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["thought"], op: "decision", limit: PAGE }),
    // The replans and recoveries an action went through: sub-rows of the audit (the history's rows ignore them).
    readAll(ports, { runId, agentId, kinds: ["action"], op: "replan", limit: PAGE }),
    readAll(ports, { runId, agentId, kinds: ["action"], op: "recovery", limit: PAGE }),
  ]);
  return { records: parts.flatMap((p) => p.records).sort((a, b) => a.seq - b.seq), cut: parts.some((p) => p.cut) };
}

/**
 * The children of a node: the records that have it as their parent (an action's phases, iterations, targets, replans and end) and the ones it caused (a decision's action start, a
 * command's effects, the plans an iteration asked for). Both are read, any order; the model sorts.
 */
export async function readChildren(ports: Ports, runId: string, node: HistoryNode): Promise<TraceRecord[]> {
  if (node.seq === undefined) return [];
  // An explore iteration has no records that name it as parent: its steps are the action's own children (phases, targets, replans) that fall in its span.
  const owner = node.op === "explore-iteration" ? seqOfId(node.record?.parentId) : undefined;
  const byParent =
    owner === undefined
      ? await readAll(ports, { runId, filter: `parent:#${node.seq}`, limit: PAGE }, 8000)
      : await readAll(ports, { runId, filter: `parent:#${owner}`, limit: PAGE }, 8000).then((r) => ({
          ...r,
          records: r.records.filter((c) => c.simTime >= node.t0 - 1e-9 && c.simTime <= node.t1 + 1e-9 && (c.payload as { op?: unknown } | null)?.op !== "explore-iteration"),
        }));
  const byCause = await readAll(ports, { runId, filter: `cause:#${node.seq}`, limit: PAGE }, 2000);
  const seen = new Set<number>();
  return [...byParent.records, ...byCause.records].filter((r) => (seen.has(r.seq) ? false : (seen.add(r.seq), true))).sort((a, b) => a.seq - b.seq);
}

/** The effects of a record, for the side panel: the records that name it as a cause (at most 200). */
export async function readEffects(ports: Ports, runId: string, seq: number): Promise<TraceRecord[]> {
  return (await readAll(ports, { runId, filter: `cause:#${seq}`, limit: PAGE }, 200)).records.slice(0, 200);
}

export interface AgentHistoryData {
  readonly records: readonly TraceRecord[];
  readonly cut: boolean;
  readonly loading: boolean;
}

/** The first rows' records of `agentId` in `runId`; read again when the persisted head moves (a run being recorded). */
export function useAgentHistory(ports: Ports, runId: string | undefined, agentId: string | undefined, headTick: number): AgentHistoryData {
  const [data, setData] = useState<AgentHistoryData>({ records: [], cut: false, loading: true });
  const generation = useRef(0);
  useEffect(() => {
    if (runId === undefined || agentId === undefined) {
      setData({ records: [], cut: false, loading: false });
      return;
    }
    const mine = ++generation.current;
    void readRootRecords(ports, runId, agentId).then((r) => {
      if (mine === generation.current) setData({ ...r, loading: false });
    });
  }, [ports, runId, agentId, headTick]);
  return data;
}
