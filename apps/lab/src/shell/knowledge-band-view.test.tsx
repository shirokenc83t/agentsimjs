import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Mark } from "../panels/debug/marks.ts";
import { KnowledgeStrip } from "./knowledge-band-view.tsx";
import type { KnowledgeBand } from "./knowledge-band.ts";

// The strip's hatch is a material, never the only carrier of a meaning (U-016): each hatched span says what it is in its tooltip, and the marks say what is under them.

const BAND: KnowledgeBand = {
  points: [
    { t: 10, knownPct: 20, matchPct: 18, agents: 2 },
    { t: 20, knownPct: 30, matchPct: 25, agents: 2 },
    { t: 70, knownPct: 60, matchPct: 55, agents: 2 },
  ],
  observed: 2,
  agentIds: ["ugv-001", "ugv-002"],
  ideal: 0,
  everyS: 10,
  gaps: [{ fromS: 20, toS: 70 }],
};
const reflex: Mark = { seq: 5, t: 40, kind: "reflex", op: undefined, agentId: "ugv-007", code: "obstacle_ahead" };
const failure: Mark = { seq: 6, t: 41, kind: "action", op: "end", agentId: "ugv-002", status: "failed", code: "unreachable" };

describe("the swarm knowledge strip", () => {
  it("hatches the time before the first sample and every gap, each saying what it is in its tooltip", () => {
    render(<KnowledgeStrip band={BAND} marks={[]} runId="run-1" startS={0} scaleS={80} atS={70} />);
    expect(screen.getByTestId("player-knowledge-before")).toHaveAttribute("title", expect.stringContaining("Before the first sample (10.0 s)"));
    expect(screen.getByTestId("player-knowledge-gap")).toHaveAttribute("title", expect.stringContaining("No sample from 20.0 s to 70.0 s"));
  });

  it("a recording with no belief sample is hatched whole and says so", () => {
    render(<KnowledgeStrip band={{ points: [], observed: 0, agentIds: [], ideal: 0, everyS: undefined, gaps: [] }} marks={[]} runId="run-1" startS={0} scaleS={80} atS={0} />);
    expect(screen.getByTestId("player-knowledge-nosamples")).toHaveAttribute("title", expect.stringContaining("No belief samples in this recording profile"));
    expect(screen.getByTestId("player-knowledge-band")).toHaveAttribute("data-empty", "true");
  });

  it("draws the disagreement as its own area and puts the reflex and the failure on the top edge, each with what it is", () => {
    render(<KnowledgeStrip band={BAND} marks={[reflex, failure]} runId="run-1" startS={0} scaleS={80} atS={70} />);
    expect(screen.getByTestId("player-knowledge-disagree")).toBeInTheDocument();
    const flags = screen.getAllByTestId("player-flag");
    expect(flags.map((f) => f.getAttribute("data-flag")).sort()).toEqual(["failure", "reflex"]);
    expect(flags.find((f) => f.getAttribute("data-flag") === "failure")).toHaveAttribute("title", "ugv-002 unreachable at 41.0 s");
  });
});
