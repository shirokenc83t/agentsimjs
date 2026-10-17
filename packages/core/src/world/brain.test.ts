import { describe, expect, it } from "vitest";
import { ScriptBrain, type Brain, type BrainTier, type DecisionRequest } from "./brain.ts";
import type { DecisionEvent } from "./events.ts";
import { EMPTY_MIND_VIEW } from "./mind-view.ts";
import { mindSlot } from "./world.ts";

const brain = (tier: BrainTier): Brain => ({ id: `b-${tier}`, tier, decide: () => Promise.resolve({ decision: { kind: "idle" } }) });

const request = (...events: DecisionEvent[]): DecisionRequest => ({
  agentId: "ugv-001",
  tick: 0,
  simTimeS: 0,
  events,
  eventsDropped: 0,
  self: { kind: "ugv", xM: 0, yM: 0, headingRad: 0, soc: 1, running: null, timers: [] },
  beliefs: EMPTY_MIND_VIEW.beliefs,
  space: EMPTY_MIND_VIEW.space,
  allowedActions: [],
  unavailable: [],
});

describe("mind slots (ADR-0031 clarification of 2026-10-04)", () => {
  it("scripts, baselines and S1 minds occupy s1; LLMs and external agents occupy s2", () => {
    expect((["S1", "script", "baseline", "S2", "external"] as const).map((t) => mindSlot(brain(t)))).toEqual(["S1", "S1", "S1", "S2", "S2"]);
  });
});

describe("ScriptBrain (the baseline brain)", () => {
  const started = request({ kind: "start" });

  it("returns its steps in order at start / actionCompleted / actionFailed / actionRejected, then stays idle", async () => {
    const b = new ScriptBrain("s", [
      { name: "hold", params: {} },
      { name: "hold", params: { durationS: 1 } },
      { name: "hold", params: { durationS: 2 } },
      { name: "hold", params: { durationS: 3 } },
    ]);
    expect(await b.decide(started)).toEqual({ decision: { kind: "action", name: "hold", params: {} } });
    expect((await b.decide(request({ kind: "actionCompleted", actionId: "a", name: "hold", result: {} }))).decision.kind).toBe("action");
    expect((await b.decide(request({ kind: "actionFailed", actionId: "a", name: "hold", status: "failed", code: "collision" }))).decision.kind).toBe("action");
    expect((await b.decide(request({ kind: "actionRejected", name: "hold", code: "invalid_params" }))).decision.kind).toBe("action");
    expect(await b.decide(started)).toEqual({ decision: { kind: "idle" } }); // exhausted
    expect(b.position).toBe(4);
  });

  it("does not advance at any other event: it answers idle and leaves the running action alone", async () => {
    const b = new ScriptBrain("s", [{ name: "hold", params: {} }]);
    for (const e of [
      { kind: "batteryLow", soc: 0.3, level: 0.3 },
      { kind: "timer", tag: "t" },
      { kind: "frontierExhausted" },
      { kind: "lost", entityId: "o", entityKind: "target", lastSeenS: 1, transitions: 1 },
      { kind: "detected", entityId: "o", entityKind: "target", xM: 1, yM: 1, zM: 0, observedAtS: 1, transitions: 1 },
    ] as const) {
      expect(await b.decide(request(e))).toEqual({ decision: { kind: "idle" } });
    }
    expect(b.position).toBe(0);
    // A request mixing perception and a control event advances once.
    expect((await b.decide(request({ kind: "detected", entityId: "o", entityKind: "target", xM: 1, yM: 1, zM: 0, observedAtS: 1, transitions: 1 }, started.events[0] as DecisionEvent))).decision.kind).toBe("action");
    expect(b.position).toBe(1);
  });
});
