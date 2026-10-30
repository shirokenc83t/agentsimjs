import { runLockstep } from "@agentsim/core";
import { DEFAULT_PROMPT_TEMPLATE, MemoryMindCache, ScriptedProvider, type MindCache, type ProviderPort, type ScriptedAnswer } from "@agentsim/minds";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { MindLibrary } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun } from "../testing/preset-run.ts";
import { restoreRun, snapshotRun } from "./snapshot-run.ts";

// F4 M2 (T-115): the `latency-modeled` time mode (ADR-0003 addition of 2026-10-29). A decision is applied at requestTick + max(1, ceil(latencyS / dtS)); meanwhile the world runs, the action goes on, events wait
// and no new request is made for the agent. `fixed` latency from the profile, `measured` from the wall latency of the model calls, replayed from the cache.

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
type Run = ReturnType<typeof buildPresetRun>;

const usage = { inputTokens: 200, outputTokens: 20 };
const STEPS = [
  { action: "takeoff", params: { altitudeM: 20 } },
  { action: "goTo", params: { xM: 40, yM: 20 } },
  { action: "returnToBase", params: {} },
];
const ADVANCES = /"kind":"(start|actionCompleted|actionFailed|actionRejected)"/;

/** The next step on an event that moves the mission on, idle on the others; every call takes the wall latency the list gives, in turn (so a measured run has varied latencies). */
function stepping(latenciesMs: readonly number[]): ScriptedProvider {
  let n = 0;
  let calls = 0;
  return new ScriptedProvider((req) => {
    const latencyMs = latenciesMs[calls++ % latenciesMs.length] ?? 30;
    const body: ScriptedAnswer = { content: JSON.stringify(ADVANCES.test(req.messages[1]?.content ?? "") ? (STEPS[n++] ?? { action: "idle" }) : { action: "idle" }), usage, latencyMs };
    return body;
  });
}

const library = (latency: Record<string, unknown>): MindLibrary => ({
  profile: () => ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local", model: "test-model", promptTemplate: { id: "default", version: 1 }, latency } }) as never,
  template: () => DEFAULT_PROMPT_TEMPLATE,
});
const config = (timeMode?: string, mode?: string): Partial<RunConfigDocument> =>
  ({ ...(timeMode === undefined ? {} : { timeMode }), ...(mode === undefined ? {} : { mindsRunMode: mode }), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "Fly the steps you are given." } } } } }) as unknown as Partial<RunConfigDocument>;

