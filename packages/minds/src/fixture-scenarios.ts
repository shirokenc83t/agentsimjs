import type { FetchInit, FetchLike, FetchResponse, OpenAiCompatibleProvider } from "./openai.ts";
import type { JsonSchema, ProviderResponse } from "./provider.ts";

// The six things the adapter is checked for against a server (F4 M3, T-120): the model list, a plain answer, an answer in a JSON Schema, a tool-call round trip, the usage, and the error of a wrong model. The same
// scenarios run against a real local server (the recorder in tools/scripts/record-http-fixtures.mjs saves each HTTP exchange) and against the recorded exchanges (the test of the fixtures, in CI, no network).
// A recorded exchange holds the method, the path, the body of the request and the status and body of the answer: never a header, never a key, and the address is a placeholder.

export interface Exchange {
  readonly name: string;
  readonly request: { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown };
  readonly response: { readonly status: number; readonly body: unknown };
}

export interface FixtureFile {
  /** `ollama`, `vllm`, `sglang`, or `synthetic` for one written by hand in the dialect's shape. */
  readonly server: string;
  readonly version: string;
  readonly model: string;
  /** What the server did, as the scenarios saw it: the table of the documentation is made from this. */
  readonly summary: ScenarioSummary;
  readonly exchanges: readonly Exchange[];
}

export interface ScenarioSummary {
  readonly models: readonly string[];
  readonly plain: { readonly ok: boolean; readonly text: string };
  readonly structured: { readonly ok: boolean; readonly valid: boolean };
  readonly tools: { readonly asked: boolean; readonly answered: boolean };
  readonly usage: { readonly reported: boolean };
  readonly wrongModel: { readonly error: string | undefined };
}

const OK_SCHEMA: JsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const NUMBER_TOOL = { name: "get_number", description: "Returns the number the user asks about.", paramsSchema: { type: "object", properties: {}, additionalProperties: false } };
const BASE = { params: { temperature: 0, maxOutputTokens: 64 }, timeoutMs: 120_000, attempt: 1 } as const;

const parses = (r: ProviderResponse): boolean => {
  try {
    const j = JSON.parse(r.content ?? "") as { ok?: unknown };
    return typeof j === "object" && j !== null && typeof j.ok === "boolean";
  } catch {
    return false;
  }
};

/** Runs the scenarios through an adapter built by `make` (so the structured-output option can differ) for one model. */
export async function runScenarios(make: (o: { structuredOutput: boolean }) => OpenAiCompatibleProvider, model: string): Promise<ScenarioSummary> {
  const structured = make({ structuredOutput: true });
  const plainProvider = make({ structuredOutput: false });
  const listed = await structured.listModels();
  const plain = await plainProvider.call({ ...BASE, model, messages: [{ role: "user", content: "Say hello in one short sentence." }], answerSchema: OK_SCHEMA });
  const shaped = await structured.call({ ...BASE, model, messages: [{ role: "user", content: 'Answer with the JSON object {"ok": true}.' }], answerSchema: OK_SCHEMA });
  const first = await structured.call({ ...BASE, model, messages: [{ role: "user", content: "How many apples are there? Use the tool get_number to find out." }], answerSchema: OK_SCHEMA, tools: [NUMBER_TOOL] });
  const call = first.toolCalls?.[0];
  let answered = false;
  if (call !== undefined) {
    const second = await structured.call({
      ...BASE,
      model,
      messages: [
        { role: "user", content: "How many apples are there? Use the tool get_number to find out." },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, name: call.name, content: '{"number":7}' },
      ],
      answerSchema: OK_SCHEMA,
      tools: [NUMBER_TOOL],
    });
    answered = second.outcome === "ok" && (second.content ?? "").length > 0;
  }
  const wrong = await structured.call({ ...BASE, model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }], answerSchema: OK_SCHEMA });
  return {
    models: listed.ok ? listed.models : [],
    plain: { ok: plain.outcome === "ok", text: (plain.content ?? "").slice(0, 80) },
    structured: { ok: shaped.outcome === "ok", valid: parses(shaped) },
    tools: { asked: call !== undefined, answered },
    usage: { reported: plain.usage !== undefined && shaped.usage !== undefined },
    wrongModel: { error: wrong.outcome === "ok" ? undefined : wrong.error },
  };
}

// ---- recording and replay -----------------------------------------------------------------------------------------------------------------------

/** A `fetch` that goes through `inner` and writes each exchange down, with the address as a placeholder. */
export function recordingFetch(inner: FetchLike, baseUrl: string, out: Exchange[]): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
    const name = `${init.method} ${url.slice(baseUrl.length)}#${out.length + 1}`;
    out.push({
      name,
      request: { method: init.method, path: url.slice(baseUrl.length), ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) },
      response: { status: res.status, body },
    });
    return { ok: res.ok, status: res.status, text: () => Promise.resolve(text) } satisfies FetchResponse;
  };
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** A `fetch` that answers from recorded exchanges: the first unused one with the same method, path and body. A request the recording does not hold is a failure (the adapter's request shape changed). */
export function replayFetch(exchanges: readonly Exchange[], seen: string[] = []): FetchLike {
  const used = new Set<number>();
  return (url, init: FetchInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
    const i = exchanges.findIndex((e, k) => !used.has(k) && e.request.method === init.method && e.request.path === path && canonical(e.request.body) === canonical(body));
    seen.push(`${init.method} ${path}`);
    if (i < 0) return Promise.reject(new Error(`no recorded exchange for ${init.method} ${path}`));
    used.add(i);
    const r = (exchanges[i] as Exchange).response;
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body)) });
  };
}
