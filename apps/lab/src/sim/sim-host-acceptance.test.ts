import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import cacheLatency from "./fixtures/f4-acceptance/cache-latency-modeled.json";
import cacheLockstep from "./fixtures/f4-acceptance/cache-lockstep.json";
import expected from "./fixtures/f4-acceptance/expected.json";
import profile from "./fixtures/f4-acceptance/profile.json";
import template from "./fixtures/f4-acceptance/template.json";
import mission from "./fixtures/f4-acceptance/mission.txt?raw";
import { serveMindCache, type CachePortLike } from "./remote-cache.ts";
import { flush, harness, init, stored, type Harness } from "./sim-host-harness.ts";

// F4 M5 (T-129), the acceptance run in CI: the run recorded live on a local Ollama (qwen2.5:7b-instruct, the F2 discovery scene, a UAV given "inspect these three points and return to base") is replayed from its
// response cache, with no server and no key: `replay-strict` makes no provider call and reproduces the decisions at their sim times and the state hash at each checkpoint; the same in `latency-modeled`, where the
// decision comes at the tick the recorded latency gives. The fixtures are what the lab exported from that run: the profile, the template, the mission, the cache entries and what each run did (expected.json).
// What the 7B did is in the fixture as it was: it chose its order with estimateCost and then fell back to idle (it did not complete the mission).

type Mode = "lockstep" | "latencyModeled";
type Entries = readonly { key: string; entry: unknown }[];
// The two live runs start from the same first request and a live run writes over the answer of the one before: each replay has the cache as it was when its own run had just been checked.
const CACHES: Record<Mode, Entries> = { lockstep: cacheLockstep as Entries, latencyModeled: cacheLatency as Entries };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function load(timeMode: Mode) {
  return {
    type: "load",
    runId: "run-000009",
    recording: stored(),
    scenario: f2DiscoveryScenario(),
    scenarioVersion: 1,
    runConfig: {
      ...f2RunConfig(F2_DISCOVERY_ID, 1),
      beliefs: { default: { init: "ideal" } },
      mindsRunMode: "replay-strict",
      ...(timeMode === "latencyModeled" ? { timeMode: "latency-modeled" } : {}),
      minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission } } } },
    },
    minds: {
      profiles: [{ id: "scout-llm", version: 1, document: profile }],
      templates: [{ id: "inspect-order", version: 1, document: template }],
      // The address is a placeholder: in `replay-strict` nothing is sent to it (a call would fail, and the run would end with an error).
      providers: [{ id: "local-ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434" }],
    },
  };
}

async function replay(timeMode: Mode) {
  const entries = CACHES[timeMode];
  const store = new Map<string, unknown>(entries.map((e) => [e.key, e.entry]));
  const h: Harness = harness();
  init(h);
  const ends: [((e: MessageEvent<unknown>) => void)[], ((e: MessageEvent<unknown>) => void)[]] = [[], []];
  const end = (me: 0 | 1): CachePortLike => ({ postMessage: (m) => queueMicrotask(() => (ends[1 - me] ?? []).forEach((l) => l({ data: m } as MessageEvent<unknown>))), addEventListener: (_t, l) => void (ends[me] ?? []).push(l), start: () => {} });
  serveMindCache(end(1), { get: async (k) => store.get(k) as never, put: async (k, v) => void store.set(k, v) });
  h.send({ type: "cachePort", port: end(0) });
  h.send({ type: "recorderPort", port: h.port });
  h.send(load(timeMode));
  h.fromStorage({ type: "header", runId: "run-000009" });
  h.send({ type: "control", op: "play" });
  let acked = 0;
  for (let i = 0; i < 60; i++) {
    h.advance(1000);
    await flush();
    await sleep(1);
    // The storage worker's end of a recorded run: every batch handed over is acknowledged as persisted.
    const batches = h.batches();
    for (; acked < batches.length; acked++) {
      const b = batches[acked];
      if (b !== undefined) h.fromStorage({ type: "persisted", head: { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS } });
    }
    if ((h.states().at(-1)?.tick ?? 0) >= 400) break;
  }
  return { h, writes: store.size, size: entries.length };
}

const payloadOf = (r: { payload?: unknown }) => (r.payload ?? {}) as Record<string, unknown>;

describe("the acceptance run replayed from its cache", () => {
  for (const [name, mode] of [["lockstep", "lockstep"], ["latency-modeled with the measured latencies", "latencyModeled"]] as const) {
    it(`${name}: no provider call, the same decisions at the same sim times, the same state hash at every checkpoint`, async () => {
      const want = expected[mode];
      const { h, writes, size } = await replay(mode);
      expect(h.errors()).toEqual([]);
      expect(writes).toBe(size); // nothing was added to the cache: every model call was answered from it
      const events = h.events();
      const calls = events.filter((r) => payloadOf(r)["op"] === "llm-call");
      expect(calls).toHaveLength(want.llmCalls);
      expect(calls.every((r) => payloadOf(r)["cacheHit"] === true)).toBe(true);
      expect(events.filter((r) => payloadOf(r)["op"] === "tool").map((r) => [Math.round(r.simTime * 10) / 10, payloadOf(r)["tool"]])).toEqual(want.tools.map(([t, n]) => [t, n]));
      const decisions = events.filter((r) => payloadOf(r)["op"] === "decision" && r.agentId === "uav-001");
      expect(decisions.map((r) => [Math.round(r.simTime * 10) / 10, (payloadOf(r)["decision"] as { kind: string }).kind])).toEqual(want.decisions.map((d) => [d.simTime, d.decision?.kind]));
      // The checkpoints the recorder writes every 100 ticks carry the state hash: the same ones the recorded run wrote at the same ticks.
      const checkpoints = h.batches().flatMap((b) => b.records).filter((r) => payloadOf(r)["op"] === "checkpoint").map((r) => [payloadOf(r)["tick"], payloadOf(r)["stateHash"]]);
      const shared = want.checkpoints.map(([, tick, hash]) => [tick, hash]).filter(([tick]) => checkpoints.some(([t]) => t === tick));
      expect(shared.length).toBeGreaterThanOrEqual(4);
      expect(checkpoints.filter(([t]) => shared.some(([tick]) => tick === t))).toEqual(shared);
    });
  }
});
