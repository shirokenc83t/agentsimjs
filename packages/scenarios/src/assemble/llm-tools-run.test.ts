import { runLockstep, type ComputeOutcome } from "@agentsim/core";
import { DEFAULT_PROMPT_TEMPLATE, MemoryMindCache, ScriptedProvider, type MindCache, type ProviderPort, type ScriptedAnswer } from "@agentsim/minds";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { MindLibrary } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun } from "../testing/preset-run.ts";

// F4 M2 (T-114): a mind that calls the compute tools while it decides, in a real run (F2 discovery, the UAV `scout` as an s2 mind): the chain request → model call → tool → model call → decision → start,
// the replay of the whole looped run from its cache with no call and an identical trace, and a replay whose tool result differs from the recorded one.

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
type Run = ReturnType<typeof buildPresetRun>;

const usage = { inputTokens: 200, outputTokens: 20 };
const ok = (obj: unknown): ScriptedAnswer => ({ content: JSON.stringify(obj), usage, latencyMs: 30 });
const IDLE = ok({ action: "idle" });
const STEPS = [
  { action: "takeoff", params: { altitudeM: 20 } },
  { action: "goTo", params: { xM: 40, yM: 20 } },
  { action: "returnToBase", params: {} },
];
const ADVANCES = /"kind":"(start|actionCompleted|actionFailed|actionRejected)"/;

/** On an event that moves the mission on: first ask for tools (when the last message is not a tool's answer), then give the next step; idle for the other events. */
function tooling(askFor: (step: number) => { name: string; params: unknown }[]): ScriptedProvider {
  let n = 0;
  return new ScriptedProvider((req) => {
    if (req.messages.at(-1)?.role === "tool") return ok(STEPS[n++] ?? { action: "idle" });
    if (!ADVANCES.test(req.messages[1]?.content ?? "")) return IDLE;
    const calls = askFor(n);
    return calls.length === 0 ? ok(STEPS[n++] ?? { action: "idle" }) : { toolCalls: calls, usage, latencyMs: 30 };
  });
}

const library = (tools: Record<string, unknown> = {}): MindLibrary => ({
  profile: () => ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local", model: "test-model", promptTemplate: { id: "default", version: 1 }, tools } }) as never,
  template: () => DEFAULT_PROMPT_TEMPLATE,
});
const config = (mode?: string): Partial<RunConfigDocument> =>
  ({ ...(mode === undefined ? {} : { mindsRunMode: mode }), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "Fly the steps you are given." } } } } }) as unknown as Partial<RunConfigDocument>;

