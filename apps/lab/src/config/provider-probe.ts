import { hostOf, OpenAiCompatibleProvider, type FetchLike } from "@agentsim/minds";

// "Test connection" of Settings (F4 M3, ADR-0044 section 2, the designer's Providers board): reach the server, list its models, and ask two tiny things of it (a call with a tool on offer, a call with the
// answer's JSON Schema as response_format) so that the result says in words what the server can do. Each probe sends about 40 tokens, counts toward no limit and is made from this page, with its own `fetch`, to the
// address being tested and nowhere else. Nothing of the exchange is kept: only the words.

export type ProbeKind = "ok" | "not_allowed" | "cors" | "unreachable" | "timeout" | "http_error" | "invalid_response";

export interface ProbeResult {
  readonly ok: boolean;
  readonly kind: ProbeKind;
  readonly latencyMs: number;
  readonly models: readonly string[];
  readonly tools?: "answered" | "no tool call in the answer" | "failed";
  readonly structured?: "json_schema supported" | "not enforced" | "failed";
  readonly status?: number;
  /** What the result says, as a sentence. */
  readonly summary: string;
}

export interface ProbeDeps {
  readonly fetch: FetchLike;
  /** Whether the page's policy lets it call this address; undefined when the policy is not known (then the call is tried). */
  readonly allowed: (baseUrl: string) => boolean | undefined;
  /** Whether the address answers at all when the answer is opaque to the page (a `no-cors` request): tells a page the server blocked (CORS) from a server that is not there. */
  readonly reachable: (baseUrl: string) => Promise<boolean>;
  readonly now?: () => number;
  /** The model to ask the two small things of (default: the first the server lists). */
  readonly model?: string | undefined;
}

const PING_TOOL = { name: "ping", description: "Call this tool to say that tools work.", paramsSchema: { type: "object", properties: {}, additionalProperties: false } };
const OK_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const THIS_ORIGIN = "<this page's origin>";

export async function probeProvider(baseUrl: string, key: string | undefined, deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const done = (r: Omit<ProbeResult, "latencyMs" | "models"> & { models?: readonly string[] }): ProbeResult => ({ latencyMs: now() - t0, models: [], ...r });
  if (deps.allowed(baseUrl) === false) {
    return done({ ok: false, kind: "not_allowed", summary: `this page may not call ${hostOf(baseUrl)}: the policy it was served with lists localhost and 127.0.0.1 and the addresses its server added` });
  }
  const p = new OpenAiCompatibleProvider({ baseUrl, apiKey: key, fetch: deps.fetch, now });
  const listed = await p.listModels(10_000);
  if (!listed.ok) {
    if (listed.kind === "network") {
      const reached = await deps.reachable(baseUrl);
      return reached
        ? done({
            ok: false,
            kind: "cors",
            summary: `blocked by the browser (CORS): the server answered but did not allow this page's origin. Start it with the origin allowed: Ollama OLLAMA_ORIGINS=${THIS_ORIGIN} · vLLM --allowed-origins '["${THIS_ORIGIN}"]' · SGLang see the server's CORS option`,
          })
        : done({ ok: false, kind: "unreachable", summary: `could not reach ${hostOf(baseUrl)}: is the server running, and is the address right?` });
    }
    return done({ ok: false, kind: listed.kind === "timeout" ? "timeout" : listed.kind === "http_error" ? "http_error" : "invalid_response", ...(listed.status === undefined ? {} : { status: listed.status }), summary: listed.message });
  }
  const model = deps.model ?? listed.models[0];
  if (model === undefined) return done({ ok: true, kind: "ok", models: [], summary: `reached in ${now() - t0} ms · the server lists no model` });
  const base = { model, params: { temperature: 0, maxOutputTokens: 40 }, timeoutMs: 30_000, attempt: 1 } as const;
  const asked = await p.call({ ...base, messages: [{ role: "user", content: "Call the tool ping." }], answerSchema: OK_SCHEMA, tools: [PING_TOOL] });
  const tools = asked.outcome !== "ok" ? "failed" : asked.toolCalls !== undefined && asked.toolCalls.some((c) => c.name === "ping") ? "answered" : "no tool call in the answer";
  const shaped = await p.call({ ...base, messages: [{ role: "user", content: 'Answer with the JSON object {"ok": true}.' }], answerSchema: OK_SCHEMA });
  let structured: ProbeResult["structured"] = "failed";
  if (shaped.outcome === "ok") {
    try {
      const j = JSON.parse(shaped.content ?? "") as { ok?: unknown };
      structured = typeof j === "object" && j !== null && typeof j.ok === "boolean" ? "json_schema supported" : "not enforced";
    } catch {
      structured = "not enforced";
    }
  }
  const shown = listed.models.slice(0, 3).join(", ") + (listed.models.length > 3 ? ` and ${listed.models.length - 3} more` : "");
  return done({
    ok: true,
    kind: "ok",
    models: listed.models,
    tools,
    structured,
    summary: `reached in ${now() - t0} ms · ${listed.models.length} model${listed.models.length === 1 ? "" : "s"}: ${shown} · tool calls: ${tools === "answered" ? "answered (probe)" : tools} · structured output: ${structured}`,
  });
}
