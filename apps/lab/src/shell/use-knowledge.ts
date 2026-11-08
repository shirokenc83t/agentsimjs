import type { TraceRecord } from "@agentsim/trace";
import { useEffect, useRef, useState } from "react";
import { useServices } from "../services.tsx";
import { knowledgeBand, type KnowledgeBand } from "./knowledge-band.ts";
import { useBandWithUnion } from "./use-union.ts";

const PAGE = 5_000;
/** Samples kept: a run with more is drawn from its first ones (20 agents every 10 s is 7,200 an hour). */
const MAX_SAMPLES = 40_000;
const NONE: KnowledgeBand = { points: [], observed: 0, agentIds: [], ideal: 0, everyS: undefined, gaps: [] };

/**
 * The swarm knowledge band of a stored run up to `headS`: the observer's `belief-vs-truth` samples read from storage in the background (more of them as the head grows, for a run that is
 * still recording), reduced by `knowledgeBand`. Nothing here is on the render path, and nothing of it reaches a mind: the samples are read where panels read, never from the world.
 */
export function useKnowledgeBand(runId: string | undefined, headS: number, dtS = 0.1): KnowledgeBand {
  const { storage } = useServices();
  const [band, setBand] = useState<KnowledgeBand>(NONE);
  const state = useRef<{ runId: string | undefined; records: TraceRecord[]; after: number | undefined; busy: boolean; head: number }>({ runId: undefined, records: [], after: undefined, busy: false, head: 0 });

  useEffect(() => {
    if (state.current.runId !== runId) {
      state.current = { runId, records: [], after: undefined, busy: false, head: headS };
      setBand(NONE);
    }
    const now = state.current;
    // The head the reading has to reach: a head that moves while a read is on its way is read next, by the same loop (the read is never thrown away, and a head that moves no more, as the one of a run that is done, is read
    // all the same).
    now.head = headS;
    if (runId === undefined || now.busy) return;
    now.busy = true;
    void (async () => {
      try {
        for (;;) {
          const reached = now.head;
          for (;;) {
            const page = await storage.ports.trace.query({ runId, kinds: ["event"], op: "belief-vs-truth", simTime: { to: reached }, limit: PAGE, ...(now.after === undefined ? {} : { afterSeq: now.after }) });
            if (state.current !== now) return;
            now.records.push(...page);
            if (page.length > 0) now.after = page[page.length - 1]?.seq ?? now.after;
            if (page.length < PAGE || now.records.length >= MAX_SAMPLES) break;
          }
          if (state.current === now) setBand(knowledgeBand(now.records));
          if (now.head === reached) break;
        }
      } catch {
        // A failed read shows when the head moves again.
      } finally {
        now.busy = false;
      }
    })();
  }, [storage, runId, headS]);

  return useBandWithUnion(band, runId, headS, dtS);
}
