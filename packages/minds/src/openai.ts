import type { ChatMessage, ProviderPort, ProviderRequest, ProviderResponse, ProviderUsage, ToolCall } from "./provider.ts";

// The adapter for OpenAI-compatible servers (F4 M3, ADR-0044 §1: Ollama, vLLM, SGLang, LM Studio, llama.cpp's server, and the clouds that speak the same dialect): `POST <base>/v1/chat/completions` and `GET
// <base>/v1/models` with the `fetch` of the sim worker, no SDK. It is the only code that holds a key. The key is a private field, goes into one header of the request to the configured base URL and nowhere else:
// not in the request object, a response, a record, a cache entry, an error text or the object's own JSON. No error text carries a request body, a header, a response body or a URL beyond the host: a status
// code and a word. The destination of every call is built from the base URL it was given, and from nothing else.

// The platform's own pieces, named structurally: this package is built without a library that declares them.
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}

export interface FetchInit {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: unknown;
}
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface OpenAiProviderOptions {
  /** `http://localhost:11434` (no path: the adapter adds `/v1/...`). Only http and https. */
  readonly baseUrl: string;
  /** The bearer key, when the server asks for one. Never stored anywhere but in this object's private field. */
  readonly apiKey?: string | undefined;
  /** The `fetch` to use (a test gives a fake one; the worker gives its own). */
  readonly fetch: FetchLike;
  /** Wall clock in ms (a test pins it). */
  readonly now?: () => number;
  /** Whether to ask for the answer's JSON Schema as `response_format` (default true). A server that cannot enforce it is given the schema in the prompt either way, and the answer is validated as ever. */
  readonly structuredOutput?: boolean;
}

/** Why a call or a listing failed, as a word the UI and the records can show. */
export type ProviderErrorKind = "timeout" | "http_error" | "network" | "invalid_response" | "refused";

export type ModelList = { readonly ok: true; readonly models: readonly string[] } | { readonly ok: false; readonly kind: ProviderErrorKind; readonly status?: number; readonly message: string };

