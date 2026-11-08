// The provider port (ADR-0044 §1): what a model call is, whatever the provider behind it. The adapter for OpenAI-compatible servers (M3) and the scripted fake provider of the tests both implement it.
// The port holds no key: a key is attached by an adapter, to the header of its own call, and never appears in a request, a response, a record or a cache entry.

export type JsonSchema = Record<string, unknown>;

/** A tool the model may call while it decides (a compute tool of the capability manifest). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly paramsSchema: JsonSchema;
}

/** One call a model asked for: the provider's id for it (the answer names it), the tool and its parameters. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly params: unknown;
}

/**
 * One message of the conversation. An assistant message that asked for tools carries its `toolCalls`; the answer to each is a `tool` message naming the call it answers. A message without these fields is
 * what it always was, so a decision that calls no tool keeps the messages (and the cache keys) it had before tools.
 */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** The JSON Schema the final answer must satisfy (generated from the allowed actions, the timers and the notebook); a server that cannot enforce it still gets it in the prompt. */
  readonly answerSchema: JsonSchema;
  readonly params: { readonly temperature?: number; readonly maxOutputTokens?: number; readonly topP?: number };
  /** The tools the model may call before it answers; absent when the mind offers none (structured output only). */
  readonly tools?: readonly ToolDefinition[];
  /** Wall-clock limit of the call, in milliseconds. */
  readonly timeoutMs: number;
  /** The attempt of this decision (1 is the first). */
  readonly attempt: number;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True when the server reported none and the count is characters / 4 (ADR-0044 §5). */
  readonly estimated?: boolean;
}

/** How a call ended: an answer, no answer in time, or an error of the server or the network. A validation failure is the brain's judgement of an answer, not the provider's outcome. */
export type ProviderOutcome = "ok" | "timeout" | "error";

export interface ProviderResponse {
  readonly outcome: ProviderOutcome;
  /** The text of the answer (a JSON document, when the call went well). */
  readonly content?: string;
  /** The tools the model asked for instead of answering: each is answered, and the model is called again with the answers. */
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: ProviderUsage;
  /** Wall latency of the call in milliseconds. */
  readonly latencyMs: number;
  /** What went wrong, in words, for `timeout` and `error` (never a header or a key). */
  readonly error?: string;
}

export interface ProviderPort {
  readonly kind: string;
  call(req: ProviderRequest): Promise<ProviderResponse>;
}

// ---- the scripted fake provider ----------------------------------------------------------------------------------------------------------------

/** One scripted answer: the content as the model would give it, or how the call fails. */
export type ScriptedAnswer =
  | { readonly content: string; readonly usage?: ProviderUsage; readonly latencyMs?: number }
  | { readonly toolCalls: readonly { readonly name: string; readonly params: unknown }[]; readonly content?: string; readonly usage?: ProviderUsage; readonly latencyMs?: number }
  | { readonly fail: "timeout" | "error"; readonly latencyMs?: number; readonly error?: string };

/**
 * The provider of every automated test (Max's rule for F4: no test calls a paid provider or uses a real key): it answers from a script, in order, or from a function of the request, with no network.
 * It keeps every request it was asked, so a test can read what the model would have seen.
 */
export class ScriptedProvider implements ProviderPort {
  readonly kind: string;
  readonly requests: ProviderRequest[] = [];
  private n = 0;

  constructor(
    private readonly script: readonly ScriptedAnswer[] | ((req: ProviderRequest, n: number) => ScriptedAnswer),
    kind = "openai-compatible",
  ) {
    this.kind = kind;
  }

  /** How many calls were made. */
  get calls(): number {
    return this.requests.length;
  }

  call(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    const answer = typeof this.script === "function" ? this.script(req, this.n++) : (this.script[this.n++] ?? { fail: "error" as const, error: "the script has no more answers" });
    if ("fail" in answer) return Promise.resolve({ outcome: answer.fail, latencyMs: answer.latencyMs ?? 1, ...(answer.error === undefined ? {} : { error: answer.error }) });
    const calls = "toolCalls" in answer ? answer.toolCalls.map((c, i) => ({ id: `call-${this.n}-${i + 1}`, name: c.name, params: c.params })) : undefined;
    return Promise.resolve({
      outcome: "ok",
      ...(answer.content === undefined ? {} : { content: answer.content }),
      ...(calls === undefined ? {} : { toolCalls: calls }),
      latencyMs: answer.latencyMs ?? 50,
      ...(answer.usage === undefined ? {} : { usage: answer.usage }),
    });
  }
}
