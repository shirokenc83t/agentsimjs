import type { DecisionRequest, TraceSink } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { MemoryMindCache } from "./cache.ts";
import { DEFAULT_PROMPT_TEMPLATE, MIND_DEFAULTS } from "./documents.ts";
import { LlmBrain } from "./llm-brain.ts";
import { hostOf, normalizeBaseUrl, OpenAiCompatibleProvider, parseCompletion, type FetchInit, type FetchLike, type FetchResponse } from "./openai.ts";
import type { ProviderRequest } from "./provider.ts";

// The adapter for OpenAI-compatible servers (F4 M3, T-119) against a fake `fetch`: no network, no real key. The answers are shaped as the servers give them (the recorded exchanges of T-120 live in the fixtures
// of the minds package); here the point is what the adapter sends, how it reads, how it fails, and that a key goes nowhere but into the header of a call to the configured address.

declare function setTimeout(fn: () => void, ms: number): unknown;

const KEY = "planted-secret-0123456789";
const BASE = "http://localhost:11434";

interface Seen {
  readonly url: string;
  readonly init: FetchInit;
}
const reply = (status: number, body: unknown): FetchResponse => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)) });
function fake(answer: (seen: Seen, n: number) => FetchResponse | Promise<FetchResponse>): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      const s = { url, init };
      seen.push(s);
      return Promise.resolve(answer(s, seen.length));
    },
  };
}
const completion = (message: Record<string, unknown>, usage?: unknown) => ({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) });

const SCHEMA = { anyOf: [{ type: "object", required: ["action"], properties: { action: { const: "idle" } } }] };
const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({ model: "qwen2.5:7b", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], answerSchema: SCHEMA, params: { temperature: 0, maxOutputTokens: 200, topP: 0.9 }, timeoutMs: 5000, attempt: 1, ...over });
const bodyOf = (s: Seen) => JSON.parse(s.init.body ?? "{}") as Record<string, unknown>;