/** The base URL without a trailing slash, or undefined when it is not an http(s) URL with a host. Userinfo is refused: a key does not belong in an address. */
export function normalizeBaseUrl(raw: string): string | undefined {
  const m = /^(https?):\/\/([^/?#@\s]+)(\/[^?#\s]*)?$/i.exec(raw.trim());
  if (m === null) return undefined;
  const path = (m[3] ?? "").replace(/\/+$/, "");
  return `${(m[1] as string).toLowerCase()}://${m[2] as string}${path}`;
}

/** The host of a base URL (`localhost:11434`): what an error may name. */
export function hostOf(base: string): string {
  const m = /^https?:\/\/([^/]+)/i.exec(base);
  return m?.[1] ?? "the server";
}

const STATUS_WORDS: Readonly<Record<number, string>> = {
  400: "the server did not accept the request",
  401: "the server wants a key, or refused the one given",
  403: "the server refused the request",
  404: "the server does not know this address or model",
  408: "the server timed out",
  413: "the request is too large for the server",
  422: "the server could not process the request",
  429: "the server is busy or the rate limit is reached",
};

export class OpenAiCompatibleProvider implements ProviderPort {
  readonly kind = "openai-compatible";
  readonly #key: string | undefined;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #structured: boolean;

  constructor(o: OpenAiProviderOptions) {
    const base = normalizeBaseUrl(o.baseUrl);
    if (base === undefined) throw new Error("invalid_base_url: a provider address is http:// or https:// followed by a host");
    this.#base = base;
    this.#key = o.apiKey === undefined || o.apiKey === "" ? undefined : o.apiKey;
    this.#fetch = o.fetch;
    this.#now = o.now ?? (() => Date.now());
    this.#structured = o.structuredOutput !== false;
  }

  /** Where this adapter sends calls: its base URL, and nothing else. */
  get baseUrl(): string {
    return this.#base;
  }

  /** The object has no enumerable field that could carry a key; this keeps `JSON.stringify` and a log line honest too. */
  toJSON(): { kind: string; baseUrl: string; hasKey: boolean } {
    return { kind: this.kind, baseUrl: this.#base, hasKey: this.#key !== undefined };
  }

  private headers(json: boolean): Record<string, string> {
    return { accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...(this.#key === undefined ? {} : { authorization: `Bearer ${this.#key}` }) };
  }

  /** One request with a wall-clock limit; errors become words. */
  private async send(path: string, init: Omit<FetchInit, "signal" | "headers">, json: boolean, timeoutMs: number): Promise<{ ok: true; text: string } | { ok: false; kind: ProviderErrorKind; status?: number; message: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await this.#fetch(`${this.#base}${path}`, { ...init, headers: this.headers(json), signal: controller.signal });
      const text = await res.text();
      if (!res.ok) return { ok: false, kind: "http_error", status: res.status, message: `${STATUS_WORDS[res.status] ?? "the server answered with an error"} (status ${res.status})` };
      return { ok: true, text };
    } catch {
      // The reason of a failed fetch can name the URL or echo the request: only the fact is kept.
      return timedOut ? { ok: false, kind: "timeout", message: `no answer in ${Math.round(timeoutMs / 1000)} s` } : { ok: false, kind: "network", message: `could not reach ${hostOf(this.#base)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const t0 = this.#now();
    const tools = req.tools !== undefined && req.tools.length > 0 ? req.tools : undefined;
    const body = {
      model: req.model,
      messages: req.messages.map(toWire),
      stream: false,
      ...(req.params.temperature === undefined ? {} : { temperature: req.params.temperature }),
      ...(req.params.maxOutputTokens === undefined ? {} : { max_tokens: req.params.maxOutputTokens }),
      ...(req.params.topP === undefined ? {} : { top_p: req.params.topP }),
      ...(tools === undefined ? {} : { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.paramsSchema } })) }),
      // With tools on offer the model must be free to call one: the schema then stays in the prompt, and the brain validates the final answer as ever.
      ...(this.#structured && tools === undefined ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: req.answerSchema } } } : {}),
    };
    const r = await this.send("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) }, true, req.timeoutMs);
    const latencyMs = Math.max(0, this.#now() - t0);
    if (!r.ok) return { outcome: r.kind === "timeout" ? "timeout" : "error", latencyMs, error: `${r.kind}${r.status === undefined ? "" : ` ${r.status}`}: ${r.message}` };
    const parsed = parseCompletion(r.text);
    if (!parsed.ok) return { outcome: "error", latencyMs, error: `${parsed.kind}: ${parsed.message}` };
    return { outcome: "ok", latencyMs, ...(parsed.content === undefined ? {} : { content: parsed.content }), ...(parsed.toolCalls === undefined ? {} : { toolCalls: parsed.toolCalls }), ...(parsed.usage === undefined ? {} : { usage: parsed.usage }) };
  }

  /** The models the server lists (`GET /v1/models`), by id. */
  async listModels(timeoutMs = 10_000): Promise<ModelList> {
    const r = await this.send("/v1/models", { method: "GET" }, false, timeoutMs);
    if (!r.ok) return { ok: false, kind: r.kind, ...(r.status === undefined ? {} : { status: r.status }), message: r.message };
    try {
      const j = JSON.parse(r.text) as { data?: unknown };
      if (!Array.isArray(j.data)) return { ok: false, kind: "invalid_response", message: "the server's list of models is not in the expected form" };
      const ids = (j.data as unknown[]).flatMap((m) => (typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string" ? [(m as { id: string }).id] : []));
      return { ok: true, models: ids.sort() };
    } catch {
      return { ok: false, kind: "invalid_response", message: "the server's list of models is not JSON" };
    }
  }
}

// ---- the dialect -----------------------------------------------------------------------------------------------------------------------------------

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, ...(m.name === undefined ? {} : { name: m.name }), content: m.content };
  if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return { role: "assistant", content: m.content === "" ? null : m.content, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.params ?? {}) } })) };
  }
  return { role: m.role, content: m.content };
}

type Parsed = { ok: true; content?: string; toolCalls?: ToolCall[]; usage?: ProviderUsage } | { ok: false; kind: ProviderErrorKind; message: string };

/** The answer of a completion: its text, the tools it asks for, and the usage the server reported (none when it did not: the brain then counts characters / 4 and says so). */
export function parseCompletion(text: string): Parsed {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, kind: "invalid_response", message: "the server's answer is not JSON" };
  }
  const choice = (j as { choices?: unknown }).choices;
  const first = Array.isArray(choice) ? (choice[0] as { message?: Record<string, unknown>; finish_reason?: unknown } | undefined) : undefined;
  const msg = first?.message;
  if (msg === undefined || typeof msg !== "object") return { ok: false, kind: "invalid_response", message: "the server's answer has no message" };
  if (typeof msg["refusal"] === "string" && msg["refusal"] !== "") return { ok: false, kind: "refused", message: "the model refused to answer" };
  if (first?.finish_reason === "content_filter") return { ok: false, kind: "refused", message: "the server's content filter stopped the answer" };
  const content = typeof msg["content"] === "string" && msg["content"] !== "" ? msg["content"] : undefined;
  let toolCalls: ToolCall[] | undefined;
  const raw = msg["tool_calls"];
  if (Array.isArray(raw) && raw.length > 0) {
    toolCalls = [];
    for (const [i, c] of (raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]).entries()) {
      const name = c.function?.name;
      if (typeof name !== "string") return { ok: false, kind: "invalid_response", message: "a tool call has no name" };
      let params: unknown = {};
      const args = c.function?.arguments;
      if (typeof args === "string" && args.trim() !== "") {
        try {
          params = JSON.parse(args);
        } catch {
          return { ok: false, kind: "invalid_response", message: `the arguments of the call to ${name.slice(0, 64)} are not JSON` };
        }
      } else if (typeof args === "object" && args !== null) params = args;
      toolCalls.push({ id: typeof c.id === "string" && c.id !== "" ? c.id : `call-${i + 1}`, name, params });
    }
  }
  if (content === undefined && toolCalls === undefined) return { ok: false, kind: "invalid_response", message: "the server's answer is empty" };
  const u = (j as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  const usage = u !== undefined && typeof u === "object" && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number" ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : undefined;
  return { ok: true, ...(content === undefined ? {} : { content }), ...(toolCalls === undefined ? {} : { toolCalls }), ...(usage === undefined ? {} : { usage }) };
}
