import type { TraceRecord } from "@agentsim/trace";

// The references of a derived window (ADR-0035 addition of 2026-10-17, item 2(b)): what its records refer to and that is not among them, and the copies that make it self-contained.
// Pure and small, so that the code that reads the parent from storage can have it without the simulator.

/** A window longer than this (sim seconds) is refused: the derived trace is built in memory before it is stored. */
export const MAX_WINDOW_S = 300;

/** Records of the parent that the derived records refer to and that are not among them: the controller reads them from the parent and re-emits them as copies. */
export interface UnresolvedReferences {
  /** Hashes of `space` summaries that requests refer to. */
  readonly spaces: ReadonlySet<string>;
  /** Query IDs that the notes of a running action refer to. */
  readonly queries: ReadonlySet<string>;
  /** Records by ID (a parent or a cause). */
  readonly records: ReadonlySet<string>;
}


const payloadOf = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

/** The references the records make that no record of the same set answers (ADR-0035 item 2(b)): a request's space, a note's query, a parent or a cause. */
export function unresolvedReferences(records: readonly TraceRecord[]): UnresolvedReferences {
  const haveSpaces = new Set<string>();
  const haveQueries = new Set<string>();
  const haveIds = new Set<string>();
  for (const r of records) {
    haveIds.add(r.id);
    const p = payloadOf(r);
    if (r.kind === "thought" && p["op"] === "space" && typeof p["hash"] === "string") haveSpaces.add(p["hash"]);
    if (r.kind === "compute" && typeof p["queryId"] === "string") haveQueries.add(p["queryId"]);
  }
  const spaces = new Set<string>();
  const queries = new Set<string>();
  const ids = new Set<string>();
  for (const r of records) {
    const p = payloadOf(r);
    if (r.kind === "thought" && p["op"] === "request" && typeof p["space"] === "string" && !haveSpaces.has(p["space"])) spaces.add(p["space"]);
    if (r.kind === "action" && typeof p["queryId"] === "string" && !haveQueries.has(p["queryId"])) queries.add(p["queryId"]);
    if (r.parentId !== undefined && !haveIds.has(r.parentId)) ids.add(r.parentId);
    for (const c of r.causeIds ?? []) if (!haveIds.has(c)) ids.add(c);
  }
  return { spaces, queries, records: ids };
}

/**
 * Re-emits records of the parent that the derived records refer to, as copies: the same record with the derived run's ID, marked in its payload with the ID it had in the
 * parent (`copyOf`), at the seq it had (so they come first and the run keeps its order: they all happened before the window's first record). Returns the copies in
 * seq order.
 */
export function copiesOf(parentRunId: string, derivedRunId: string, found: readonly TraceRecord[]): TraceRecord[] {
  const seen = new Set<number>();
  const out: TraceRecord[] = [];
  // A parent or a cause of a copy names a record by the parent's ID; the same record is in the derived run under the derived run's.
  const mine = (id: string) => (id.startsWith(`${parentRunId}#`) ? `${derivedRunId}#${id.slice(parentRunId.length + 1)}` : id);
  for (const r of [...found].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(r.seq)) continue;
    seen.add(r.seq);
    const { parentId, causeIds, ...rest } = r;
    out.push({
      ...rest,
      id: `${derivedRunId}#${r.seq}`,
      runId: derivedRunId,
      payload: { ...payloadOf(r), copyOf: r.id },
      ...(parentId === undefined ? {} : { parentId: mine(parentId) }),
      ...(causeIds === undefined ? {} : { causeIds: causeIds.map(mine) }),
    });
  }
  return out;
}

/**
 * The copies a derived window needs to be self-contained, found until nothing it refers to is missing (a copy can itself refer to a record: a parent or a cause).
 * `find` is the caller's read of the parent, by what is asked for; it returns whatever records it has for the references (those it cannot find stay unresolved and are
 * reported, never invented).
 */
export async function completeReferences(
  parentRunId: string,
  derivedRunId: string,
  records: readonly TraceRecord[],
  find: (need: UnresolvedReferences) => Promise<readonly TraceRecord[]> | readonly TraceRecord[],
): Promise<{ readonly copies: TraceRecord[]; readonly unresolved: UnresolvedReferences }> {
  const copies: TraceRecord[] = [];
  const have = new Set(records.map((r) => r.seq));
  let all: TraceRecord[] = [...records];
  let unresolved = unresolvedReferences(all);
  for (let round = 0; round < 8; round++) {
    if (unresolved.spaces.size + unresolved.queries.size + unresolved.records.size === 0) break;
    const found = (await find(unresolved)).filter((r) => !have.has(r.seq));
    if (found.length === 0) break;
    const fresh = copiesOf(parentRunId, derivedRunId, found);
    for (const c of fresh) have.add(c.seq);
    copies.push(...fresh);
    all = [...copies, ...records];
    unresolved = unresolvedReferences(all);
  }
  copies.sort((a, b) => a.seq - b.seq);
  return { copies, unresolved };
}