describe("the base URL", () => {
  it("accepts http and https with a host, drops a trailing slash, and refuses anything else (a key does not belong in an address)", () => {
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("HTTPS://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeBaseUrl(" http://127.0.0.1:8000/proxy// ")).toBe("http://127.0.0.1:8000/proxy");
    for (const bad of ["ftp://x", "localhost:11434", "http://", "http://user:pass@host", "http://a b", "http://host?key=1", "javascript:alert(1)"]) expect(normalizeBaseUrl(bad), bad).toBeUndefined();
    expect(() => new OpenAiCompatibleProvider({ baseUrl: "http://user:" + KEY + "@host", fetch: fake(() => reply(200, {})).fetch })).toThrow(/invalid_base_url/);
    expect(hostOf("http://localhost:11434/x")).toBe("localhost:11434");
  });
});

describe("a call", () => {
  it("posts to <base>/v1/chat/completions with the messages, the parameters and the answer's JSON Schema as response_format, and reads the text and the usage", async () => {
    const f = fake(() => reply(200, completion({ content: '{"action":"idle"}' }, { prompt_tokens: 120, completion_tokens: 9 })));
    const p = new OpenAiCompatibleProvider({ baseUrl: `${BASE}/`, fetch: f.fetch, now: () => 1000 });
    const r = await p.call(request());
    expect(r).toEqual({ outcome: "ok", latencyMs: 0, content: '{"action":"idle"}', usage: { inputTokens: 120, outputTokens: 9 } });
    const s = f.seen[0] as Seen;
    expect(s.url).toBe(`${BASE}/v1/chat/completions`);
    expect(s.init.method).toBe("POST");
    expect(s.init.headers["content-type"]).toBe("application/json");
    expect(s.init.headers["authorization"]).toBeUndefined();
    expect(s.init.redirect).toBe("error"); // a redirect is an error, not a second destination
    expect(bodyOf(s)).toEqual({
      model: "qwen2.5:7b",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      stream: false,
      temperature: 0,
      max_tokens: 200,
      top_p: 0.9,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: SCHEMA } },
    });
  });

  it("leaves out the usage when the server reports none (the brain then counts characters / 4 and labels it), and the response_format when told to", async () => {
    const f = fake(() => reply(200, completion({ content: "{}" })));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: f.fetch, structuredOutput: false });
    const r = await p.call(request());
    expect(r.usage).toBeUndefined();
    expect(bodyOf(f.seen[0] as Seen)["response_format"]).toBeUndefined();
  });

  it("offers the tools as functions and, with tools on offer, no response_format (the model must be free to call one); reads the calls it asks for, with their ids and parsed arguments", async () => {
    const f = fake(() => reply(200, completion({ content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "planPath", arguments: '{"to":"home"}' } }, { type: "function", function: { name: "querySpace", arguments: "" } }] })));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: f.fetch });
    const r = await p.call(request({ tools: [{ name: "planPath", description: "plan", paramsSchema: { type: "object" } }] }));
    expect(r.outcome).toBe("ok");
    expect(r.toolCalls).toEqual([
      { id: "call_a", name: "planPath", params: { to: "home" } },
      { id: "call-2", name: "querySpace", params: {} },
    ]);
    const body = bodyOf(f.seen[0] as Seen);
    expect(body["tools"]).toEqual([{ type: "function", function: { name: "planPath", description: "plan", parameters: { type: "object" } } }]);
    expect(body["response_format"]).toBeUndefined();
  });

  it("sends an assistant's tool calls as tool_calls with JSON arguments and each answer as a tool message naming its call", async () => {
    const f = fake(() => reply(200, completion({ content: "{}" })));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: f.fetch });
    await p.call(
      request({
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "planPath", params: { to: "home" } }] },
          { role: "tool", toolCallId: "call_a", name: "planPath", content: '{"status":"found"}' },
        ],
      }),
    );
    expect(bodyOf(f.seen[0] as Seen)["messages"]).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "planPath", arguments: '{"to":"home"}' } }] },
      { role: "tool", tool_call_id: "call_a", name: "planPath", content: '{"status":"found"}' },
    ]);
  });

  it("sends the key as a bearer token in one header, and only then", async () => {
    const f = fake(() => reply(200, completion({ content: "{}" })));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, apiKey: KEY, fetch: f.fetch });
    await p.call(request());
    const s = f.seen[0] as Seen;
    expect(s.init.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(s.url).not.toContain(KEY);
    expect(s.init.body).not.toContain(KEY);
    expect(Object.values(s.init.headers).filter((v) => v.includes(KEY))).toHaveLength(1);
  });
});

