import { useEffect, useRef, useState } from "react";
import { useServices } from "../../services.tsx";
import { MARK_KINDS, markOf, type Mark } from "./marks.ts";

const PAGE = 5_000;
/** Marks kept for the Timeline: a run with more is drawn from its first ones (the list and the cursor still reach everything). */
const MAX_MARKS = 40_000;

/**
 * The marks of a stored run up to `headS`, read from storage in the background (actions, reflexes, injected commands, degradations, snapshots and
 * checkpoints), more of them as the head grows (a run that is still recording). Nothing here is on the render path: the Timeline draws what is loaded.
 */
export function useRunMarks(runId: string | undefined, headS: number): readonly Mark[] {
  const { storage } = useServices();
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const state = useRef<{ runId: string | undefined; marks: Mark[]; through: { kinds: number; checkpoints: number }; busy: boolean }>({ runId: undefined, marks: [], through: { kinds: -1, checkpoints: -1 }, busy: false });

  useEffect(() => {
    const s = state.current;
    if (s.runId !== runId) {
      state.current = { runId, marks: [], through: { kinds: -1, checkpoints: -1 }, busy: false };
      setMarks([]);
    }
    const now = state.current;
    if (runId === undefined || now.busy) return;
    now.busy = true;
    let alive = true;
    void (async () => {
      try {
        for (const which of ["kinds", "checkpoints"] as const) {
          for (;;) {
            const page = await storage.ports.trace.query({
              runId,
              afterSeq: now.through[which],
              limit: PAGE,
              simTime: { to: headS },
              ...(which === "kinds" ? { kinds: [...MARK_KINDS] } : { kinds: ["event"], op: "checkpoint" }),
            });
            if (!alive || state.current !== now) return;
            for (const r of page) now.marks.push(markOf(r));
            if (page.length > 0) now.through[which] = page[page.length - 1]?.seq ?? now.through[which];
            if (page.length < PAGE || now.marks.length >= MAX_MARKS) break;
          }
        }
        if (alive && state.current === now) setMarks([...now.marks].sort((a, b) => a.t - b.t || a.seq - b.seq));
      } catch {
        // A failed read shows when the head moves again.
      } finally {
        now.busy = false;
      }
    })();
    return () => {
      alive = false;
    };
  }, [storage, runId, headS]);

  return marks;
}
