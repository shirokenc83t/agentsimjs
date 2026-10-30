import type { DecisionRequest, TraceSink } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { answerSchema, parseAnswer } from "./answer.ts";
import { MemoryMindCache, cacheKey } from "./cache.ts";
import { DEFAULT_PROMPT_TEMPLATE, MIND_DEFAULTS, type EffectiveS2 } from "./documents.ts";
import { LlmBrain, MindError, type LlmBrainOptions } from "./llm-brain.ts";
import { buildPrompt } from "./prompt.ts";
import { ScriptedProvider, type ScriptedAnswer } from "./provider.ts";
import { contentHash64 } from "@agentsim/core";
import { canonicalJson } from "./canonical.ts";
const contentHashOf = (v: unknown): string => contentHash64(canonicalJson(v));

// The System 2 mind with the scripted provider (no network, no key): the prompt, the answer schema, the loop of attempts, the cache and the records it writes.

const HOLD = { type: "object", additionalProperties: false, properties: {} };
const GOTO = { type: "object", additionalProperties: false, required: ["xM", "yM"], properties: { xM: { type: "number" }, yM: { type: "number" } } };

function request(over: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    agentId: "ugv-001",
    tick: 12,
    simTimeS: 1.2,
    events: [{ kind: "start" } as never],
    eventsDropped: 0,
    self: { kind: "ugv", xM: 1, yM: 2, headingRad: 0, soc: 1, running: null, timers: [] },
    beliefs: { entities: [], map: { knownFrac: 0.1 } } as never,
    space: { regions: [] } as never,
    allowedActions: [
      { name: "goTo", paramsSchema: GOTO },
      { name: "hold", paramsSchema: HOLD },
    ] as never,
    unavailable: [{ name: "land", code: "vehicle_unsupported" }] as never,
    ...over,
  } as DecisionRequest;
}

const effective = (over: Partial<Omit<EffectiveS2, "sources">> = {}): Omit<EffectiveS2, "sources"> => ({
  provider: "local",
  model: "m1",
  params: { temperature: 0 },
  promptTemplate: { id: "default", version: 1 },
  tools: { maxCallsPerDecision: MIND_DEFAULTS.tools.maxCallsPerDecision },
  context: { decisions: 5 },
  limits: { ...MIND_DEFAULTS.limits },
  latency: { model: "measured" },
  ...over,
});

function setup(script: readonly ScriptedAnswer[] | ((r: never, n: number) => ScriptedAnswer), o: Partial<LlmBrainOptions> = {}) {
  const provider = new ScriptedProvider(script as never);
  const cache = new MemoryMindCache();
  const records: { id: string; r: Parameters<TraceSink["emit"]>[0] }[] = [];
  const trace: TraceSink = {
    emit(r) {
      const id = `run-000001#${records.length}`;
      records.push({ id, r });
      return id;
    },
  };
  const brain = new LlmBrain({ id: "llm-1", effective: effective(), template: DEFAULT_PROMPT_TEMPLATE, mission: "Hold position.", provider, cache, mode: "live", now: () => 1000, ...o });
  return { provider, cache, records, trace, brain };
}

