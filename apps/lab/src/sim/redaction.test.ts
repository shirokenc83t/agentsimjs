import { DEFAULT_PROMPT_TEMPLATE } from "@agentsim/minds";
import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { createMemoryPorts, exportRunJsonl } from "@agentsim/storage";
import { RECORDING_PRESETS, type RunHeader, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { serveMindCache, type CachePortLike } from "./remote-cache.ts";
import { flush, harness, init, type Harness } from "./sim-host-harness.ts";

// F4 M3 (T-122): the redaction sweep. A planted key goes through a run whose mind is a language model over an OpenAI-compatible provider (the adapter, the sim host, the recorder at the fullest profile, the
// cache, the exports), with the server failing in the ways a server fails (a refusal, an error status, a broken connection that names the key in its own message). The key is then searched for in everything that
// leaves the worker or the run: every posted message, every record of every channel, the run header, the snapshots, the cache entries, the run's export with its library and its cache, and the errors. The key has
// not the shape of a provider key on purpose: the scrubber of the trace layer must not be what keeps it out (it is a second line, tested in the trace package).

const KEY = "planted-sweep-key-8f7e6d5c4b3a2910";

const profile = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "p", model: "m", promptTemplate: { id: "default", version: 1 }, limits: { retries: 3, calls: 100 } } };

function load() {
  return {
    type: "load",
    runId: "run-000007",
    scenario: f2DiscoveryScenario(),
    scenarioVersion: 1,
    runConfig: { ...f2RunConfig(F2_DISCOVERY_ID, 1), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "Wake every second." } } } } },
    minds: { profiles: [{ id: "scout-llm", version: 1, document: profile }], templates: [{ id: "default", version: 1, document: DEFAULT_PROMPT_TEMPLATE }], providers: [{ id: "p", kind: "openai-compatible", baseUrl: "http://localhost:11434" }] },
    recording: { mode: "stored", profile: RECORDING_PRESETS["debug-full"] },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function pump(h: Harness, n: number): Promise<void> {
  let acked = 0;
  for (let i = 0; i < n; i++) {
    h.advance(100);
    await flush();
    await sleep(1);
    const batches = h.batches();
    for (; acked < batches.length; acked++) {
      const b = batches[acked];
      if (b !== undefined) h.fromStorage({ type: "persisted", head: { runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS } });
    }
  }
}

/** Bytes as text, so that a key hidden in a snapshot or a blob is found too. */
const latin1 = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? new TextDecoder("latin1").decode(x) : x instanceof Float32Array || x instanceof ArrayBuffer ? undefined : x));

describe("the redaction sweep (a planted key through a run whose mind is a model)", () => {
  it("the key is in the header of the calls and nowhere else: no message, record of any channel, header, snapshot, cache entry, export or error holds it", async () => {
    // The provider: idle answers, with a refusal, an error status and a broken connection that names the key, early on.
    const calls: { url: string; auth: string | undefined }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers["authorization"] });
      const n = calls.length;
      if (n === 1) return Promise.reject(new TypeError(`fetch failed: ${url} Authorization: Bearer ${KEY}`));
      const body = (status: number, o: unknown) => Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(o)) });
      if (n === 2) return body(503, { error: { message: `overloaded; request had ${KEY}` } });
      if (n === 3) return body(200, { choices: [{ message: { role: "assistant", content: null, refusal: `I cannot, ${KEY}` } }] });
      return body(200, { choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "idle", timers: [{ op: "set", tag: "wake", delayS: 1 }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    }) as never;
    try {
      const h = harness();
      init(h);
      h.send({ type: "recorderPort", port: h.port });
      // The cache, served from a store like the storage worker's.
      const entries = new Map<string, unknown>();
      const ends: [((e: MessageEvent<unknown>) => void)[], ((e: MessageEvent<unknown>) => void)[]] = [[], []];
      const end = (me: 0 | 1): CachePortLike => ({ postMessage: (m) => queueMicrotask(() => (ends[1 - me] ?? []).forEach((l) => l({ data: m } as MessageEvent<unknown>))), addEventListener: (_t, l) => void (ends[me] ?? []).push(l), start: () => {} });
      serveMindCache(end(1), { get: async (k) => entries.get(k) as never, put: async (k, v) => void entries.set(k, v) });
      h.send({ type: "cachePort", port: end(0) });
      h.send({ type: "providerKeys", keys: { p: KEY } });
      h.send(load());
      h.fromStorage({ type: "header", runId: "run-000007" });
      h.send({ type: "control", op: "play" });
      await pump(h, 60);

      // The worker made calls, all to the provider's address and all with the key in the header; some of them failed.
      expect(calls.length).toBeGreaterThan(4);
      expect(calls.every((c) => c.url === "http://localhost:11434/v1/chat/completions" && c.auth === `Bearer ${KEY}`)).toBe(true);
      const records: TraceRecord[] = h.batches().flatMap((b) => [...b.records]);
      const ops = (op: string) => records.filter((r) => (r.payload as { op?: string } | null)?.op === op);
      expect(ops("llm-call").length).toBeGreaterThan(2);
      expect(ops("llm-call").some((r) => (r.payload as { outcome?: string }).outcome === "error")).toBe(true); // the failures are on record, in words

      // Everything the worker posted, and every record of every channel at the fullest profile, header included.
      expect(latin1(h.out)).not.toContain(KEY);
      expect(latin1(records)).not.toContain(KEY);
      expect(latin1(h.toStorage)).not.toContain(KEY); // batches, snapshots, frames, metrics: whatever went to the recorder
      expect(latin1(h.errors())).not.toContain(KEY);
      expect(latin1([...entries])).not.toContain(KEY);
      expect(entries.size).toBeGreaterThan(2);
      const loaded = h.out.find((m) => m.type === "loaded");
      expect(latin1(loaded)).not.toContain(KEY);

      // The run's export: header, scenario, library (profiles and templates), cache entries it used, trace, inputs.
      const ports = createMemoryPorts();
      const header = { ...(loaded as unknown as { header?: RunHeader }).header, runId: "run-000007" } as RunHeader;
      const made = await ports.runs.create({ runId: "run-000007", schemaVersion: 0, createdAtWallMs: 1, label: "sweep", status: "completed", ...(header.runConfig === undefined ? {} : { runConfig: header.runConfig }) });
      expect(made.ok).toBe(true);
      expect((await ports.trace.append(records)).ok).toBe(true);
      expect((await ports.mindProfiles.saveVersion({ id: "scout-llm", name: "Scout", document: profile })).ok).toBe(true);
      for (const [k, v] of entries) await ports.cache.put(k, v as never);
      const exported = await exportRunJsonl(ports, "run-000007");
      expect(exported.ok).toBe(true);
      if (exported.ok) {
        const text = new TextDecoder().decode(exported.value);
        expect(text).not.toContain(KEY);
        expect(text.length).toBeGreaterThan(1000);
      }
    } finally {
      globalThis.fetch = real;
    }
  });
});
