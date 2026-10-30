import { createMemoryPorts, PROVIDER_KEYS_NAMESPACE } from "@agentsim/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeProvider, type ProbeDeps } from "./provider-probe.ts";
import { cleanAddress, ProviderStore } from "./providers.ts";
import { connectAllowed, connectSrcLine, parseConnectSrc, readPagePolicy } from "./network-policy.ts";

// The provider entries and keys of Settings (F4 M3), the test of a connection, and what the page's policy lets it call. No server, no real key.

const KEY = "planted-settings-key-424242";
const entry = { id: "local-ollama", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434" };

describe("the provider store", () => {
  let user: ReturnType<typeof createMemoryPorts>["userData"];
  let store: ProviderStore;
  beforeEach(() => {
    user = createMemoryPorts().userData;
    store = new ProviderStore();
  });

  it("keeps an entry in user data and a key in memory only, unless the user chose to remember it; the entry never holds the key", async () => {
    await store.load(user);
    await store.save(entry, KEY, false);
    expect(store.keyState("local-ollama")).toBe("session");
    expect(store.keyOf("local-ollama")).toBe(KEY);
    expect(JSON.stringify(await user.get("providers", "entries"))).not.toContain(KEY);
    expect(await user.keys(PROVIDER_KEYS_NAMESPACE)).toEqual([]);
    // Remembered: also under its own namespace, and a new page finds it again.
    await store.save(entry, undefined, true);
    expect(store.keyState("local-ollama")).toBe("device");
    expect(await user.get(PROVIDER_KEYS_NAMESPACE, "local-ollama")).toBe(KEY);
    const next = new ProviderStore();
    await next.load(user);
    expect(next.list().map((e) => e.id)).toEqual(["local-ollama"]);
    expect(next.keyState("local-ollama")).toBe("device");
    expect(next.keyOf("local-ollama")).toBe(KEY);
    // A session-only key is gone with the page.
    await store.save(entry, undefined, false);
    expect(await user.keys(PROVIDER_KEYS_NAMESPACE)).toEqual([]);
    const fresh = new ProviderStore();
    await fresh.load(user);
    expect(fresh.keyState("local-ollama")).toBe("none");
  });

  it("an empty key removes it, undefined leaves it, and removing the entry removes every copy", async () => {
    await store.load(user);
    await store.save(entry, KEY, true);
    await store.save(entry, undefined, true);
    expect(store.keyState("local-ollama")).toBe("device");
    await store.save(entry, "", true);
    expect(store.keyState("local-ollama")).toBe("none");
    expect(await user.keys(PROVIDER_KEYS_NAMESPACE)).toEqual([]);
    await store.save(entry, KEY, true);
    await store.remove("local-ollama");
    expect(store.list()).toEqual([]);
    expect(store.keyOf("local-ollama")).toBeUndefined();
    expect(await user.keys(PROVIDER_KEYS_NAMESPACE)).toEqual([]);
    expect(JSON.stringify(await user.get("providers", "entries"))).not.toContain("local-ollama");
  });

  it("tells the worker its keys, as a whole, whenever they change (and only through that call)", async () => {
    const told: Record<string, string>[] = [];
    store.connectKeys((k) => told.push({ ...k }));
    await store.load(user);
    await store.save(entry, KEY, false);
    await store.save({ ...entry, id: "lab-vllm", baseUrl: "http://192.168.1.20:8000" }, "other-key", false);
    await store.remove("local-ollama");
    expect(told.at(-1)).toEqual({ "lab-vllm": "other-key" });
    expect(told.some((k) => k["local-ollama"] === KEY)).toBe(true);
    expect(JSON.stringify(store.getView())).not.toContain(KEY);
    expect(JSON.stringify(store.getView())).not.toContain("other-key");
  });

  it("ignores stored entries that are not well-formed, and keeps the test's words with the entry", async () => {
    await user.set("providers", "entries", [{ id: "Bad Id", kind: "openai-compatible", baseUrl: "http://x" }, { id: "ok-one", kind: "openai-compatible", baseUrl: "ftp://x" }, { id: "good", kind: "openai-compatible", baseUrl: "http://localhost:1/", models: ["a", 5], prices: { inputUsdPerMTok: 1, outputUsdPerMTok: -1 } }, 7]);
    await store.load(user);
    expect(store.list()).toEqual([{ id: "good", kind: "openai-compatible", baseUrl: "http://localhost:1", models: ["a"], rememberKey: false }]);
    await store.setTested("good", { atMs: 5, ok: true, summary: "reached in 3 ms" }, ["m1"]);
    expect(store.get("good")).toMatchObject({ models: ["m1"], tested: { ok: true, summary: "reached in 3 ms" } });
  });

  it("cleans an address as typed: /v1 and a trailing slash are dropped, a key in the address or a non-http scheme is refused", () => {
    expect(cleanAddress("http://localhost:30000/v1")).toBe("http://localhost:30000");
    expect(cleanAddress(" https://api.example.com/v1/ ")).toBe("https://api.example.com");
    expect(cleanAddress("localhost:30000")).toBeUndefined();
    expect(cleanAddress("http://user:key@host")).toBeUndefined();
  });
});

describe("what the page may call", () => {
  const SELF = "http://localhost:4173";
  const TOKENS = ["'self'", "http://localhost:*", "http://127.0.0.1:*"];
  it("reads connect-src from a policy and allows localhost and 127.0.0.1 on any port, the page itself, and what the server listed; nothing else", () => {
    expect(parseConnectSrc("default-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*; img-src data:")).toEqual(TOKENS);
    expect(parseConnectSrc("default-src 'self'")).toBeUndefined();
    expect(connectAllowed("http://localhost:11434", TOKENS, SELF)).toBe(true);
    expect(connectAllowed("http://127.0.0.1:8000", TOKENS, SELF)).toBe(true);
    expect(connectAllowed("http://192.168.1.20:8000", TOKENS, SELF)).toBe(false);
    expect(connectAllowed("https://localhost:11434", TOKENS, SELF)).toBe(false);
    expect(connectAllowed("http://evil.example", TOKENS, SELF)).toBe(false);
    expect(connectAllowed("http://192.168.1.20:8000", [...TOKENS, "http://192.168.1.20:8000"], SELF)).toBe(true);
    expect(connectAllowed("http://192.168.1.20:9000", [...TOKENS, "http://192.168.1.20:8000"], SELF)).toBe(false);
    expect(connectAllowed("ws://localhost:1", TOKENS, SELF)).toBe(false);
  });
  it("reads the policy the page was served with from its own headers, and offers the line a server adds for more addresses", async () => {
    const f = vi.fn(() => Promise.resolve({ headers: { get: (n: string) => (n === "content-security-policy" ? "default-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*" : null) } }));
    expect(await readPagePolicy(f, "http://localhost:4173/")).toEqual(TOKENS);
    expect(f).toHaveBeenCalledWith("http://localhost:4173/", { method: "HEAD" });
    expect(await readPagePolicy(() => Promise.reject(new Error("x")), "http://h/")).toBeUndefined();
    expect(connectSrcLine(["http://192.168.1.20:8000/", "https://api.example.com", "nonsense"])).toBe("connect-src 'self' http://localhost:* http://127.0.0.1:* http://192.168.1.20:8000 https://api.example.com:443");
  });
});

describe("test connection", () => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
  const server = (over: { tools?: boolean; structured?: boolean } = {}): ProbeDeps["fetch"] => (url, init) => {
    if (url.endsWith("/v1/models")) return Promise.resolve(res(200, { data: [{ id: "qwen2.5:7b" }, { id: "llama3.2:1b" }, { id: "c" }, { id: "d" }] }));
    const body = JSON.parse(init.body ?? "{}") as { tools?: unknown };
    if (body.tools !== undefined) return Promise.resolve(res(200, { choices: [{ message: over.tools === false ? { content: "I do not call tools" } : { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{}" } }] } }] }));
    return Promise.resolve(res(200, { choices: [{ message: { content: over.structured === false ? "Sure! ok" : '{"ok":true}' } }] }));
  };
  const deps = (f: ProbeDeps["fetch"], over: Partial<ProbeDeps> = {}): ProbeDeps => ({ fetch: f, allowed: () => true, reachable: () => Promise.resolve(false), now: () => 0, ...over });

  it("says in words what it found: the models, tool calls answered, structured output supported", async () => {
    const r = await probeProvider("http://localhost:11434", KEY, deps(server()));
    expect(r).toMatchObject({ ok: true, kind: "ok", tools: "answered", structured: "json_schema supported", models: ["c", "d", "llama3.2:1b", "qwen2.5:7b"] });
    expect(r.summary).toBe("reached in 0 ms · 4 models: c, d, llama3.2:1b and 1 more · tool calls: answered (probe) · structured output: json_schema supported");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("says when the server did not call the tool or did not enforce the schema", async () => {
    const r = await probeProvider("http://localhost:11434", undefined, deps(server({ tools: false, structured: false })));
    expect(r).toMatchObject({ ok: true, tools: "no tool call in the answer", structured: "not enforced" });
  });

  it("tells a page the server blocked (CORS) from a server that is not there, and a policy that does not allow the address from both", async () => {
    const down: ProbeDeps["fetch"] = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await probeProvider("http://localhost:11434", KEY, deps(down, { reachable: () => Promise.resolve(true) }))).toMatchObject({ ok: false, kind: "cors" });
    expect((await probeProvider("http://localhost:11434", KEY, deps(down, { reachable: () => Promise.resolve(true) }))).summary).toContain("OLLAMA_ORIGINS=");
    expect(await probeProvider("http://localhost:11434", KEY, deps(down))).toMatchObject({ ok: false, kind: "unreachable" });
    const blocked = vi.fn(down);
    expect(await probeProvider("http://192.168.1.20:8000", KEY, deps(blocked, { allowed: () => false }))).toMatchObject({ ok: false, kind: "not_allowed" });
    expect(blocked).not.toHaveBeenCalled(); // nothing is sent to an address the policy does not allow
  });

  it("maps a refusal of the key and an answer that is not a model list, and sends the key only to the address being tested", async () => {
    expect(await probeProvider("http://localhost:11434", undefined, deps(() => Promise.resolve(res(401, "no"))))).toMatchObject({ ok: false, kind: "http_error", status: 401 });
    expect(await probeProvider("http://localhost:11434", undefined, deps(() => Promise.resolve(res(200, { nope: 1 }))))).toMatchObject({ ok: false, kind: "invalid_response" });
    const urls: string[] = [];
    await probeProvider("http://localhost:11434", KEY, deps((u, i) => (urls.push(u + "|" + (i.headers["authorization"] ?? "")), server()(u, i))));
    expect(urls.every((u) => u.startsWith("http://localhost:11434/v1/") && u.endsWith(`|Bearer ${KEY}`))).toBe(true);
  });
});