describe("how a call fails (no request, header, response body or key in any text)", () => {
  const failing = async (answer: Parameters<typeof fake>[0], req = request()) => new OpenAiCompatibleProvider({ baseUrl: BASE, apiKey: KEY, fetch: fake(answer).fetch }).call(req);

  it("maps a status to http_error with the code and a word, and never prints what the server sent back", async () => {
    const r = await failing(() => reply(404, { error: { message: `model not found; your request was ${KEY} {"messages": ["secret prompt"]}` } }));
    expect(r.outcome).toBe("error");
    expect(r.error).toBe("http_error 404: the server does not know this address or model (status 404)");
    expect((await failing(() => reply(401, "denied"))).error).toContain("http_error 401");
    expect((await failing(() => reply(503, "<html>overloaded</html>"))).error).toBe("http_error 503: the server answered with an error (status 503)");
  });

  it("maps a failed connection to network, naming only the host (the underlying error can carry the URL and the request)", async () => {
    const r = await failing(() => {
      throw new TypeError(`fetch failed: ${BASE}/v1/chat/completions with Authorization: Bearer ${KEY}`);
    });
    expect(r).toMatchObject({ outcome: "error", error: "network: could not reach localhost:11434" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("maps a call that outlives its limit to timeout and aborts the request", async () => {
    let aborted = false;
    const p = new OpenAiCompatibleProvider({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: (_u, init) =>
        new Promise((_res, rej) => {
          (init.signal as { addEventListener(t: string, f: () => void): void }).addEventListener("abort", () => {
            aborted = true;
            rej(new Error(`aborted ${KEY}`));
          });
        }),
    });
    const t0 = Date.now();
    const r = await p.call(request({ timeoutMs: 30 }));
    expect(r).toMatchObject({ outcome: "timeout", error: expect.stringContaining("timeout: no answer in") });
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("maps an answer that is not a completion to invalid_response, and a refusal or a content filter to refused", async () => {
    expect((await failing(() => reply(200, "not json"))).error).toBe("invalid_response: the server's answer is not JSON");
    expect((await failing(() => reply(200, { choices: [] }))).error).toBe("invalid_response: the server's answer has no message");
    expect((await failing(() => reply(200, completion({ content: "" })))).error).toBe("invalid_response: the server's answer is empty");
    expect((await failing(() => reply(200, completion({ content: null, tool_calls: [{ function: { name: "planPath", arguments: "{oops" } }] })))).error).toBe("invalid_response: the arguments of the call to planPath are not JSON");
    expect((await failing(() => reply(200, completion({ content: null, refusal: "I cannot help with that" })))).error).toBe("refused: the model refused to answer");
    expect((await failing(() => reply(200, { choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] }))).error).toBe("refused: the server's content filter stopped the answer");
  });

  it("parseCompletion reads what a server gives, in the forms the three common servers use", () => {
    expect(parseCompletion(JSON.stringify(completion({ content: "hi" }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })))).toEqual({ ok: true, content: "hi", usage: { inputTokens: 1, outputTokens: 2 } });
    // Arguments given as an object (some servers do) are taken as they are.
    expect(parseCompletion(JSON.stringify(completion({ content: null, tool_calls: [{ id: "t", function: { name: "n", arguments: { a: 1 } } }] })))).toEqual({ ok: true, toolCalls: [{ id: "t", name: "n", params: { a: 1 } }] });
  });
});

describe("the models of a server", () => {
  it("lists them by id from GET <base>/v1/models, sorted, and says why it could not", async () => {
    const f = fake(() => reply(200, { object: "list", data: [{ id: "qwen2.5:7b" }, { id: "llama3.2:1b" }, { object: "model" }] }));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, apiKey: KEY, fetch: f.fetch });
    expect(await p.listModels()).toEqual({ ok: true, models: ["llama3.2:1b", "qwen2.5:7b"] });
    expect(f.seen[0]).toMatchObject({ url: `${BASE}/v1/models`, init: { method: "GET" } });
    expect(f.seen[0]?.init.body).toBeUndefined();
    expect(await new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: fake(() => reply(401, "x")).fetch }).listModels()).toMatchObject({ ok: false, kind: "http_error", status: 401 });
    expect(await new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: fake(() => reply(200, { nope: 1 })).fetch }).listModels()).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(
      await new OpenAiCompatibleProvider({
        baseUrl: BASE,
        fetch: () => {
          throw new Error(KEY);
        },
      }).listModels(),
    ).toEqual({ ok: false, kind: "network", message: "could not reach localhost:11434" });
  });
});

