import { DEFAULT_PROMPT_TEMPLATE } from "@agentsim/minds";
import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { serveMindCache, type CachePortLike } from "./remote-cache.ts";
import { flush, harness, init, stored, type Harness } from "./sim-host-harness.ts";

// F4 M1 (T-110) in the sim host: an S2 mind is a decision the lockstep world waits for. The host reports what the minds are doing (decisions waiting, what each has used of its limits, a pause at a limit),
// takes the researcher's answer to a pause, and ends a headless run that reached a limit with its reason. The provider is the scripted one the load message can carry (no network, no key).

const answer = (o: unknown) => ({ content: JSON.stringify(o), usage: { inputTokens: 100, outputTokens: 10 }, latencyMs: 5 });
const WAKE = answer({ action: "idle", timers: [{ op: "set", tag: "wake", delayS: 1 }] });

function load(over: { limits?: Record<string, number>; delayMs?: number; headless?: boolean; recording?: unknown; mode?: string; script?: unknown[] } = {}) {
  const profile = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "p", model: "m", promptTemplate: { id: "default", version: 1 }, ...(over.limits === undefined ? {} : { limits: over.limits }) } };
  return {
    type: "load",
    runId: "run-000007",
    scenario: f2DiscoveryScenario(),
    scenarioVersion: 1,
    runConfig: { ...f2RunConfig(F2_DISCOVERY_ID, 1), ...(over.mode === undefined ? {} : { mindsRunMode: over.mode }), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "Wake every second." } } } } },
    minds: {
      profiles: [{ id: "scout-llm", version: 1, document: profile }],
      templates: [{ id: "default", version: 1, document: DEFAULT_PROMPT_TEMPLATE }],
      providers: [{ id: "p", kind: "scripted", baseUrl: "http://localhost:1", script: over.script ?? Array.from({ length: 60 }, () => WAKE), delayMs: over.delayMs ?? 0 }],
    },
    ...(over.recording === undefined ? {} : { recording: over.recording }),
    ...(over.headless === true ? { headless: { untilS: 60 } } : {}),
  };
}

const minds = (h: Harness) => h.out.filter((m): m is Extract<(typeof h.out)[number], { type: "minds" }> => m.type === "minds");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Advances the host's clock and lets the promises of the minds settle, `n` times. */
async function pump(h: Harness, n: number, ms = 100): Promise<void> {
  let acked = 0;
  for (let i = 0; i < n; i++) {
    h.advance(ms);
    await flush();
    await sleep(1);
    // The storage worker's end of a recorded run: every batch the host hands over is acknowledged as persisted.
    const batches = h.batches();
    for (; acked < batches.length; acked++) {
      const b = batches[acked];
      if (b !== undefined) h.fromStorage({ type: "persisted", head: { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS } });
    }
  }
}

function started(l: unknown) {
  const h = harness();
  init(h);
  h.send(l);
  return h;
}