const payload = (r: { r: { payload: unknown } }) => r.r.payload as Record<string, unknown>;
const ok = (obj: unknown, extra: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({ content: JSON.stringify(obj), usage: { inputTokens: 100, outputTokens: 10 }, latencyMs: 40, ...extra }) as ScriptedAnswer;

describe("the answer schema and its validation", () => {
  const allowed = request().allowedActions;
  const schema = answerSchema(allowed);

  it("accepts one allowed action with its parameters, or idle, with timers, a note and a rationale", () => {
    expect(parseAnswer('{"action":"goTo","params":{"xM":5,"yM":6}}', schema)).toEqual({ ok: true, value: { decision: { kind: "action", name: "goTo", params: { xM: 5, yM: 6 } } } });
    expect(parseAnswer('{"action":"idle","rationale":"wait","note":{"text":"hi","mode":"append"},"timers":[{"op":"set","tag":"wake","delayS":3}]}', schema)).toEqual({
      ok: true,
      value: { decision: { kind: "idle" }, rationale: "wait", note: { text: "hi", mode: "append" }, timers: [{ op: "set", tag: "wake", delayS: 3 }] },
    });
    expect(parseAnswer('```json\n{"action":"hold","params":{}}\n```', schema).ok).toBe(true);
  });

  it("refuses an action that is not allowed, parameters that do not fit, and text that is not JSON, with a message the model can act on", () => {
    expect(parseAnswer('{"action":"land","params":{}}', schema)).toMatchObject({ ok: false });
    const bad = parseAnswer('{"action":"goTo","params":{"xM":"far","yM":6}}', schema);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toContain('for action "goTo"');
    expect(parseAnswer("I will go to the north", schema)).toMatchObject({ ok: false, message: "the answer is not JSON" });
    expect(parseAnswer('{"action":"goTo","params":{"xM":1,"yM":2},"surprise":1}', schema).ok).toBe(false);
  });
});

describe("the prompt", () => {
  it("is the same bytes for the same request, mission and history, and carries what the template's slots ask for, in its order", () => {
    const input = { template: DEFAULT_PROMPT_TEMPLATE, mission: "Inspect B.", request: request(), history: [{ tick: 3, simTimeS: 0.3, chose: "hold {}" }] };
    expect(JSON.stringify(buildPrompt(input))).toBe(JSON.stringify(buildPrompt(input)));
    const [sys, user] = buildPrompt(input);
    expect(sys?.role).toBe("system");
    expect(sys?.content).toBe(DEFAULT_PROMPT_TEMPLATE.system);
    const text = user?.content ?? "";
    const at = (s: string) => text.indexOf(`## ${s}`);
    expect([at("Who you are"), at("Your mission"), at("Your notebook"), at("Your last decisions"), at("Your state"), at("What you believe"), at("The space around you"), at("What just happened"), at("What you can do")].every((x, i, a) => x >= 0 && (i === 0 || x > (a[i - 1] as number)))).toBe(true);
    expect(text).toContain("Inspect B.");
    expect(text).toContain("(empty)");
    expect(text).toContain("t=0.3 s: hold {}");
    expect(text).toContain("goTo: parameters");
    expect(text).toContain("land (vehicle_unsupported)");
  });

  it("carries the notebook when there is one, and a template that names fewer sections leaves the others out", () => {
    const r = request({ self: { ...request().self, notebook: "visit B then C" } });
    const t = { ...DEFAULT_PROMPT_TEMPLATE, sections: ["notebook", "actions"] as never, instructions: { notebook: "Read this first." } };
    const text = buildPrompt({ template: t, mission: undefined, request: r, history: [] })[1]?.content ?? "";
    expect(text).toContain("## Your notebook\nRead this first.\nvisit B then C");
    expect(text).not.toContain("Your mission");
  });
});

describe("a decision", () => {
  it("is one call when the answer is valid: the action, a record of the call as a child of the request, the answer cached, and what it cost", async () => {
    const { brain, provider, cache, records, trace } = setup([ok({ action: "goTo", params: { xM: 5, yM: 6 }, rationale: "to B" })]);
    const env = await brain.decide(request(), { requestRecordId: "run-000001#7", trace });
    expect(env.decision).toEqual({ kind: "action", name: "goTo", params: { xM: 5, yM: 6 } });
    expect(env.rationale).toBe("to B");
    expect(env.mind).toMatchObject({ attempts: 1, usage: { inputTokens: 100, outputTokens: 10 }, latencyMs: 40 });
    expect(provider.calls).toBe(1);
    expect(cache.entries.size).toBe(1);
    const [entry] = [...cache.entries.values()];
    expect(entry).toMatchObject({ model: "m1", providerKind: "openai-compatible", outcome: "ok", latencyMs: 40, usage: { inputTokens: 100, outputTokens: 10 }, createdAtWallMs: 1000 });
    expect(records).toHaveLength(1);
    expect(records[0]?.r).toMatchObject({ kind: "thought", tier: "S2", source: "ugv-001/s2", agentId: "ugv-001", parentId: "run-000001#7", detail: "full" });
    expect(payload(records[0] as never)).toMatchObject({ op: "llm-call", attempt: 1, model: "m1", cacheHit: false, outcome: "ok", latencyMs: 40, providerKind: "openai-compatible" });
    expect(payload(records[0] as never)["messages"]).toHaveLength(2);
    expect(brain.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10, costUsd: 0 });
  });

  it("retries an answer that does not validate, telling the model why, and then falls back to hold with a record that names the last call", async () => {
    const { brain, provider, records, trace } = setup([ok({ action: "fly" }), { content: "not json at all", usage: { inputTokens: 120, outputTokens: 4 } }]);
    const env = await brain.decide(request(), { requestRecordId: "run-000001#7", trace });
    expect(provider.calls).toBe(2); // retries default to 1: two attempts
    const second = provider.requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[3]?.content).toContain("Your answer was not accepted");
    expect(env.decision).toEqual({ kind: "action", name: "hold", params: {} });
    expect(env.mind).toMatchObject({ attempts: 2, fallback: "the answer is not JSON" });
    expect(env.rationale).toContain("fallback after 2 attempts");
    expect(records.map((r) => payload(r)["op"])).toEqual(["llm-call", "llm-call", "fallback"]);
    expect(payload(records[0] as never)["outcome"]).toBe("invalid");
    expect(payload(records[0] as never)["validationError"]).toBeDefined();
    expect(records[2]?.r.causeIds).toEqual([records[1]?.id]);
    expect(payload(records[2] as never)).toMatchObject({ reason: "the answer is not JSON", attempts: 2, decision: "hold" });
  });

  it("retries a timeout or a server error the same way, up to limits.retries (0 means one attempt, 3 means four)", async () => {
    const r0 = setup([{ fail: "timeout", error: "no answer in 60 s" }], { effective: effective({ limits: { ...MIND_DEFAULTS.limits, retries: 0 } }) });
    expect((await r0.brain.decide(request(), { trace: r0.trace })).mind).toMatchObject({ attempts: 1, fallback: "no answer in 60 s" });
    const r3 = setup([{ fail: "error", error: "502" }, { fail: "error", error: "502" }, { fail: "timeout" }, ok({ action: "idle" })], { effective: effective({ limits: { ...MIND_DEFAULTS.limits, retries: 3 } }) });
    const env = await r3.brain.decide(request(), { trace: r3.trace });
    expect(env.decision).toEqual({ kind: "idle" });
    expect(env.mind).toMatchObject({ attempts: 4 });
    expect(r3.records.map((x) => [payload(x)["attempt"], payload(x)["outcome"]])).toEqual([[1, "error"], [2, "error"], [3, "timeout"], [4, "ok"]]);
  });

  it("falls back to idle, not hold, when the agent is a landed UAV or cannot hold", async () => {
    const landed = request({ self: { kind: "uav", xM: 0, yM: 0, zM: 0, headingRad: 0, soc: 1, running: null, timers: [] } });
    const a = setup([{ fail: "error" }, { fail: "error" }]);
    expect((await a.brain.decide(landed)).decision).toEqual({ kind: "idle" });
    const b = setup([{ fail: "error" }, { fail: "error" }]);
    expect((await b.brain.decide(request({ allowedActions: [{ name: "goTo", paramsSchema: GOTO }] as never }))).decision).toEqual({ kind: "idle" });
  });

  it("counts characters / 4 when the server reports no usage, and says so; a price gives a cost, no price none", async () => {
    const s = setup([{ content: JSON.stringify({ action: "idle" }) }], { prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    const env = await s.brain.decide(request(), { trace: s.trace });
    const usage = payload(s.records[0] as never)["usage"] as { estimated?: boolean; inputTokens: number; outputTokens: number };
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBe(Math.ceil('{"action":"idle"}'.length / 4));
    expect(env.mind?.["costUsd"]).toBeCloseTo((usage.inputTokens * 3 + usage.outputTokens * 15) / 1e6, 9);
    expect(payload(s.records[0] as never)["costUsd"]).toBeGreaterThan(0);
  });

  it("restricts the offer to the tools the profile allows: the answer schema and the prompt leave the others out", async () => {
    const s = setup([ok({ action: "hold", params: {} })], { effective: effective({ tools: { allow: ["hold"], maxCallsPerDecision: 8 } }) });
    await s.brain.decide(request());
    const sent = s.provider.requests[0];
    expect(JSON.stringify(sent?.answerSchema)).not.toContain('"goTo"');
    expect(sent?.messages[1]?.content).not.toContain("goTo: parameters");
    expect((await setup([ok({ action: "goTo", params: { xM: 1, yM: 2 } }), ok({ action: "idle" })], { effective: effective({ tools: { allow: ["hold"], maxCallsPerDecision: 8 } }) }).brain.decide(request())).mind).toMatchObject({ attempts: 2 });
  });
});

describe("the response cache and the run modes", () => {
  it("keys an attempt by provider kind, model, parameters, the rendered prompt, the tools hash and the attempt: each change is another key", () => {
    const base = { providerKind: "openai-compatible", model: "m", params: { temperature: 0 }, messages: [{ role: "user" as const, content: "hi" }], toolsHash: "aaaaaaaaaaaaaaaa", attempt: 1 };
    const k = cacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(cacheKey({ ...base })).toBe(k);
    for (const change of [{ providerKind: "other" }, { model: "n" }, { params: { temperature: 1 } }, { messages: [{ role: "user" as const, content: "hi!" }] }, { toolsHash: "bbbbbbbbbbbbbbbb" }, { attempt: 2 }]) expect(cacheKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(k);
    // The order of the keys of the parameters does not matter.
    expect(cacheKey({ ...base, params: { temperature: 0, topP: 1 } })).toBe(cacheKey({ ...base, params: { topP: 1, temperature: 0 } }));
  });

  it("replay-strict makes no call and gives the same decision from the cache; a miss stops with cache_miss_strict and writes a record of it", async () => {
    const live = setup([ok({ action: "goTo", params: { xM: 5, yM: 6 } })]);
    const want = await live.brain.decide(request(), { trace: live.trace });
    const strict = setup([], { cache: live.cache, mode: "replay-strict" });
    const got = await strict.brain.decide(request(), { trace: strict.trace });
    expect(got.decision).toEqual(want.decision);
    expect(strict.provider.calls).toBe(0);
    expect(payload(strict.records[0] as never)).toMatchObject({ op: "llm-call", cacheHit: true });
    const miss = setup([], { cache: live.cache, mode: "replay-strict" });
    await expect(miss.brain.decide(request({ tick: 99 }), { trace: miss.trace })).rejects.toMatchObject({ code: "cache_miss_strict" });
    await expect(miss.brain.decide(request({ tick: 99 }))).rejects.toBeInstanceOf(MindError);
    expect(miss.provider.calls).toBe(0);
    expect(miss.records.map((r) => payload(r)["op"])).toEqual(["cache-miss"]);
  });

  it("replay-then-live reads the cache, calls live on a miss, flags the run as not reproducible from that tick (once) and caches the new answer", async () => {
    const told: number[] = [];
    const live = setup([ok({ action: "idle" })]);
    await live.brain.decide(request(), { trace: live.trace });
    const mixed = setup([ok({ action: "hold", params: {} }), ok({ action: "idle" })], { cache: live.cache, mode: "replay-then-live", onNotReproducible: (t) => told.push(t) });
    expect((await mixed.brain.decide(request(), { trace: mixed.trace })).decision).toEqual({ kind: "idle" }); // a hit
    expect(mixed.provider.calls).toBe(0);
    expect(told).toEqual([]);
    expect((await mixed.brain.decide(request({ tick: 50 }), { trace: mixed.trace })).decision).toEqual({ kind: "action", name: "hold", params: {} }); // a miss: live
    expect((await mixed.brain.decide(request({ tick: 60 }), { trace: mixed.trace })).decision).toEqual({ kind: "idle" });
    expect(told).toEqual([50]);
    expect(mixed.records.filter((r) => payload(r)["op"] === "not-reproducible").map((r) => payload(r)["fromTick"])).toEqual([50]);
    expect(mixed.brain.snapshotState().notReproducibleFromTick).toBe(50);
  });

  it("keeps its history and its use of the limits in a snapshot, and puts them back", async () => {
    const a = setup([ok({ action: "hold", params: {}, rationale: "wait" }), ok({ action: "idle" })]);
    await a.brain.decide(request(), { trace: a.trace });
    const state = JSON.parse(JSON.stringify(a.brain.snapshotState())) as ReturnType<typeof a.brain.snapshotState>;
    expect(state.calls).toBe(1);
    expect(state.history).toEqual([{ tick: 12, simTimeS: 1.2, chose: "hold {}", rationale: "wait" }]);
    const b = setup([ok({ action: "idle" })]);
    b.brain.restoreState(state);
    expect(b.brain.usage.calls).toBe(1);
    await b.brain.decide(request({ tick: 20, simTimeS: 2 }));
    expect(b.provider.requests[0]?.messages[1]?.content).toContain("t=1.2 s: hold {} — wait");
  });
});

describe("the limits of a run (ADR-0044 section 5): they pause, they do not fall back", () => {
  const withLimits = (limits: Partial<EffectiveS2["limits"]>) => effective({ limits: { ...MIND_DEFAULTS.limits, ...limits } });
  const hits = () => {
    const seen: unknown[] = [];
    const warned: unknown[] = [];
    return { seen, warned };
  };

  it("pauses before the call that would pass the call limit: the notice names the limit and what was used, the record says so, and a stop ends the run with limit_reached", async () => {
    const h = hits();
    const s = setup([ok({ action: "idle" }), ok({ action: "idle" }), ok({ action: "idle" })], {
      effective: withLimits({ calls: 2 }),
      hooks: { onLimitHit: (e) => { h.seen.push(e); return Promise.resolve({ action: "stop" as const }); } },
    });
    await s.brain.decide(request(), { trace: s.trace });
    await s.brain.decide(request({ tick: 13 }), { trace: s.trace });
    await expect(s.brain.decide(request({ tick: 14 }), { trace: s.trace })).rejects.toMatchObject({ code: "limit_reached" });
    expect(s.provider.calls).toBe(2); // the third call was never made
    expect(h.seen).toEqual([{ agentId: "ugv-001", limit: "calls", used: 2, max: 2, tick: 14 }]);
    const hit = s.records.find((r) => payload(r)["op"] === "limit-hit");
    expect(payload(hit as never)).toMatchObject({ op: "limit-hit", limit: "calls", used: 2, max: 2, tick: 14 });
  });

  it("a run that stops with no gate at all (headless) ends the same way", async () => {
    const s = setup([ok({ action: "idle" }), ok({ action: "idle" })], { effective: withLimits({ calls: 1 }) });
    await s.brain.decide(request(), { trace: s.trace });
    await expect(s.brain.decide(request({ tick: 13 }), { trace: s.trace })).rejects.toMatchObject({ code: "limit_reached" });
  });

  it("goes on after a raise: the new value is recorded with the one before it (a `raiseLimit` record), the limit is the raised one from then on, and the call is made", async () => {
    const s = setup([ok({ action: "idle" }), ok({ action: "idle" }), ok({ action: "idle" })], {
      effective: withLimits({ calls: 1 }),
      hooks: { onLimitHit: () => Promise.resolve({ action: "raise" as const, value: 3 }) },
    });
    await s.brain.decide(request(), { trace: s.trace });
    const env = await s.brain.decide(request({ tick: 13 }), { trace: s.trace });
    expect(env.decision).toEqual({ kind: "idle" });
    expect(s.provider.calls).toBe(2);
    const raised = s.records.find((r) => payload(r)["op"] === "raiseLimit");
    expect(raised?.r).toMatchObject({ kind: "lifecycle", source: "ugv-001/s2" });
    expect(payload(raised as never)).toMatchObject({ op: "raiseLimit", limit: "calls", before: 1, after: 3, tick: 13 });
    // The raised limit is kept (the next call is within it) and is part of the state a snapshot carries.
    await s.brain.decide(request({ tick: 14 }), { trace: s.trace });
    expect(s.provider.calls).toBe(3);
    expect(s.brain.snapshotState()).toMatchObject({ raised: { calls: 3 } });
    // A raise that is not above the limit is refused: the run stays paused (here it stops, as nothing was raised).
    const t = setup([ok({ action: "idle" })], { effective: withLimits({ calls: 1 }), hooks: { onLimitHit: () => Promise.resolve({ action: "raise" as const, value: 1 }) } });
    await t.brain.decide(request(), { trace: t.trace });
    await expect(t.brain.decide(request({ tick: 13 }), { trace: t.trace })).rejects.toMatchObject({ code: "limit_reached" });
  });

  it("warns once at 80 % of a limit (the record, and the notice), not again, and not for a limit that is far", async () => {
    const h = hits();
    const s = setup((_r, n) => ok({ action: "idle" }, n < 10 ? {} : {}), { effective: withLimits({ calls: 5 }), hooks: { onWarning: (e) => h.warned.push(e) } });
    for (let i = 0; i < 5; i++) await s.brain.decide(request({ tick: 12 + i }), { trace: s.trace });
    const warnings = s.records.filter((r) => payload(r)["op"] === "limit-warning");
    expect(warnings.map((w) => [payload(w)["limit"], payload(w)["used"], payload(w)["max"]])).toEqual([["calls", 4, 5]]);
    expect(h.warned).toEqual([{ agentId: "ugv-001", limit: "calls", used: 4, max: 5, tick: 15, pct: 80 }]);
  });

  it("counts tokens as the server reports them: the warning comes at 80 %, and the call that reaches the limit gives its decision once the pause is over", async () => {
    const h = hits();
    const call = (n: number): ScriptedAnswer => ({ content: JSON.stringify({ action: "idle" }), usage: { inputTokens: n - 100, outputTokens: 100 }, latencyMs: 5 });
    const s = setup([call(900), call(900), call(900), call(900), call(900)], {
      effective: withLimits({ tokens: 4000 }),
      hooks: { onWarning: (e) => h.warned.push(e), onLimitHit: (e) => { h.seen.push(e); return Promise.resolve({ action: "raise" as const, value: 6000 }); } },
    });
    for (let i = 0; i < 4; i++) await s.brain.decide(request({ tick: 12 + i }), { trace: s.trace });
    // 900, 1800, 2700, 3600 tokens: 90 % of 4000 at the fourth call, no hit yet.
    expect(h.warned).toEqual([{ agentId: "ugv-001", limit: "tokens", used: 3600, max: 4000, tick: 15, pct: 90 }]);
    expect(h.seen).toEqual([]);
    // The fifth call brings it to 4500: past the limit, so the run pauses with the decision in hand; after the raise the decision is given.
    const env = await s.brain.decide(request({ tick: 16 }), { trace: s.trace });
    expect(env.decision).toEqual({ kind: "idle" });
    expect(h.seen).toEqual([{ agentId: "ugv-001", limit: "tokens", used: 4500, max: 4000, tick: 16 }]);
    expect(s.brain.snapshotState()).toMatchObject({ raised: { tokens: 6000 } });
  });

  it("counts a cost only when the provider has prices, and stops at the cost limit like the others", async () => {
    const answer = (): ScriptedAnswer => ({ content: JSON.stringify({ action: "idle" }), usage: { inputTokens: 1_000_000, outputTokens: 0 }, latencyMs: 5 });
    // 1 M tokens at 20 USD per M is 20 USD a call against a limit of 25: the second call crosses it.
    const priced = setup([answer(), answer()], { effective: withLimits({ costUsd: 25, tokens: 100_000_000 }), prices: { inputUsdPerMTok: 20, outputUsdPerMTok: 0 } });
    await priced.brain.decide(request(), { trace: priced.trace });
    await expect(priced.brain.decide(request({ tick: 13 }), { trace: priced.trace })).rejects.toMatchObject({ code: "limit_reached" });
    expect(payload(priced.records.find((r) => payload(r)["op"] === "limit-hit") as never)).toMatchObject({ limit: "costUsd", max: 25 });
    // No prices: no cost, so no cost limit (the token limit is far).
    const free = setup([answer(), answer()], { effective: withLimits({ costUsd: 0.0001, tokens: 100_000_000 }) });
    await free.brain.decide(request(), { trace: free.trace });
    await expect(free.brain.decide(request({ tick: 13 }), { trace: free.trace })).resolves.toBeDefined();
  });

  it("keeps what it has used in a snapshot: a fork resumes counting where the original was", async () => {
    const a = setup([ok({ action: "idle" }), ok({ action: "idle" })], { effective: withLimits({ calls: 2 }) });
    await a.brain.decide(request(), { trace: a.trace });
    const b = setup([ok({ action: "idle" }), ok({ action: "idle" })], { effective: withLimits({ calls: 2 }) });
    b.brain.restoreState(JSON.parse(JSON.stringify(a.brain.snapshotState())));
    await b.brain.decide(request({ tick: 13 }), { trace: b.trace });
    await expect(b.brain.decide(request({ tick: 14 }), { trace: b.trace })).rejects.toMatchObject({ code: "limit_reached" });
  });
});

describe("the tool-call loop (F4 M2, T-114)", () => {
  const withLimits = (limits: Partial<EffectiveS2["limits"]>) => effective({ limits: { ...MIND_DEFAULTS.limits, ...limits } });
  const calls = (...c: { name: string; params: unknown }[]): ScriptedAnswer => ({ toolCalls: c, usage: { inputTokens: 100, outputTokens: 10 }, latencyMs: 40 }) as ScriptedAnswer;
  const GO = ok({ action: "goTo", params: { xM: 9, yM: 9 } });
  /** A compute stub: planPath and estimateCost succeed with figures, anything else refuses; it counts what it was asked. */
  function stub() {
    const asked: string[] = [];
    const compute = (tool: string, params: unknown) => {
      asked.push(`${tool} ${JSON.stringify(params)}`);
      if (tool === "estimateCost") return { ok: true as const, status: "found", expansions: 12, result: { status: "found", lengthM: 30, etaS: 15, energyPct: 1.5, legs: [] } };
      if (tool === "planPath") return { ok: true as const, status: "found", expansions: 40, result: { status: "found", lengthM: 22.5, etaS: 11.25, energyPct: 1.1, expansions: 40, waypoints: [] } };
      return { ok: false as const, code: "point_out_of_bounds", message: "a point lies outside your map" };
    };
    return { asked, compute };
  }

  it("offers the compute tools to the provider (generated from the manifest), answers the calls and calls the model again with the answers, then takes the final answer", async () => {
    const { brain, provider, records, trace } = setup([calls({ name: "estimateCost", params: { route: ["home"] } }, { name: "planPath", params: { to: { xM: 9, yM: 9 } } }), GO]);
    const s = stub();
    const env = await brain.decide(request(), { requestRecordId: "run-000001#7", trace, compute: s.compute });
    expect(env.decision).toEqual({ kind: "action", name: "goTo", params: { xM: 9, yM: 9 } });
    expect(s.asked).toEqual(['estimateCost {"route":["home"]}', 'planPath {"to":{"xM":9,"yM":9}}']);
    expect(provider.calls).toBe(2);
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["estimateCost", "kShortestPaths", "planPath", "querySpace"]);
    // The second call carries the model's request and the two answers, each naming its call.
    const second = provider.requests[1]?.messages ?? [];
    expect(second.at(-3)).toMatchObject({ role: "assistant", toolCalls: [{ name: "estimateCost" }, { name: "planPath" }] });
    expect(second.at(-2)).toMatchObject({ role: "tool", name: "estimateCost" });
    expect(second.at(-1)).toMatchObject({ role: "tool", name: "planPath" });
    expect(JSON.parse(second.at(-1)?.content ?? "{}")).toMatchObject({ lengthM: 22.5 });
    // The record chain: the request, then the first call, the two tools as children of it, then the second call (also a child of the request).
    const firstCall = records.find((r) => payload(r)["op"] === "llm-call");
    const tools = records.filter((r) => r.r.kind === "compute");
    expect(tools.map((t) => [payload(t)["op"], payload(t)["tool"], payload(t)["status"], payload(t)["expansions"]])).toEqual([
      ["tool", "estimateCost", "found", 12],
      ["tool", "planPath", "found", 40],
    ]);
    expect(tools.every((t) => t.r.parentId === firstCall?.id)).toBe(true);
    expect(records.filter((r) => payload(r)["op"] === "llm-call").map((r) => r.r.parentId)).toEqual(["run-000001#7", "run-000001#7"]);
    expect(env.mind).toMatchObject({ attempts: 2 });
  });

  it("counts every model call of the loop against the limits (two calls of the loop are two calls)", async () => {
    const { brain, provider, trace } = setup([calls({ name: "planPath", params: { to: "home" } }), GO], { effective: withLimits({ calls: 1 }) });
    await expect(brain.decide(request(), { trace, compute: stub().compute })).rejects.toMatchObject({ code: "limit_reached" });
    expect(provider.calls).toBe(1);
  });

  it("returns a tool error to the model as a result (the call is still answered, and the loop goes on)", async () => {
    const { brain, provider, records, trace } = setup([calls({ name: "kShortestPaths", params: { to: { xM: 9999, yM: 0 }, k: 2 } }), GO]);
    const env = await brain.decide(request(), { trace, compute: stub().compute });
    expect(env.decision.kind).toBe("action");
    expect(JSON.parse(provider.requests[1]?.messages.at(-1)?.content ?? "{}")).toEqual({ error: "point_out_of_bounds", message: "a point lies outside your map" });
    const t = records.find((r) => r.r.kind === "compute");
    expect(payload(t as never)).toMatchObject({ op: "tool", tool: "kShortestPaths", ok: false, code: "point_out_of_bounds" });
  });

  it("refuses a call beyond tools.maxCallsPerDecision with a message to the model, without running it; the allow list narrows the offer", async () => {
    const { brain, provider, records, trace } = setup([calls({ name: "planPath", params: { to: "home" } }, { name: "planPath", params: { to: "home" } }, { name: "querySpace", params: {} }), GO], {
      effective: effective({ tools: { maxCallsPerDecision: 1, allow: ["goTo", "hold", "planPath"] } }),
    });
    const s = stub();
    await brain.decide(request(), { trace, compute: s.compute });
    expect(s.asked).toHaveLength(1); // the first planPath only
    const results = (provider.requests[1]?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as { error?: string });
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.error).toBe("tool_call_limit");
    expect(results[2]?.error).toBe("tool_call_limit");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["planPath"]); // of the compute tools, only the one the list names
    expect(records.filter((r) => r.r.kind === "compute").map((r) => payload(r)["ok"])).toEqual([true, false, false]);
  });

  it("a tool the profile does not offer is refused by name", async () => {
    const { brain, provider, trace } = setup([calls({ name: "querySpace", params: {} }), GO], { effective: effective({ tools: { maxCallsPerDecision: 8, allow: ["goTo", "hold", "planPath"] } }) });
    const s = stub();
    await brain.decide(request(), { trace, compute: s.compute });
    expect(s.asked).toEqual([]);
    expect(JSON.parse(provider.requests[1]?.messages.at(-1)?.content ?? "{}")).toMatchObject({ error: "tool_not_available" });
  });

  it("offers no tool when maxCallsPerDecision is 0 or the run has no compute port, and a model that asks anyway is told and retried", async () => {
    const none = setup([GO], { effective: effective({ tools: { maxCallsPerDecision: 0 } }) });
    await none.brain.decide(request(), { trace: none.trace, compute: stub().compute });
    expect(none.provider.requests[0]?.tools).toBeUndefined();
    const noPort = setup([calls({ name: "planPath", params: { to: "home" } }), GO]);
    const env = await noPort.brain.decide(request(), { trace: noPort.trace });
    expect(noPort.provider.requests[0]?.tools).toBeUndefined();
    expect(env.decision.kind).toBe("action"); // the second attempt answered
    expect(noPort.provider.requests[1]?.messages.at(-1)?.content).toContain("tools are not available");
  });

  it("a decision that calls no tool has the messages and the cache keys it had before tools existed", async () => {
    const { brain, cache, trace } = setup([GO]);
    await brain.decide(request(), { trace });
    const schema = answerSchema(request().allowedActions);
    const key = cacheKey({ providerKind: "openai-compatible", model: "m1", params: { temperature: 0 }, messages: buildPrompt({ template: DEFAULT_PROMPT_TEMPLATE, mission: "Hold position.", request: request(), history: [] }), toolsHash: contentHashOf(schema), attempt: 1 });
    expect(cache.entries.has(key)).toBe(true);
  });

  it("replay-strict of a looped decision makes no call and gives the same answer and records; a tool result that differs from the recorded one stops the run as divergent", async () => {
    const live = setup([calls({ name: "planPath", params: { to: "home" } }), GO]);
    const first = await live.brain.decide(request(), { requestRecordId: "run-000001#7", trace: live.trace, compute: stub().compute });
    const strict = setup([], { cache: live.cache, mode: "replay-strict" });
    const again = await strict.brain.decide(request(), { requestRecordId: "run-000001#7", trace: strict.trace, compute: stub().compute });
    expect(strict.provider.calls).toBe(0);
    expect(again.decision).toEqual(first.decision);
    const norm = (rs: typeof live.records) => rs.map((r) => ({ ...r, r: { ...r.r, payload: { ...payload(r), cacheHit: undefined } } }));
    expect(norm(strict.records)).toEqual(norm(live.records));
    // The maps differ now: the same call gives another result.
    const changed = () => ({ ok: true as const, status: "found", expansions: 40, result: { status: "found", lengthM: 99, etaS: 1, energyPct: 1 } });
    const diverge = setup([], { cache: live.cache, mode: "replay-strict" });
    await expect(diverge.brain.decide(request(), { requestRecordId: "run-000001#7", trace: diverge.trace, compute: changed })).rejects.toMatchObject({ code: "replay_divergent" });
  });
});