describe("a key goes nowhere but the header, and the only destination is the configured address", () => {
  const GOTO = { type: "object", additionalProperties: false, required: ["xM", "yM"], properties: { xM: { type: "number" }, yM: { type: "number" } } };
  const req = {
    agentId: "ugv-001", tick: 12, simTimeS: 1.2, events: [{ kind: "start" }], eventsDropped: 0,
    self: { kind: "ugv", xM: 1, yM: 2, headingRad: 0, soc: 1, running: null, timers: [] }, beliefs: {}, space: {},
    allowedActions: [{ name: "goTo", paramsSchema: GOTO }], unavailable: [],
  } as unknown as DecisionRequest;

  it("a mind run over the adapter with a planted key: the key is in no record, cache entry, thrown message or JSON of the provider, every call went to the base URL, and the header held it", async () => {
    const urls: string[] = [];
    let n = 0;
    const answers = [reply(503, "overloaded"), reply(200, completion({ content: "oops not json" })), reply(200, completion({ content: '{"action":"goTo","params":{"xM":5,"yM":6}}' }, { prompt_tokens: 10, completion_tokens: 5 }))];
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "http://localhost:8000/api",
      apiKey: KEY,
      fetch: (url, init) => {
        urls.push(url);
        expect(init.headers["authorization"]).toBe(`Bearer ${KEY}`);
        return Promise.resolve(answers[n++] ?? reply(500, ""));
      },
    });
    const records: unknown[] = [];
    const trace: TraceSink = { emit: (r) => (records.push(r), `run-000001#${records.length}`) };
    const cache = new MemoryMindCache();
    const brain = new LlmBrain({
      id: "b", effective: { provider: "p", model: "m", params: {}, promptTemplate: { id: "default", version: 1 }, tools: { maxCallsPerDecision: 8 }, context: { decisions: 5 }, limits: { ...MIND_DEFAULTS.limits, retries: 2 }, latency: { model: "measured" } },
      template: DEFAULT_PROMPT_TEMPLATE, provider, cache, mode: "live",
    });
    const env = await brain.decide(req, { trace, requestRecordId: "run-000001#0" });
    expect(env.decision).toEqual({ kind: "action", name: "goTo", params: { xM: 5, yM: 6 } });
    expect(urls).toEqual(["http://localhost:8000/api/v1/chat/completions", "http://localhost:8000/api/v1/chat/completions", "http://localhost:8000/api/v1/chat/completions"]);
    const everything = JSON.stringify({ records, cache: [...cache.entries], env, provider, state: brain.snapshotState() });
    expect(everything).not.toContain(KEY);
    // A run that fails outright says why without the key either.
    const dead = new LlmBrain({ id: "b2", effective: { provider: "p", model: "m", params: {}, promptTemplate: { id: "default", version: 1 }, tools: { maxCallsPerDecision: 8 }, context: { decisions: 5 }, limits: { ...MIND_DEFAULTS.limits, retries: 0 }, latency: { model: "measured" } }, template: DEFAULT_PROMPT_TEMPLATE, provider: new OpenAiCompatibleProvider({ baseUrl: BASE, apiKey: KEY, fetch: () => Promise.reject(new Error(KEY)) }), cache: new MemoryMindCache(), mode: "live" });
    const r2: unknown[] = [];
    const fb = await dead.decide(req, { trace: { emit: (r) => (r2.push(r), "id") } });
    expect(JSON.stringify({ fb, r2 })).not.toContain(KEY);
    expect(JSON.stringify(fb)).toContain("network: could not reach localhost:11434");
  });

  it("is told nothing it could send a key with: no field of the provider holds it, and the request it builds has none", () => {
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, apiKey: KEY, fetch: fake(() => reply(200, {})).fetch });
    expect(JSON.stringify(p)).toBe('{"kind":"openai-compatible","baseUrl":"http://localhost:11434","hasKey":true}');
    expect(Object.keys(p)).toEqual(["kind"]);
    expect(String(Object.getOwnPropertyNames(p))).not.toContain("key");
  });

  it("a call to an address the base URL does not name cannot be made: the paths are the adapter's own", async () => {
    const f = fake(() => reply(200, completion({ content: "{}" })));
    const p = new OpenAiCompatibleProvider({ baseUrl: BASE, fetch: f.fetch });
    await p.call(request({ model: "http://evil.example/steal" }));
    await p.listModels();
    expect(f.seen.every((s) => s.url.startsWith(`${BASE}/v1/`))).toBe(true);
    expect(f.seen.map((s) => s.url)).toEqual([`${BASE}/v1/chat/completions`, `${BASE}/v1/models`]);
    void setTimeout;
  });
});