function build(o: { mode?: string; provider: ProviderPort; cache: MindCache; tools?: Record<string, unknown> }): Run {
  return buildPresetRun({
    preset: "f2-discovery",
    scripts: {},
    runConfig: config(o.mode),
    resolve: { library: library(o.tools), providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434" }) },
    minds: { providers: () => o.provider, cache: o.cache, now: () => 0 },
  });
}

const finished = (run: Run) => run.trace.all().some((r) => r.kind === "action" && payloadOf(r).op === "end" && payloadOf(r).name === "returnToBase");
async function go(run: Run, done: () => boolean = () => finished(run), maxTicks = 6000): Promise<void> {
  for (let t = 0; t < maxTicks && !done(); t += 10) await runLockstep(run.world, run.scheduler, 10);
}
const sameTrace = (run: Run) =>
  run.trace.all().map((r) => {
    const p = payloadOf(r);
    if (p.op !== "llm-call") return { ...r, wallTime: 0 };
    const { cacheHit: _hit, ...rest } = p;
    return { ...r, wallTime: 0, payload: rest };
  });

const ASK = (n: number) => (n === 1 ? [{ name: "estimateCost", params: { route: [{ xM: 40, yM: 20 }, "home"] } }, { name: "planPath", params: { to: { xM: 40, yM: 20 } } }] : []);

describe("a run whose mind calls compute tools (F4 M2)", () => {
  it("writes the chain request → model call → tool records → model call → decision → start, the tools being the world's answers from the agent's own map", async () => {
    const provider = tooling(ASK);
    const run = build({ provider, cache: new MemoryMindCache() });
    await go(run);
    const all = run.trace.all();
    const byId = new Map(all.map((r) => [r.id, r]));
    const tools = all.filter((r) => r.kind === "compute" && payloadOf(r).op === "tool");
    expect(tools.map((t) => payloadOf(t).tool)).toEqual(["estimateCost", "planPath"]);
    expect(tools.every((t) => payloadOf(t).ok === true && payloadOf(t).status === "found")).toBe(true);
    const asked = byId.get(tools[0]?.parentId ?? "");
    expect(payloadOf(asked as TraceRecord).op).toBe("llm-call");
    expect(tools[1]?.parentId).toBe(tools[0]?.parentId);
    const request = byId.get(asked?.parentId ?? "");
    expect(payloadOf(request as TraceRecord).op).toBe("request");
    // The second call of that decision is also a child of the request, and the decision (caused by the request) is followed by the action's start.
    const calls = all.filter((r) => payloadOf(r).op === "llm-call" && r.parentId === request?.id);
    expect(calls).toHaveLength(2);
    const decision = all.find((r) => payloadOf(r).op === "decision" && (r.causeIds ?? []).includes(request?.id ?? ""));
    expect(decision).toBeDefined();
    expect(payloadOf(decision as TraceRecord).mind).toMatchObject({ attempts: 2 });
    expect(all.find((r) => r.kind === "action" && payloadOf(r).op === "start" && payloadOf(r).name === "goTo" && (r.causeIds ?? []).includes(decision?.id ?? ""))).toBeDefined();
    // The second model call saw what the tools said (the result of planPath is in its messages).
    const messages = JSON.stringify(payloadOf(calls[1] as TraceRecord).messages);
    expect(messages).toContain("lengthM");
    expect(provider.requests.some((r) => r.tools?.some((t) => t.name === "planPath"))).toBe(true);
  });

  it("replay-strict of the whole looped run makes no call, gives the identical trace (tool records included) and the same hashes", async () => {
    const cache = new MemoryMindCache();
    const live = build({ provider: tooling(ASK), cache });
    await go(live);
    const none = new ScriptedProvider([]);
    const replay = build({ mode: "replay-strict", provider: none, cache });
    await go(replay, () => replay.world.tick >= live.world.tick);
    expect(none.calls).toBe(0);
    expect(replay.world.stateHash).toBe(live.world.stateHash);
    expect(sameTrace(replay)).toEqual(sameTrace(live));
    expect(replay.trace.all().filter((r) => r.kind === "compute" && payloadOf(r).op === "tool")).toHaveLength(2);
  });

  it("a replay whose tool result differs from the recorded one stops the run as divergent", async () => {
    const cache = new MemoryMindCache();
    const live = build({ provider: tooling(ASK), cache });
    await go(live);
    const replay = build({ mode: "replay-strict", provider: new ScriptedProvider([]), cache });
    // The planted mismatch: the planner of the replaying run answers another length than the recorded run's.
    const real = replay.compute.call.bind(replay.compute);
    (replay.compute as { call: typeof real }).call = (agentId, tool, params, req): ComputeOutcome => {
      const out = real(agentId, tool, params, req);
      return out.ok && tool === "planPath" ? { ...out, result: { ...out.result, lengthM: (out.result["lengthM"] as number) + 1 } } : out;
    };
    await expect(go(replay)).rejects.toThrow(/replay_divergent/);
  });

  it("the same looped run twice gives the same hashes and trace (determinism)", async () => {
    const a = build({ provider: tooling(ASK), cache: new MemoryMindCache() });
    const b = build({ provider: tooling(ASK), cache: new MemoryMindCache() });
    await go(a);
    await go(b, () => b.world.tick >= a.world.tick);
    expect(b.world.stateHash).toBe(a.world.stateHash);
    expect(sameTrace(b)).toEqual(sameTrace(a));
  });

  it("with maxCallsPerDecision 0 the mind is offered no tool and makes no tool record", async () => {
    const provider = tooling(ASK);
    const run = build({ provider, cache: new MemoryMindCache(), tools: { maxCallsPerDecision: 0 } });
    await go(run);
    expect(provider.requests.every((r) => r.tools === undefined)).toBe(true);
    expect(run.trace.all().some((r) => r.kind === "compute" && payloadOf(r).op === "tool")).toBe(false);
  });
});
