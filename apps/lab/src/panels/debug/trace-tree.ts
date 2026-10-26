import type { StoragePorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";

// The trace tree (UI-SPEC section 4): around one record, the chain of its parents, the records it was caused by, the records that have it as their parent and the records it
// caused, a few levels of each. Built by reading the run through the storage ports (the SQL backend of the filter language: `parent:#N` and `cause:#N`), so it works for a run
// that is being recorded (what is flushed) and for a recording alike. A record of a derived run that was copied from its parent says so.

/** One record in the tree and what hangs from it in the same direction (its own causes, or its own children), a few levels down. */
export interface TreeNode {
  readonly record: TraceRecord;
  /** The ID the record had in the parent run when it is a copy a derived run carries (ADR-0035 item 2(b)). */
  readonly copyOf: string | undefined;
  readonly below: readonly TreeNode[];
  /** How many more there are than are shown here: "more…" shows them. */
  readonly more: number;
}

export interface TraceTree {
  readonly selected: TreeNode;
  /** The parent chain, nearest first. */
  readonly ancestors: readonly TreeNode[];
  /** True when the last ancestor shown has a parent that is not shown. */
  readonly ancestorsMore: boolean;
  /** What the record was caused by, each with its own causes. */
  readonly causes: readonly TreeNode[];
  readonly causesMore: number;
  /** The records that have it as their parent, each with its own children. */
  readonly children: readonly TreeNode[];
  readonly childrenMore: number;
  /** The records that have it among their causes, each with its own effects. */
  readonly effects: readonly TreeNode[];
  readonly effectsMore: number;
}

export interface TreeOptions {
  /** Levels of the parent chain (default 4), of causes (3), of children and effects (2). */
  readonly depthUp?: number;
  readonly depthCauses?: number;
  readonly depthDown?: number;
  /** How many a node shows before "more…" (default 12). */
  readonly perNode?: number;
  /** A node that was asked to show more: its key (`up`, `causes:SEQ`, `children:SEQ`, `effects:SEQ`) and how many it shows now. */
  readonly limits?: ReadonlyMap<string, number>;
}

const DEFAULTS = { depthUp: 4, depthCauses: 3, depthDown: 2, perNode: 12 } as const;

/** The sequence number of a record ID (`run-000001#42` is 42), or undefined. */
export function seqOfId(id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const at = id.lastIndexOf("#");
  const n = at < 0 ? Number.NaN : Number(id.slice(at + 1));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const copyOfOf = (r: TraceRecord): string | undefined => {
  const p = r.payload;
  const c = p !== null && typeof p === "object" ? (p as { copyOf?: unknown }).copyOf : undefined;
  return typeof c === "string" ? c : undefined;
};

/** A record of the run by its sequence number. */
export async function recordBySeq(ports: Pick<StoragePorts, "trace">, runId: string, seq: number): Promise<TraceRecord | undefined> {
  const [r] = await ports.trace.query({ runId, afterSeq: seq - 1, limit: 1 });
  return r !== undefined && r.seq === seq ? r : undefined;
}

/** The tree around record `seq` of the run, or undefined when the run has no such record. */
export async function buildTraceTree(ports: Pick<StoragePorts, "trace">, runId: string, seq: number, o: TreeOptions = {}): Promise<TraceTree | undefined> {
  const depthUp = o.depthUp ?? DEFAULTS.depthUp;
  const depthCauses = o.depthCauses ?? DEFAULTS.depthCauses;
  const depthDown = o.depthDown ?? DEFAULTS.depthDown;
  const limitOf = (key: string): number => o.limits?.get(key) ?? o.perNode ?? DEFAULTS.perNode;
  const root = await recordBySeq(ports, runId, seq);
  if (!root) return undefined;
  const node = (record: TraceRecord, below: readonly TreeNode[] = [], more = 0): TreeNode => ({ record, copyOf: copyOfOf(record), below, more });

  // The parent chain, nearest first.
  const ancestors: TreeNode[] = [];
  let ancestorsMore = false;
  const seen = new Set<number>([seq]);
  const upLimit = o.limits?.get("up") ?? depthUp;
  for (let at = root; ; ) {
    const ps = seqOfId(at.parentId);
    if (ps === undefined || seen.has(ps)) break;
    if (ancestors.length >= upLimit) {
      ancestorsMore = true;
      break;
    }
    const p = await recordBySeq(ports, runId, ps);
    if (!p) break;
    seen.add(ps);
    ancestors.push(node(p));
    at = p;
  }

  // Causes: the records named in `causeIds`, and theirs, a few levels, no record twice on a path.
  const causesOf = async (r: TraceRecord, depth: number, path: ReadonlySet<number>): Promise<{ nodes: TreeNode[]; more: number }> => {
    const all = [...new Set((r.causeIds ?? []).map(seqOfId).filter((s): s is number => s !== undefined && !path.has(s)))].sort((a, b) => a - b);
    const cap = limitOf(`causes:${r.seq}`);
    const nodes: TreeNode[] = [];
    for (const s of all.slice(0, cap)) {
      const c = await recordBySeq(ports, runId, s);
      if (!c) continue;
      const deeper = depth > 1 ? await causesOf(c, depth - 1, new Set([...path, s])) : { nodes: [], more: 0 };
      nodes.push(node(c, deeper.nodes, deeper.more));
    }
    return { nodes, more: Math.max(0, all.length - cap) };
  };
  const causes = await causesOf(root, depthCauses, new Set([seq]));

  // Children (parent) and effects (cause): found by the filter language, so the SQL backend does the work.
  const downFrom = async (r: TraceRecord, term: "parent" | "cause", kind: "children" | "effects", depth: number, path: ReadonlySet<number>): Promise<{ nodes: TreeNode[]; more: number }> => {
    const cap = limitOf(`${kind}:${r.seq}`);
    const found = (await ports.trace.query({ runId, filter: `${term}:#${r.seq}`, limit: cap + 1 })).filter((x) => !path.has(x.seq));
    const nodes: TreeNode[] = [];
    for (const c of found.slice(0, cap)) {
      const deeper = depth > 1 ? await downFrom(c, term, kind, depth - 1, new Set([...path, c.seq])) : { nodes: [], more: 0 };
      nodes.push(node(c, deeper.nodes, deeper.more));
    }
    return { nodes, more: Math.max(0, found.length - cap) };
  };
  const children = await downFrom(root, "parent", "children", depthDown, new Set([seq]));
  const effects = await downFrom(root, "cause", "effects", depthDown, new Set([seq]));

  return { selected: node(root), ancestors, ancestorsMore, causes: causes.nodes, causesMore: causes.more, children: children.nodes, childrenMore: children.more, effects: effects.nodes, effectsMore: effects.more };
}
