import { runLockstep } from "@agentsim/core";
import { DEFAULT_PROMPT_TEMPLATE, MemoryMindCache, ScriptedProvider, raisesFromRecords, replayRaises, type LimitEvent, type LlmBrainHooks, type MindCache, type ProviderPort, type ScriptedAnswer } from "@agentsim/minds";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { MindLibrary } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun } from "../testing/preset-run.ts";
import { restoreRun, snapshotRun } from "./snapshot-run.ts";

// F4 M1 (T-110): the run modes, the limits that pause, and the replay, on the F2 scene with the scripted provider: the mind comes from the run configuration (an `s2` entry over a library profile and a
// provider), the way the lab will make it.

declare function setTimeout(fn: () => void, ms: number): unknown;

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
type Run = ReturnType<typeof buildPresetRun>;

const ok = (obj: unknown): ScriptedAnswer => ({ content: JSON.stringify(obj), usage: { inputTokens: 200, outputTokens: 20 }, latencyMs: 30 });
const IDLE = ok({ action: "idle" });
const MISSION = [
  { action: "takeoff", params: { altitudeM: 20 } },
  { action: "goTo", params: { xM: 40, yM: 20 }, note: { text: "went to B", mode: "replace" } },
  { action: "returnToBase", params: {} },
];

/** The next scripted answer when the request carries an event that starts or ends an action, idle for any other (the mind is asked on perception events too). */
function steps(list: readonly unknown[] = MISSION): ScriptedProvider {
  let n = 0;
  return new ScriptedProvider((req) => (/"kind":"(start|actionCompleted|actionFailed|actionRejected)"/.test(req.messages[1]?.content ?? "") ? (n < list.length ? ok(list[n++]) : IDLE) : IDLE));
}

const library = (limits: Record<string, number> = {}): MindLibrary => ({
  profile: () => ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local", model: "test-model", promptTemplate: { id: "default", version: 1 }, limits } }) as never,
  template: () => DEFAULT_PROMPT_TEMPLATE,
});
const config = (mode?: string, overrides?: unknown): Partial<RunConfigDocument> =>
  ({ ...(mode === undefined ? {} : { mindsRunMode: mode }), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "Fly the steps you are given.", ...(overrides === undefined ? {} : { overrides }) } } } } }) as unknown as Partial<RunConfigDocument>;