describe("the sim host and the System 2 minds", () => {
  it("reports a decision that waits for the model: waiting 1 while the answer is out, 0 after, the sim clock standing still in between", async () => {
    const h = started(load({ delayMs: 40 }));
    h.send({ type: "control", op: "play" });
    h.advance(200);
    await flush();
    const first = minds(h).at(-1);
    expect(first).toMatchObject({ runId: "run-000007", waiting: 1 });
    expect(first?.agents).toEqual([expect.objectContaining({ agentId: "uav-001", calls: 0, limits: { calls: 20, tokens: 40_000, costUsd: 0.05 }, pricesKnown: false })]);
    const tickWaiting = h.states().at(-1)?.tick ?? 0;
    h.advance(300);
    expect(h.states().at(-1)?.tick ?? 0).toBe(tickWaiting); // lockstep: the clock waits for the answer
    await sleep(80);
    await pump(h, 3);
    const later = minds(h).at(-1);
    expect(later?.agents[0]?.calls).toBeGreaterThanOrEqual(1);
    expect(h.errors()).toEqual([]);
  });

  it("warns at 80 % of a limit, pauses at the limit with the notice's figures, and goes on after a raise (the answer is the researcher's, stating the value)", async () => {
    const h = started(load({ limits: { calls: 5 } }));
    h.send({ type: "control", op: "play" });
    await pump(h, 80);
    const paused = minds(h).findLast((m) => m.pausedAt !== undefined);
    expect(paused?.pausedAt).toMatchObject({ agentId: "uav-001", limit: "calls", used: 5, max: 5 });
    expect(minds(h).some((m) => m.agents[0]?.warnings.some((w) => w.limit === "calls" && w.pct === 80))).toBe(true);
    const tickAtPause = h.states().at(-1)?.tick ?? 0;
    await pump(h, 5);
    expect(h.states().at(-1)?.tick ?? 0).toBe(tickAtPause); // paused: nothing moves while the notice is open
    // An answer for another agent or limit is not taken.
    h.send({ type: "limitAnswer", runId: "run-000007", agentId: "uav-001", limit: "tokens", action: "raise", value: 99_999 });
    await pump(h, 2);
    expect(minds(h).at(-1)?.pausedAt).toBeDefined();
    h.send({ type: "limitAnswer", runId: "run-000007", agentId: "uav-001", limit: "calls", action: "raise", value: 12 });
    await pump(h, 40);
    const after = minds(h).at(-1);
    expect(after?.pausedAt).toBeUndefined();
    expect(after?.agents[0]?.limits.calls).toBe(12);
    expect(h.states().at(-1)?.tick ?? 0).toBeGreaterThan(tickAtPause);
    const raise = h.events().find((r) => r.kind === "lifecycle" && (r.payload as { op?: string }).op === "raiseLimit");
    expect(raise?.payload).toMatchObject({ limit: "calls", before: 5, after: 12, caller: "world" });
    expect(h.events().some((r) => (r.payload as { op?: string }).op === "limit-warning")).toBe(true);
  });

  it("a stop answer ends the run with the error (the interactive run pauses), and the clock does not move again", async () => {
    const h = started(load({ limits: { calls: 2 } }));
    h.send({ type: "control", op: "play" });
    await pump(h, 60);
    expect(minds(h).at(-1)?.pausedAt).toBeDefined();
    h.send({ type: "limitAnswer", runId: "run-000007", agentId: "uav-001", limit: "calls", action: "stop" });
    await pump(h, 5);
    expect(h.errors().some((e) => e.code === "mind_failed" && /limit_reached/.test(e.message))).toBe(true);
    const tick = h.states().at(-1)?.tick ?? 0;
    await pump(h, 20);
    expect(h.states().at(-1)?.tick ?? 0).toBe(tick);
  });

  it("a headless run has no one to ask: it stops at the limit and reports done with the end reason limit_reached", async () => {
    const h = harness();
    init(h);
    h.send({ type: "recorderPort", port: h.port });
    h.send(load({ limits: { calls: 3 }, headless: true, recording: stored() }));
    h.fromStorage({ type: "header", runId: "run-000007" });
    h.send({ type: "control", op: "play" });
    const done = () => h.out.some((m) => m.type === "progress" && m.done);
    for (let i = 0; i < 40 && !done(); i++) await pump(h, 50, 10); // the model's answers come in real time: wait for the run to end, not for a count of polls
    const progress = h.out.filter((m): m is Extract<(typeof h.out)[number], { type: "progress" }> => m.type === "progress");
    expect(progress.at(-1)).toMatchObject({ headless: true, done: true, endReason: "limit_reached" });
    expect(progress.at(-1)?.simTimeS).toBeLessThan(60);
  });

  it("refuses a run whose mind names a provider the load did not give, with the stable code, before anything starts", () => {
    const l = load();
    const h = started({ ...l, minds: { ...l.minds, providers: [] } });
    expect(h.errors().map((e) => e.code)).toContain("provider_not_configured");
  });

  it("the response cache is the storage's: a run recorded in one session replays in a new session with replay-strict and no provider call, with the same decisions at the same ticks (T-112)", async () => {
    // The main thread's end of the channel, answering from one store that outlives the sessions (what the storage worker's cache is).
    const store = new Map<string, unknown>();
    const wire = (h: Harness) => {
      const ends: [((e: MessageEvent<unknown>) => void)[], ((e: MessageEvent<unknown>) => void)[]] = [[], []];
      const end = (me: 0 | 1): CachePortLike => ({ postMessage: (m) => queueMicrotask(() => (ends[1 - me] ?? []).forEach((l) => l({ data: m } as MessageEvent<unknown>))), addEventListener: (_t, l) => void (ends[me] ?? []).push(l), start: () => {} });
      serveMindCache(end(1), { get: async (k) => store.get(k) as never, put: async (k, v) => void store.set(k, v) });
      h.send({ type: "cachePort", port: end(0) });
    };

    const a = harness();
    init(a);
    wire(a);
    a.send(load());
    a.send({ type: "control", op: "play" });
    await pump(a, 60);
    expect(store.size).toBeGreaterThan(3);
    expect(a.errors()).toEqual([]);

    // A new session: the provider has nothing to say, so any call would be an error or a fallback; every answer must come from the cache.
    const b = harness();
    init(b);
    wire(b);
    b.send(load({ mode: "replay-strict", script: [] }));
    b.send({ type: "control", op: "play" });
    await pump(b, 60);
    expect(b.errors()).toEqual([]);
    expect(b.events().filter((r) => ["fallback", "cache-miss"].includes((r.payload as { op?: string }).op ?? ""))).toEqual([]);
    // The same decisions and actions at the same ticks, record for record (the replay's run is shorter or longer only by where the clock stood when each pump ended).
    const mine = (h: Harness) =>
      h
        .events()
        .filter((r) => ["request", "llm-call", "decision", "timer-set"].includes((r.payload as { op?: string }).op ?? ""))
        .map((r) => {
          const { cacheHit: _hit, ...rest } = r.payload as Record<string, unknown>; // the one field that says where the answer came from
          return { id: r.id, simTime: r.simTime, kind: r.kind, payload: rest };
        });
    const ra = mine(a);
    const rb = mine(b);
    const n = Math.min(ra.length, rb.length);
    expect(n).toBeGreaterThan(3);
    expect(rb.slice(0, n)).toEqual(ra.slice(0, n));
  });

  it("a replay-then-live run that misses the cache says from which tick it is not reproducible, once, in the minds' report (the lab writes it into the header)", async () => {
    const h = started(load({ mode: "replay-then-live" }));
    h.send({ type: "control", op: "play" });
    await pump(h, 30);
    const flagged = minds(h).filter((m) => m.notReproducibleFromTick !== undefined);
    expect(flagged.length).toBeGreaterThan(0);
    expect(new Set(flagged.map((m) => m.notReproducibleFromTick)).size).toBe(1);
  });
});
