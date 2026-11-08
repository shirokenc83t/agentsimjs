import { runLockstep, type Brain, type DecisionEnvelope, type DecisionRequest } from "@agentsim/core";
import { DEFAULT_PROMPT_TEMPLATE, LlmBrain, MemoryMindCache, ScriptedProvider, resolveS2, type MindsRunMode, type ScriptedAnswer } from "@agentsim/minds";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildPresetRun } from "../testing/preset-run.ts";

// F4 M1: the LLM mind on the F2 scene with the scripted provider (no network, no key). A multi-step run gives the same hashes twice; an answer that does not validate is retried and then falls back,
// all in the trace with its links; and an LLM mind gets exactly the request a script mind gets.

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
type Run = ReturnType<typeof buildPresetRun>;

const { sources: _sources, ...EFFECTIVE } = resolveS2({ provider: "local", model: "test-model", promptTemplate: { id: "default", version: 1 } }, undefined);

const ok = (obj: unknown): ScriptedAnswer => ({ content: JSON.stringify(obj), usage: { inputTokens: 200, outputTokens: 20 }, latencyMs: 30 });
const IDLE = ok({ action: "idle" });

/** A provider that gives the next scripted answer when the request carries an event that ends or starts an action, and idle for any other event (the mind is asked on perception events too). */
function steps(list: readonly unknown[]): ScriptedProvider {
  let n = 0;
  return new ScriptedProvider((req) => (/"kind":"(start|actionCompleted|actionFailed|actionRejected)"/.test(req.messages[1]?.content ?? "") ? (n < list.length ? ok(list[n++]) : IDLE) : IDLE));
}

function brainFor(provider: ScriptedProvider, cache = new MemoryMindCache(), mode: MindsRunMode = "live", over: Partial<ConstructorParameters<typeof LlmBrain>[0]> = {}) {
  return new LlmBrain({ id: "llm-test", effective: EFFECTIVE, template: DEFAULT_PROMPT_TEMPLATE, mission: "Fly the steps you are given.", provider, cache, mode, now: () => 0, ...over });
}

const starts = (run: Run) => run.trace.all().filter((r) => r.kind === "action" && payloadOf(r).op === "start" && r.agentId === "uav-001");
const traceOf = (run: Run) => run.trace.all().map((r) => ({ ...r, wallTime: 0 }));

/** Steps the run until `done()` or `maxTicks`, in lockstep, collecting the state hash at every 50 ticks. */
async function go(run: Run, done: () => boolean, maxTicks = 6000): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  for (let t = 0; t < maxTicks && !done(); t += 10) {
    await runLockstep(run.world, run.scheduler, 10);
    if (run.world.tick % 50 === 0) hashes.set(run.world.tick, run.world.stateHash);
  }
  return hashes;
}

const MISSION = [
  { action: "takeoff", params: { altitudeM: 20 } },
  { action: "goTo", params: { xM: 40, yM: 20 }, note: { text: "went to B", mode: "replace" }, rationale: "B first" },
  { action: "returnToBase", params: {}, note: { text: ", then home", mode: "append" } },
];

async function mission() {
  const provider = steps(MISSION);
  const brain = brainFor(provider);
  const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, brains: { scout: brain } });
  const hashes = await go(run, () => starts(run).length >= 3 && run.trace.all().some((r) => r.kind === "action" && payloadOf(r).op === "end" && payloadOf(r).name === "returnToBase"));
  return { run, brain, provider, hashes };
}