function build(o: { timeMode?: string; mode?: string; provider: ProviderPort; cache: MindCache; latency?: Record<string, unknown>; restore?: boolean }): Run {
  return buildPresetRun(
    {
    preset: "f2-discovery",
    scripts: {},
    runConfig: config(o.timeMode, o.mode),
    resolve: { library: library(o.latency ?? { model: "measured" }), providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434" }) },
    minds: { providers: () => o.provider, cache: o.cache, now: () => 0 },
    },
    o.restore === true ? "restore-target" : "genesis",
  );
}

const finished = (run: Run) => run.trace.all().some((r) => r.kind === "action" && payloadOf(r).op === "end" && payloadOf(r).name === "returnToBase");
async function go(run: Run, done: () => boolean = () => finished(run), maxTicks = 8000): Promise<void> {
  for (let t = 0; t < maxTicks && !done(); t += 10) await runLockstep(run.world, run.scheduler, 10);
}
const decisions = (run: Run) => run.trace.all().filter((r) => payloadOf(r).op === "decision" && r.agentId === "uav-001");
const tickOf = (r: TraceRecord) => Math.round(r.simTime / 0.1);
const sameTrace = (run: Run) =>
  run.trace.all().map((r) => {
    const p = payloadOf(r);
    if (p.op !== "llm-call") return { ...r, wallTime: 0 };
    const { cacheHit: _hit, ...rest } = p;
    return { ...r, wallTime: 0, payload: rest };
  });

describe("latency-modeled time (F4 M2)", () => {
  it("a fixed latency applies each decision at requestTick + ceil(latency / dt), recorded on the decision, and the action starts then", async () => {
    // 350 ms at dt 0.1 s is 4 ticks (ceil(3.5)).
    const run = build({ timeMode: "latency-modeled", provider: stepping([30]), cache: new MemoryMindCache(), latency: { model: "fixed", fixedMs: 350 } });
    await go(run);
    const ds = decisions(run);
    expect(ds.length).toBeGreaterThanOrEqual(3);
    for (const d of ds) {
      const p = payloadOf(d);
      expect(p.applyTick).toBe((p.requestTick as number) + 4);
      expect(tickOf(d)).toBe(p.applyTick);
      expect(p.latencyMs).toBe(30); // the wall latency of its model call, recorded next to the modelled one
    }
    const takeoff = run.trace.all().find((r) => r.kind === "action" && payloadOf(r).op === "start" && payloadOf(r).name === "takeoff" && r.agentId === "uav-001");
    expect(tickOf(takeoff as TraceRecord)).toBe(tickOf(ds[0] as TraceRecord));
  });

  it("meanwhile the world runs: no new request for the agent until the answer is applied, and its events wait in its inbox", async () => {
    const run = build({ timeMode: "latency-modeled", provider: stepping([30]), cache: new MemoryMindCache(), latency: { model: "fixed", fixedMs: 1000 } });
    await go(run, () => decisions(run).length >= 3);
    const requests = run.trace.all().filter((r) => payloadOf(r).op === "request" && r.agentId === "uav-001");
    const applied = decisions(run);
    // Between a request and the decision that answers it there is no other request of that agent.
    for (const d of applied) {
      const answered = requests.filter((r) => d.causeIds?.includes(r.id));
      expect(answered.length).toBe(1);
      const between = requests.filter((r) => r.simTime > (answered[0] as TraceRecord).simTime + 1e-9 && r.simTime < d.simTime - 1e-9);
      expect(between).toEqual([]);
    }
    // The world did advance meanwhile: ten ticks pass between a request and its decision.
    const first = payloadOf(applied[0] as TraceRecord);
    expect((first.applyTick as number) - (first.requestTick as number)).toBe(10);
  });

  it("without the mode (lockstep) a decision is applied at the next tick and carries no latency fields: the traces of lockstep runs are as they were", async () => {
    const run = build({ provider: stepping([30]), cache: new MemoryMindCache() });
    await go(run);
    for (const d of decisions(run)) {
      const p = payloadOf(d);
      expect(p.applyTick).toBeUndefined();
      expect(p.requestTick).toBeUndefined();
    }
  });

  it("a measured latency (the model calls' wall latency, summed) gives the application ticks, and a replay from the cache reproduces every decision tick, the trace and the hashes", async () => {
    const cache = new MemoryMindCache();
    // 120 ms, 480 ms, 910 ms in turn: 2, 5 and 10 ticks.
    const live = build({ timeMode: "latency-modeled", provider: stepping([120, 480, 910]), cache });
    await go(live);
    const lat = decisions(live).map((d) => (payloadOf(d).applyTick as number) - (payloadOf(d).requestTick as number));
    expect(new Set(lat).size).toBeGreaterThan(1);
    expect(lat.every((l) => [2, 5, 10].includes(l))).toBe(true);
    const none = new ScriptedProvider([]);
    const replay = build({ timeMode: "latency-modeled", mode: "replay-strict", provider: none, cache });
    await go(replay, () => replay.world.tick >= live.world.tick);
    expect(none.calls).toBe(0);
    expect(decisions(replay).map((d) => [payloadOf(d).requestTick, payloadOf(d).applyTick])).toEqual(decisions(live).map((d) => [payloadOf(d).requestTick, payloadOf(d).applyTick]));
    expect(replay.world.stateHash).toBe(live.world.stateHash);
    expect(sameTrace(replay)).toEqual(sameTrace(live));
  });
});

describe("a snapshot in latency-modeled time", () => {
  it("keeps an answer that is waiting for its tick: a fork restored from it applies it at the same tick and reaches the same hash", async () => {
    const cache = new MemoryMindCache();
    const original = build({ timeMode: "latency-modeled", provider: stepping([30]), cache, latency: { model: "fixed", fixedMs: 1000 } });
    const waiting = () => original.world.snapshot().slots.some((s) => s?.applyTick !== undefined && s.applyTick > original.world.tick);
    for (let i = 0; i < 200 && !waiting(); i++) await runLockstep(original.world, original.scheduler, 1);
    expect(waiting()).toBe(true);
    const bytes = snapshotRun(original);
    const fork = build({ timeMode: "latency-modeled", mode: "replay-strict", provider: new ScriptedProvider([]), cache, latency: { model: "fixed", fixedMs: 1000 }, restore: true });
    restoreRun(fork, bytes);
    const until = original.world.tick + 60;
    await go(original, () => original.world.tick >= until);
    await go(fork, () => fork.world.tick >= until);
    expect(fork.world.stateHash).toBe(original.world.stateHash);
    const after = (r: Run, from: number) => decisions(r).filter((d) => tickOf(d) > from).map((d) => [payloadOf(d).requestTick, payloadOf(d).applyTick]);
    expect(after(fork, 0).length).toBeGreaterThan(0);
    expect(after(fork, 0)).toEqual(after(original, original.world.tick - 60 - 0).slice(-after(fork, 0).length));
  });
});