function build(o: { mode?: string; provider: ProviderPort; cache: MindCache; limits?: Record<string, number>; overrides?: unknown; hooks?: (agentId: string) => LlmBrainHooks | undefined; told?: [string, number][]; restore?: boolean }): Run {
  return buildPresetRun(
    {
      preset: "f2-discovery",
      scripts: {},
      runConfig: config(o.mode, o.overrides),
      resolve: { library: library(o.limits), providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434" }) },
      minds: {
        providers: () => o.provider,
        cache: o.cache,
        now: () => 0,
        ...(o.hooks === undefined ? {} : { hooks: o.hooks }),
        ...(o.told === undefined ? {} : { onNotReproducible: (a: string, t: number) => void o.told?.push([a, t]) }),
      },
    },
    o.restore === true ? "restore-target" : "genesis",
  );
}

const starts = (run: Run) => run.trace.all().filter((r) => r.kind === "action" && payloadOf(r).op === "start" && r.agentId === "uav-001");
const finished = (run: Run) => starts(run).length >= 3 && run.trace.all().some((r) => r.kind === "action" && payloadOf(r).op === "end" && payloadOf(r).name === "returnToBase");
async function go(run: Run, done: () => boolean = () => finished(run), maxTicks = 6000): Promise<void> {
  for (let t = 0; t < maxTicks && !done(); t += 10) await runLockstep(run.world, run.scheduler, 10);
}
/** The trace as a replay should reproduce it: wall time masked and the cache-hit flag of the model calls (true in a replay, false in the live run) left out. */
const sameTrace = (run: Run) =>
  run.trace.all().map((r) => {
    const p = payloadOf(r);
    if (p.op !== "llm-call") return { ...r, wallTime: 0 };
    const { cacheHit: _hit, ...rest } = p;
    return { ...r, wallTime: 0, payload: rest };
  });

describe("a run with an s2 mind from the run configuration", () => {
  it("is made from the entry: the LLM mind of the profile, over the provider and the cache the host gave, and its effective configuration is in the agent's config record", async () => {
    const provider = steps();
    const run = build({ provider, cache: new MemoryMindCache() });
    await go(run);
    expect(starts(run).map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "returnToBase"]);
    expect(provider.calls).toBeGreaterThanOrEqual(3);
    const cfg = run.trace.all().find((r) => r.agentId === "uav-001" && payloadOf(r).op === "config") as TraceRecord;
    expect(payloadOf(cfg).mindS2).toMatchObject({ source: "byAgent", provider: { id: "local", kind: "openai-compatible", host: "localhost:11434" }, effective: { model: "test-model" }, mission: "Fly the steps you are given." });
    expect(JSON.stringify(payloadOf(cfg))).not.toContain("apiKey");
  });

  it("has no provider the host did not give: the run is refused with provider_not_configured, not started", () => {
    expect(() => buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: config(), resolve: { library: library(), providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:1" }) }, minds: { providers: () => undefined, cache: new MemoryMindCache() } })).toThrow(/provider_not_configured/);
  });
});

describe("replay-strict: the cache is the only source", () => {
  it("a full run replayed from its cache makes no call and gives the identical trace and the same hashes", async () => {
    const cache = new MemoryMindCache();
    const live = build({ provider: steps(), cache });
    await go(live);
    const none = new ScriptedProvider([]);
    const replay = build({ mode: "replay-strict", provider: none, cache });
    await go(replay, () => replay.world.tick >= live.world.tick);
    expect(none.calls).toBe(0);
    expect(replay.world.tick).toBe(live.world.tick);
    expect(replay.world.stateHash).toBe(live.world.stateHash);
    expect(sameTrace(replay)).toEqual(sameTrace(live));
    // The calls say they were hits.
    const calls = replay.trace.all().filter((r) => payloadOf(r).op === "llm-call");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => payloadOf(r).cacheHit === true)).toBe(true);
  });

  it("stops on a miss with the stable error cache_miss_strict, and the trace says which call missed", async () => {
    const run = build({ mode: "replay-strict", provider: new ScriptedProvider([]), cache: new MemoryMindCache() });
    await expect(go(run)).rejects.toThrow(/cache_miss_strict/);
    const miss = run.trace.all().find((r) => payloadOf(r).op === "cache-miss");
    expect(miss).toBeDefined();
    expect(payloadOf(miss as TraceRecord)).toMatchObject({ op: "cache-miss", attempt: 1, model: "test-model" });
  });
});

describe("replay-then-live", () => {
  it("reads the cache first, calls live on the first miss, flags the run as not reproducible from that tick, and caches what it asked", async () => {
    const cache = new MemoryMindCache();
    const first = build({ provider: steps(MISSION.slice(0, 2)), cache });
    await go(first, () => starts(first).length >= 2); // the cache holds the first two decisions: the third, when the goTo ends, is a miss
    const told: [string, number][] = [];
    const provider = steps(MISSION);
    const run = build({ mode: "replay-then-live", provider, cache, told });
    await go(run, () => run.world.tick >= 1200);
    expect(told.length).toBe(1);
    expect(told[0]?.[0]).toBe("uav-001");
    const flag = run.trace.all().find((r) => payloadOf(r).op === "not-reproducible") as TraceRecord;
    expect(payloadOf(flag).fromTick).toBe(told[0]?.[1]);
    expect(provider.calls).toBeGreaterThan(0);
    const hits = run.trace.all().filter((r) => payloadOf(r).op === "llm-call");
    expect(hits.some((r) => payloadOf(r).cacheHit === true)).toBe(true);
    expect(hits.some((r) => payloadOf(r).cacheHit === false)).toBe(true);
    expect(run.resolved.mindsRunMode).toBe("replay-then-live");
  });
});

