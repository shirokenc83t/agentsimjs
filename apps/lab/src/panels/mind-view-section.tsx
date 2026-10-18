import type { DecisionRequest } from "@agentsim/core";
import { useEffect, type ReactNode } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { useSimStream } from "./use-sim-stream.ts";

/** One row of the section. */
function Row(props: { k: string; testId?: string; children: ReactNode }) {
  return (
    <>
      <dt>{props.k}</dt>
      <dd data-testid={props.testId}>{props.children}</dd>
    </>
  );
}

/** The latest request, parsed from the worker's JSON text (the text itself is what is shown as raw). */
function parse(text: string): DecisionRequest | undefined {
  try {
    return JSON.parse(text) as DecisionRequest;
  } catch {
    return undefined;
  }
}

/**
 * What the agent's mind receives (ADR-0005 addition of 2026-10-12): the decision request produced by the world's own
 * builder in the sim worker and serialized as a mind gets it. Nothing here is reconstructed in the UI and nothing is
 * ground truth; researcher-only data (beliefs versus truth) is a separate section. Asking for the view changes
 * nothing in the run.
 */
export function MindViewSection(props: { source: RunSource; agentId: string; runId: string }) {
  const { source, agentId, runId } = props;
  // Look at this agent while the section is shown; stop when it goes away (agent or run changed, panel closed).
  useEffect(() => {
    source.send({ type: "view", agentId });
    return () => source.send({ type: "view", agentId: null });
  }, [source, agentId, runId]);
  const msg = useSimStream(source, "agentView", (m) => m.runId === runId && m.agentId === agentId, [runId, agentId]);
  const req = msg ? parse(msg.request) : undefined;
  return (
    <section className="inspector-section mind-view" data-testid="inspector-mind-view" aria-label="What the mind receives">
      <h4>
        <span className="kind-tag mono">◇ MIND</span> What the mind receives (decision request)
      </h4>
      {!msg || !req ? (
        <p className="muted">Waiting for the worker…</p>
      ) : (
        <>
          <dl className="kv">
            <Row k="request" testId="mind-request-status">
              tick {req.tick} · {msg.pending ? "asked, not answered yet" : "would be sent now"} · {msg.request.length} bytes
            </Row>
            <Row k="events" testId="mind-events">
              {req.events.length === 0 ? "none" : req.events.map((e, i) => <span key={i} className="mono">{e.kind}{" "}</span>)}
              {req.eventsDropped > 0 ? ` (+${req.eventsDropped} dropped)` : ""}
            </Row>
            <Row k="self" testId="mind-self">
              <span className="mono">
                {req.self.running ? `${req.self.running.name} · ${req.self.running.phase}` : "idle"} · soc {req.self.soc} · timers {req.self.timers.length}
              </span>
            </Row>
            <Row k="map" testId="mind-map">
              known {req.beliefs.map.knownPct} % · free {req.beliefs.map.freePct} % · occupied {req.beliefs.map.occupiedPct} % (of known)
            </Row>
            <Row k="entities" testId="mind-entities">
              {req.beliefs.entities.length === 0 ? (
                "none"
              ) : (
                req.beliefs.entities.map((e) => (
                  <div key={e.id} className="mono" data-testid={`mind-entity-${e.id}`}>
                    {e.id} · {e.kind} · {e.state} · age {e.ageS} s · ({e.xM}, {e.yM})
                  </div>
                ))
              )}
              {req.beliefs.entitiesOmitted > 0 ? ` (+${req.beliefs.entitiesOmitted} more)` : ""}
            </Row>
            <Row k="space" testId="mind-space">
              region {req.space.region} · {req.space.regions.length} regions listed · {req.space.frontiers.length} frontiers
            </Row>
            <Row k="allowed" testId="mind-allowed">
              <span className="mono">{req.allowedActions.map((a) => a.name).join(", ") || "none"}</span>
            </Row>
            <Row k="not allowed" testId="mind-unavailable">
              {req.unavailable.length === 0
                ? "none"
                : req.unavailable.map((u) => (
                    <div key={u.name} className="mono" data-testid={`mind-unavailable-${u.name}`}>
                      ✗ {u.name} · {u.code}
                      {u.requires ? ` (${u.requires})` : ""}
                    </div>
                  ))}
            </Row>
          </dl>
          <details>
            <summary>Raw request (JSON, as the mind gets it)</summary>
            <pre className="mono" data-testid="mind-request-json" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto" }}>
              {msg.request}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
