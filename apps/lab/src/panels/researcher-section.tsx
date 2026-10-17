import { useEffect, useState } from "react";
import type { SimClient } from "../sim/sim-client.ts";
import { asResearcherData, type ResearcherData } from "./researcher-data.ts";
import { useSimStream } from "./use-sim-stream.ts";

/** The text every researcher-only surface carries. */
export const RESEARCHER_BANNER = "Researcher view — not visible to the mind";

function Metrics(props: { d: ResearcherData }) {
  const { d } = props;
  const m = d.map;
  return (
    <dl className="kv">
      {m ? (
        <>
          <dt>reachable cells</dt>
          <dd data-testid="researcher-reachable">{m.reachableCells}</dd>
          <dt>correct</dt>
          <dd data-testid="researcher-correct">{m.correctPct.toFixed(2)} %</dd>
          <dt>wrong: believed occupied</dt>
          <dd data-testid="researcher-phantom">{m.phantomPct.toFixed(2)} %</dd>
          <dt>unknown</dt>
          <dd data-testid="researcher-unknown">{m.unknownPct.toFixed(2)} %</dd>
          <dt>wrong: believed free</dt>
          <dd data-testid="researcher-falsefree">
            {m.falseFreeCells} cells ({m.falseFreePct.toFixed(2)} % of believed free)
          </dd>
          <dt>height violations</dt>
          <dd data-testid="researcher-height">{m.heightViolations}</dd>
        </>
      ) : (
        <>
          <dt>map</dt>
          <dd data-testid="researcher-ideal">◆ ideal: the agent plans on the ground truth, there is nothing to compare</dd>
        </>
      )}
      <dt>entities known</dt>
      <dd data-testid="researcher-entities">
        {d.entities.known} of {d.entities.total} · position error mean {d.entities.meanErrM} m, max {d.entities.maxErrM} m
      </dd>
      <dt>as of</dt>
      <dd className="mono">
        tick {d.tick} · {d.simTimeS.toFixed(1)} s
      </dd>
    </dl>
  );
}

/**
 * Researcher view (ADR-0005 addition of 2026-10-12): the selected agent's beliefs compared with the ground truth. Visibly
 * apart from what the mind receives, and marked as such. The worker computes it (observer-side, pure) and streams it
 * only while this section is mounted and expanded; the data goes one way, worker → here, and has no path back: its
 * type is branded and nothing that sends to the worker accepts it.
 */
export function ResearcherSection(props: { sim: SimClient; agentId: string; runId: string }) {
  const { sim, agentId, runId } = props;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) return;
    sim.send({ type: "researcherWatch", agentId });
    return () => sim.send({ type: "researcherWatch", agentId: null });
  }, [sim, agentId, runId, open]);
  const msg = useSimStream(sim, "researcherData", (m) => m.runId === runId && m.agentId === agentId, [runId, agentId, open]);
  const data = msg ? asResearcherData(msg) : undefined;
  return (
    <details className="researcher-view" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="inspector-researcher">
      <summary>
        <span className="kind-tag mono">◆ RESEARCHER</span> Beliefs versus ground truth
      </summary>
      <p className="researcher-banner" role="note" data-testid="researcher-banner">
        ◆ {RESEARCHER_BANNER}
      </p>
      {data ? <Metrics d={data} /> : <p className="muted">{open ? "Waiting for the worker…" : ""}</p>}
    </details>
  );
}