describe("the limits of a run pause it", () => {
  const OVER = { limits: { calls: 2 } };

  it("a run with no one to ask (headless) stops at the call limit with limit_reached, and the trace holds the hit", async () => {
    const run = build({ provider: steps(), cache: new MemoryMindCache(), overrides: OVER });
    await expect(go(run)).rejects.toThrow(/limit_reached/);
    const hit = run.trace.all().find((r) => payloadOf(r).op === "limit-hit") as TraceRecord;
    expect(payloadOf(hit)).toMatchObject({ limit: "calls", used: 2, max: 2, agentId: "uav-001" });
    expect(run.trace.all().filter((r) => payloadOf(r).op === "llm-call").length).toBe(2);
  });

  it("an interactive run waits for the answer: while the notice is open the world does not move, after a raise it goes on, and the raise is recorded with the value before it", async () => {
    const seen: LimitEvent[] = [];
    let answer!: (a: { action: "raise"; value: number }) => void;
    const run = build({
      provider: steps(),
      cache: new MemoryMindCache(),
      overrides: OVER,
      hooks: () => ({
        onLimitHit: (e) => {
          seen.push(e);
          return new Promise((resolve) => (answer = resolve));
        },
      }),
    });
    const running = go(run);
    for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise<void>((r) => setTimeout(() => r(), 5));
    expect(seen).toHaveLength(1);
    const tickAtPause = run.world.tick;
    await new Promise<void>((r) => setTimeout(() => r(), 60));
    expect(run.world.tick).toBe(tickAtPause); // paused: nothing moved while the notice was open
    answer({ action: "raise", value: 50 });
    await running;
    expect(starts(run).map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "returnToBase"]);
    const raise = run.trace.all().find((r) => r.kind === "lifecycle" && payloadOf(r).op === "raiseLimit") as TraceRecord;
    expect(payloadOf(raise)).toMatchObject({ limit: "calls", before: 2, after: 50, caller: "world" });
  });

  it("replaying a run with a raise gives the same trace: the recorded raise answers the same hit, with no one asked and no call made", async () => {
    const cache = new MemoryMindCache();
    const live = build({ provider: steps(), cache, overrides: OVER, hooks: () => ({ onLimitHit: () => Promise.resolve({ action: "raise" as const, value: 50 }) }) });
    await go(live);
    const log = raisesFromRecords(live.trace.all());
    expect(log).toHaveLength(1);
    const none = new ScriptedProvider([]);
    const replay = build({ mode: "replay-strict", provider: none, cache, overrides: OVER, hooks: () => replayRaises(log) });
    await go(replay, () => replay.world.tick >= live.world.tick);
    expect(none.calls).toBe(0);
    expect(replay.world.stateHash).toBe(live.world.stateHash);
    expect(sameTrace(replay)).toEqual(sameTrace(live));
    // Without the log the same replay stops at the same hit.
    const stop = build({ mode: "replay-strict", provider: new ScriptedProvider([]), cache, overrides: OVER });
    await expect(go(stop, () => stop.world.tick >= live.world.tick)).rejects.toThrow(/limit_reached/);
  });

  it("a snapshot carries what the mind has used: a fork restored from it is stopped by the same limit as the original", async () => {
    const cache = new MemoryMindCache();
    const limits = { limits: { calls: 4 } };
    const original = build({ provider: steps(), cache, overrides: limits });
    const callsOf = (r: Run) => r.trace.all().filter((x) => payloadOf(x).op === "llm-call").length;
    for (let i = 0; i < 200 && callsOf(original) < 2; i++) await runLockstep(original.world, original.scheduler, 5);
    const bytes = snapshotRun(original);
    const usedAtSnapshot = callsOf(original);
    expect(usedAtSnapshot).toBe(2);
    const fork = build({ provider: steps(), cache, overrides: limits, restore: true });
    restoreRun(fork, bytes);
    await expect(go(fork, () => false, 3000)).rejects.toThrow(/limit_reached/);
    // The fork made only the calls the original had left: 4 in all.
    expect(usedAtSnapshot + callsOf(fork)).toBe(4);
  });
});
