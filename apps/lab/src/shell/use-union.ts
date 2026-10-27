import type { StorageClient } from "@agentsim/storage";
import { useEffect, useMemo, useState } from "react";
import { useServices } from "../services.tsx";
import type { KnowledgeBand, KnowledgeUnion } from "./knowledge-band.ts";
import { unionKnown, type BeliefMapBytes } from "./knowledge-union.ts";

// The union of what the swarm knows, computed in the background from the belief maps replay rebuilds from the recorded keyframes and deltas (`replay.beliefAt`, in the storage worker): one read
// per agent at each time of a grid, the cells known to any agent counted. Shared by every panel that shows the band (the player, the headless monitor, the Analysis): one computation per run,
// each time computed once, in order, one at a time, so the worker is never asked for more than one read at a time from here. The wall time spent is kept, and shown in the strip's attributes.

/** The most belief maps one run asks of the worker for its union: a longer run is taken at a coarser grid. */
export const MAX_READS = 600;

interface Entry {
  readonly points: Map<number, number>;
  calls: number;
  costMs: number;
  busy: boolean;
  failed: Set<number>;
  readonly listeners: Set<() => void>;
}
const entries = new Map<string, Entry>();
const entryOf = (runId: string): Entry => {
  let e = entries.get(runId);
  if (e === undefined) entries.set(runId, (e = { points: new Map(), calls: 0, costMs: 0, busy: false, failed: new Set(), listeners: new Set() }));
  return e;
};

/** The times the union is taken at: every `everyS` (a multiple of it, coarser for a long run so a run asks for at most `MAX_READS` maps), from the first sample to the head. */
export function unionGrid(args: { readonly firstS: number; readonly headS: number; readonly everyS: number; readonly agents: number }): { stepS: number; times: number[] } {
  const span = Math.max(0, args.headS - args.firstS);
  const wanted = Math.ceil(span / args.everyS) + 1;
  const stride = Math.max(1, Math.ceil((wanted * args.agents) / MAX_READS));
  const stepS = args.everyS * stride;
  const times: number[] = [];
  for (let t = Math.ceil(args.firstS / stepS) * stepS; t <= args.headS + 1e-9; t += stepS) times.push(Math.round(t * 1000) / 1000);
  return { stepS, times };
}

async function compute(storage: Pick<StorageClient, "replay">, runId: string, agentIds: readonly string[], dtS: number, times: readonly number[], entry: Entry): Promise<void> {
  if (entry.busy) return;
  entry.busy = true;
  try {
    for (const t of times) {
      const tick = Math.round(t / dtS);
      if (entry.points.has(tick) || entry.failed.has(tick)) continue;
      const t0 = performance.now();
      const maps: BeliefMapBytes[] = [];
      let ok = true;
      for (const agentId of agentIds) {
        const r = await storage.replay.beliefAt(runId, agentId, tick);
        entry.calls++;
        if (!r.ok) {
          ok = false;
          break;
        }
        maps.push(r.value);
      }
      entry.costMs += performance.now() - t0;
      if (ok) entry.points.set(tick, unionKnown(maps).pct);
      else entry.failed.add(tick);
      for (const l of entry.listeners) l();
    }
  } finally {
    entry.busy = false;
  }
}

/** The band with the union of the agents' known cells, where the run has it computed (more of it appears as it is computed); the band itself, until then. */
export function useBandWithUnion(band: KnowledgeBand, runId: string | undefined, headS: number, dtS: number): KnowledgeBand {
  const { storage } = useServices();
  const [version, setVersion] = useState(0);
  const first = band.points[0]?.t;
  const everyS = band.everyS;
  const agents = band.agentIds.join(",");
  useEffect(() => {
    if (runId === undefined || first === undefined || everyS === undefined || band.agentIds.length === 0) return;
    const entry = entryOf(runId);
    const bump = () => setVersion((v) => v + 1);
    entry.listeners.add(bump);
    const { times } = unionGrid({ firstS: first, headS, everyS, agents: band.agentIds.length });
    void compute(storage, runId, band.agentIds, dtS, times, entry);
    return () => void entry.listeners.delete(bump);
    // `agents` is the list of IDs as a string, so a new array of the same IDs does not start the work again.
  }, [storage, runId, first, everyS, headS, dtS, agents]);
  return useMemo(() => {
    if (runId === undefined || everyS === undefined || first === undefined) return band;
    const entry = entries.get(runId);
    if (entry === undefined || entry.points.size === 0) return band;
    const { stepS } = unionGrid({ firstS: first, headS, everyS, agents: band.agentIds.length });
    const points = [...entry.points.entries()].map(([tick, pct]) => ({ t: Math.round(tick * dtS * 1000) / 1000, pct })).sort((a, b) => a.t - b.t);
    const union: KnowledgeUnion = { points, stepS, calls: entry.calls, costMs: Math.round(entry.costMs) };
    return { ...band, union };
    // `version` is what says the entry has grown.
  }, [band, runId, first, everyS, headS, dtS, version]);
}