describe("a scripted multi-step run: take off, go to a point, note, return", () => {
  it("starts each action the model chose, in order, each caused by its decision, and the notebook holds what the notes made of it", async () => {
    const { run, brain } = await mission();
    expect(starts(run).map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "returnToBase"]);
    const decisions = run.trace.all().filter((r) => r.kind === "thought" && payloadOf(r).op === "decision" && r.agentId === "uav-001");
    for (const s of starts(run)) {
      const cause = s.causeIds?.[0];
      expect(decisions.map((d) => d.id)).toContain(cause);
    }
    const notes = run.trace.all().filter((r) => r.kind === "event" && payloadOf(r).op === "note");
    expect(notes.map((r) => [payloadOf(r).mode, payloadOf(r).text, payloadOf(r).chars])).toEqual([
      ["replace", "went to B", 9],
      ["append", ", then home", 20],
    ]);
    expect(brain.usage.calls).toBeGreaterThanOrEqual(3);
  });

  it("gives the same hashes and the same trace twice", async () => {
    const a = await mission();
    const b = await mission();
    expect(a.hashes.size).toBeGreaterThan(0);
    expect([...b.hashes]).toEqual([...a.hashes]);
    expect(traceOf(b.run)).toEqual(traceOf(a.run));
    expect(a.run.world.stateHash).toBe(b.run.world.stateHash);
  });

  it("writes the records of the ReAct loop, linked: the request, a call as its child, the decision caused by the request, the action's start caused by the decision", async () => {
    const { run } = await mission();
    const all = run.trace.all().filter((r) => r.agentId === "uav-001");
    const first = all.find((r) => r.kind === "thought" && payloadOf(r).op === "request") as TraceRecord;
    const call = all.find((r) => r.kind === "thought" && payloadOf(r).op === "llm-call") as TraceRecord;
    const decision = all.find((r) => r.kind === "thought" && payloadOf(r).op === "decision") as TraceRecord;
    expect(call.parentId).toBe(first.id);
    expect(call.source).toBe("uav-001/s2");
    expect(payloadOf(call)).toMatchObject({ attempt: 1, model: "test-model", outcome: "ok", cacheHit: false, usage: { inputTokens: 200, outputTokens: 20 } });
    expect(decision.causeIds).toEqual([first.id]);
    expect(payloadOf(decision)).toMatchObject({ tier: "S2", brainKind: "S2", mind: { attempts: 1 } });
    const start = all.find((r) => r.kind === "action" && payloadOf(r).op === "start") as TraceRecord;
    expect(start.causeIds).toEqual([decision.id]);
  });
});

describe("an answer that does not validate", () => {
  it("is retried, then falls back to hold: both calls, the fallback and the decision are in the trace, with their links", async () => {
    const provider = new ScriptedProvider([{ content: "I would rather not." }, { content: '{"action":"fly"}' }]);
    const brain = brainFor(provider);
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, brains: { rover: brain } });
    await runLockstep(run.world, run.scheduler, 5);
    expect(provider.calls).toBeGreaterThanOrEqual(2);
    const mine = run.trace.all().filter((r) => r.agentId === "ugv-001" && r.source === "ugv-001/s2");
    const request = mine.find((r) => payloadOf(r).op === "request") as TraceRecord;
    const calls = mine.filter((r) => payloadOf(r).op === "llm-call").slice(0, 2);
    expect(calls.map((c) => [payloadOf(c).attempt, payloadOf(c).outcome])).toEqual([[1, "invalid"], [2, "invalid"]]);
    expect(calls.every((c) => c.parentId === request.id)).toBe(true);
    const fallback = mine.find((r) => payloadOf(r).op === "fallback") as TraceRecord;
    expect(fallback.causeIds).toEqual([calls[1]?.id]);
    const decision = mine.find((r) => payloadOf(r).op === "decision") as TraceRecord;
    expect(payloadOf(decision)).toMatchObject({ decision: { kind: "action", name: "hold" }, mind: { attempts: 2, fallback: expect.any(String) } });
    expect(String(payloadOf(decision).rationale)).toContain("fallback after 2 attempts");
    expect(decision.causeIds).toEqual([request.id]);
  });
});

describe("fairness between minds (ADR-0005, ADR-0036 section 8)", () => {
  class Spy implements Brain {
    readonly tier: Brain["tier"];
    readonly seen: string[] = [];
    constructor(
      readonly id: string,
      tier: Brain["tier"],
      private readonly inner: (req: DecisionRequest) => Promise<DecisionEnvelope>,
    ) {
      this.tier = tier;
    }
    decide(req: DecisionRequest) {
      this.seen.push(JSON.stringify(req));
      return this.inner(req);
    }
  }

  it("an LLM mind and a script mind in the same situation receive byte-identical requests", async () => {
    // Both wake themselves every second with a timer, so each is asked again and again in the same situation.
    const script = new Spy("script", "script", () => Promise.resolve({ decision: { kind: "idle" }, timers: [{ op: "set", tag: "wake", delayS: 1 }] }));
    // (The default limit is 20 calls and pauses the run: this one asks every second, so it is given room.)
    const llm = brainFor(new ScriptedProvider(() => ok({ action: "idle", timers: [{ op: "set", tag: "wake", delayS: 1 }] })), undefined, "live", { effective: { ...EFFECTIVE, limits: { ...EFFECTIVE.limits, calls: 1000 } } });
    const spy = new Spy("llm-spy", "S2", (req) => llm.decide(req));
    const a = buildPresetRun({ preset: "f2-discovery", scripts: {}, brains: { scout: script } });
    const b = buildPresetRun({ preset: "f2-discovery", scripts: {}, brains: { scout: spy } });
    await runLockstep(a.world, a.scheduler, 300);
    await runLockstep(b.world, b.scheduler, 300);
    expect(script.seen.length).toBeGreaterThan(1);
    expect(spy.seen).toEqual(script.seen);
    expect(b.world.stateHash).toBe(a.world.stateHash);
  });
});
