import type { Brain, ComputeOutcome, DecideContext, DecisionEnvelope, DecisionRequest, StatefulBrain } from "@agentsim/core";
import { contentHash64 } from "@agentsim/core";
import { answerSchema, parseAnswer, type ParsedAnswer } from "./answer.ts";
import { cacheKey, estimateUsage, type CacheOutcome, type MindCache } from "./cache.ts";
import { canonicalJson } from "./canonical.ts";
import type { EffectiveS2, PromptTemplateDocument } from "./documents.ts";
import { buildPrompt, retryMessages, type DecisionNote } from "./prompt.ts";
import type { InferenceQueue } from "./queue.ts";
import type { ChatMessage, ProviderPort, ProviderResponse, ProviderUsage, ToolCall } from "./provider.ts";
import { offeredComputeTools } from "./tools.ts";

// The System 2 mind of F4 (ADR-0005 addition of 2026-10-29): one decision is a loop of model calls ending in one allowed action or `idle`. An attempt that is not accepted (the answer does not match the
// schema, the call times out, the server errors) is retried up to `limits.retries` with the reason in the next message; then the logged fallback (`hold`, `idle` when the agent is landed). Every
// attempt goes to the response cache and to the trace (`thought`, op `llm-call`, a child of the request), and the decision says how it was reached.

/** Where the answers come from (ADR-0036 section 7). */
export type MindsRunMode = "live" | "replay-strict" | "replay-then-live";

/** A stable error the run stops with. */
export class MindError extends Error {
  constructor(
    readonly code: "cache_miss_strict" | "limit_reached" | "replay_divergent",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MindError";
  }
}

export interface Prices {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

export type LimitName = "calls" | "tokens" | "costUsd";

/** A limit at which the run pauses (or warns): which, for which agent, how much was used of how much, at which tick. */
export interface LimitEvent {
  readonly agentId: string;
  readonly limit: LimitName;
  readonly used: number;
  readonly max: number;
  readonly tick: number;
}
export interface LimitWarning extends LimitEvent {
  /** The share of the limit used, in whole percent (80 or more). */
  readonly pct: number;
}

/** What the host answers at a limit: raise it to a value above it (the user confirmed), or stop the run. Nothing answered is a stop (a headless run has no one to ask). */
export type LimitAnswer = { readonly action: "raise"; readonly value: number } | { readonly action: "stop" };

export interface LlmBrainHooks {
  /** At 80 % of a limit, once per limit (and again after a raise): the status line and the player say so. */
  onWarning?(w: LimitWarning): void;
  /** At a limit: the run is paused until this answers. The brain keeps the decision waiting, so the world waits (lockstep) and the UI stays free. */
  onLimitHit?(e: LimitEvent): Promise<LimitAnswer>;
}

export interface LlmBrainOptions {
  readonly id: string;
  /** The effective profile (defaults, profile and overrides resolved). */
  readonly effective: Omit<EffectiveS2, "sources">;
  readonly template: PromptTemplateDocument;
  readonly mission?: string | undefined;
  readonly provider: ProviderPort;
  readonly cache: MindCache;
  readonly mode: MindsRunMode;
  /** Wall clock for the cache entries' `createdAtWallMs` (a test pins it). */
  readonly now?: () => number;
  /** Prices of the provider entry, when the user entered some: only then is there a cost. */
  readonly prices?: Prices | undefined;
  /** Told when a `replay-then-live` run makes its first call that missed the cache: from that tick the run is not reproducible. */
  readonly onNotReproducible?: (tick: number) => void;
  /** The limits' notices and the pause (the host's; absent in a headless run, which stops at a limit). */
  readonly hooks?: LlmBrainHooks;
  /** The run's inference queue (concurrency, timeout, backoff); absent: the calls go straight to the provider. */
  readonly queue?: InferenceQueue;
}

/** What a mind has used of its limits, and its history: its state, which a snapshot carries. */
export interface LlmBrainState {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly history: readonly DecisionNote[];
  readonly notReproducibleFromTick?: number;
  /** The limits the user raised, by name (the value now in force). */
  readonly raised?: Partial<Record<LimitName, number>>;
  /** The limits already warned of at 80 %. */
  readonly warned?: readonly LimitName[];
}

const HISTORY_CAP = 50;

const sum = (a: number, b: number | undefined): number => a + (b ?? 0);

export class LlmBrain implements Brain, StatefulBrain {
  readonly tier = "S2" as const;
  readonly id: string;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private history: DecisionNote[] = [];
  private notReproducibleFromTick: number | undefined;
  private raised: Partial<Record<LimitName, number>> = {};
  private warned = new Set<LimitName>();

  constructor(private readonly o: LlmBrainOptions) {
    this.id = o.id;
  }

  /** What the mind has used so far (the host shows it against the limits). */
  get usage(): { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number } {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, costUsd: this.costUsd };
  }

  /** The limits in force now (the profile's, or the value the researcher raised them to). */
  get limitsInForce(): { readonly calls: number; readonly tokens: number; readonly costUsd: number } {
    return { calls: this.max("calls"), tokens: this.max("tokens"), costUsd: this.max("costUsd") };
  }

  /** Whether the provider entry has prices: only then are cost and the cost limit counted. */
  get pricesKnown(): boolean {
    return this.o.prices !== undefined;
  }

  snapshotState(): LlmBrainState {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      history: this.history,
      ...(this.notReproducibleFromTick === undefined ? {} : { notReproducibleFromTick: this.notReproducibleFromTick }),
      ...(Object.keys(this.raised).length === 0 ? {} : { raised: { ...this.raised } }),
      ...(this.warned.size === 0 ? {} : { warned: [...this.warned].sort() }),
    };
  }

  restoreState(state: unknown): void {
    const s = state as LlmBrainState;
    this.calls = s.calls;
    this.inputTokens = s.inputTokens;
    this.outputTokens = s.outputTokens;
    this.costUsd = s.costUsd;
    this.history = [...s.history];
    this.notReproducibleFromTick = s.notReproducibleFromTick;
    this.raised = { ...(s.raised ?? {}) };
    this.warned = new Set(s.warned ?? []);
  }

  // ---- the limits (ADR-0044 section 5) --------------------------------------------------------------------------------------------------------

  private max(l: LimitName): number {
    return this.raised[l] ?? this.o.effective.limits[l === "costUsd" ? "costUsd" : l];
  }

  private used(l: LimitName): number {
    return l === "calls" ? this.calls : l === "tokens" ? this.inputTokens + this.outputTokens : this.costUsd;
  }

  /** A limit that applies: calls and tokens always, cost only when the provider has prices (without them nothing is counted). */
  private active(l: LimitName): boolean {
    return l !== "costUsd" || this.o.prices !== undefined;
  }

  /** The pause: the record of the hit, then the host's answer. A raise above the limit is recorded and goes on; anything else stops the run with `limit_reached`. */
  private async hit(l: LimitName, req: DecisionRequest, emit: (p: Record<string, unknown>, c?: readonly string[]) => string | undefined, trace: DecideContext["trace"]): Promise<void> {
    const max = this.max(l);
    const event: LimitEvent = { agentId: req.agentId, limit: l, used: this.used(l), max, tick: req.tick };
    emit({ op: "limit-hit", ...event });
    const answer = (await this.o.hooks?.onLimitHit?.(event)) ?? { action: "stop" as const };
    if (answer.action === "raise" && answer.value > max) {
      this.raised[l] = answer.value;
      this.warned.delete(l);
      trace?.emit({ source: `${req.agentId}/s2`, simTime: req.simTimeS, kind: "lifecycle", agentId: req.agentId, tier: "S2", detail: "full", payload: { op: "raiseLimit", caller: "world", limit: l, before: max, after: answer.value, tick: req.tick } });
      return;
    }
    throw new MindError("limit_reached", `${req.agentId} reached its ${l} limit (${event.used} of ${max}) at tick ${req.tick}`);
  }

  /** The warning at 80 % of a limit that is not yet reached, once. */
  private warn(req: DecisionRequest, emit: (p: Record<string, unknown>, c?: readonly string[]) => string | undefined): void {
    for (const l of ["calls", "tokens", "costUsd"] as const) {
      if (!this.active(l) || this.warned.has(l)) continue;
      const max = this.max(l);
      const used = this.used(l);
      if (max <= 0 || used >= max || used / max < 0.8) continue;
      this.warned.add(l);
      const w: LimitWarning = { agentId: req.agentId, limit: l, used, max, tick: req.tick, pct: Math.floor((used / max) * 100) };
      emit({ op: "limit-warning", ...w });
      this.o.hooks?.onWarning?.(w);
    }
  }

  async decide(req: DecisionRequest, ctx?: DecideContext): Promise<DecisionEnvelope> {
    const { effective: eff } = this.o;
    const allow = eff.tools.allow;
    const offered = allow === undefined ? undefined : req.allowedActions.filter((a) => allow.includes(a.name)).map((a) => a.name);
    const allowed = offered === undefined ? req.allowedActions : req.allowedActions.filter((a) => offered.includes(a.name));
    const schema = answerSchema(allowed);
    const first = buildPrompt({ template: this.o.template, mission: this.o.mission, request: req, history: this.history.slice(-eff.context.decisions), ...(offered === undefined ? {} : { offered }) });
    const source = `${req.agentId}/s2`;
    const emit = (payload: Record<string, unknown>, causeIds?: readonly string[]): string | undefined =>
      ctx?.trace?.emit({ source, simTime: req.simTimeS, kind: "thought", agentId: req.agentId, tier: "S2", detail: "full", payload, ...(ctx.requestRecordId === undefined ? {} : { parentId: ctx.requestRecordId }), ...(causeIds === undefined ? {} : { causeIds }) });

    const attempts = 1 + eff.limits.retries;
    let messages: readonly ChatMessage[] = first;
    /** Where the next attempt starts: the first prompt, or the first prompt with the answer that was not accepted and why. */
    let start: readonly ChatMessage[] = first;
    let answer: ParsedAnswer | undefined;
    let lastCall: string | undefined;
    let lastWhy = "";
    let latencyMs = 0;
    const used = { input: 0, output: 0, cost: 0, calls: 0 };
    // The tool-call loop of the decision (ADR-0005 addition of 2026-10-29): compute tools the model may call before it answers, at most `maxCallsPerDecision` of them answered; beyond that the model is told so.
    const compute = ctx?.compute;
    const maxTools = eff.tools.maxCallsPerDecision;
    const toolDefs = compute === undefined || maxTools <= 0 ? [] : offeredComputeTools(allow);
    const toolsHash = toolDefs.length === 0 ? contentHash64(canonicalJson(schema)) : contentHash64(canonicalJson({ answer: schema, tools: toolDefs }));
    let toolsAnswered = 0;
    let toolRounds = 0;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      messages = start;
      let firstOfAttempt = true;
      // Each pass of this loop is one model call: the first of the attempt, then one after each round of tool answers.
      for (;;) {
        const key = cacheKey({ providerKind: this.o.provider.kind, model: eff.model, params: eff.params, messages, toolsHash, attempt });
        let hit = false;
        let resp: ProviderResponse;
        // Before a call that would pass the call limit the run pauses (a cache hit counts as a call: a replay hits the limits where the live run did).
        if (this.active("calls") && this.calls + 1 > this.max("calls")) await this.hit("calls", req, emit, ctx?.trace);
        const cached = this.o.mode === "live" ? undefined : await this.o.cache.get(key);
        if (cached !== undefined) {
          hit = true;
          const v = (cached.value ?? {}) as { content?: string; error?: string; toolCalls?: ToolCall[] };
          const o = cached.outcome === "invalid" ? "ok" : (cached.outcome ?? "ok");
          resp = { outcome: o, latencyMs: cached.latencyMs ?? 0, ...(v.content === undefined ? {} : { content: v.content }), ...(v.toolCalls === undefined ? {} : { toolCalls: v.toolCalls }), ...(v.error === undefined ? {} : { error: v.error }), ...(cached.usage === undefined ? {} : { usage: cached.usage as ProviderUsage }) };
        } else if (this.o.mode === "replay-strict") {
          emit({ op: "cache-miss", attempt, model: eff.model, cacheKey: key });
          throw new MindError("cache_miss_strict", `${req.agentId} attempt ${attempt} at tick ${req.tick}: no cached answer for key ${key} (replay-strict stops on a miss)`);
        } else {
          if (this.o.mode === "replay-then-live" && this.notReproducibleFromTick === undefined) {
            this.notReproducibleFromTick = req.tick;
            this.o.onNotReproducible?.(req.tick);
            emit({ op: "not-reproducible", fromTick: req.tick, reason: "a call missed the cache and was made live" });
          }
          if (attempt > 1 && firstOfAttempt) await this.o.queue?.backoff(attempt - 1);
          const call = () => this.o.provider.call({ model: eff.model, messages, answerSchema: schema, params: eff.params, ...(toolDefs.length === 0 ? {} : { tools: toolDefs }), timeoutMs: eff.limits.timeoutS * 1000, attempt });
          if (this.o.queue === undefined) resp = await call();
          else {
            const r = await this.o.queue.run(call, eff.limits.timeoutS * 1000);
            resp = r.ok ? r.value : { outcome: r.reason === "timeout" ? "timeout" : "error", latencyMs: eff.limits.timeoutS * 1000 * (r.reason === "timeout" ? 1 : 0), error: r.reason === "timeout" ? `no answer in ${eff.limits.timeoutS} s` : r.message };
          }
        }
        const usage: ProviderUsage = resp.usage ?? estimateUsage(messages, resp.content);
        const asked = resp.outcome === "ok" && resp.toolCalls !== undefined && resp.toolCalls.length > 0 ? resp.toolCalls : undefined;
        let outcome: CacheOutcome = resp.outcome;
        let parsed: ParsedAnswer | undefined;
        let why = resp.error ?? "";
        if (resp.outcome === "ok" && asked === undefined) {
          const p = parseAnswer(resp.content ?? "", schema);
          if (p.ok) parsed = p.value;
          else {
            outcome = "invalid";
            why = p.message;
          }
        }
        const cost = this.o.prices === undefined ? undefined : (usage.inputTokens * this.o.prices.inputUsdPerMTok + usage.outputTokens * this.o.prices.outputUsdPerMTok) / 1e6;
        if (!hit) {
          await this.o.cache.put(key, {
            model: eff.model,
            value: { ...(resp.content !== undefined ? { content: resp.content } : {}), ...(asked === undefined ? {} : { toolCalls: asked }), ...(resp.content === undefined && asked === undefined ? { error: resp.error ?? resp.outcome } : {}) },
            createdAtWallMs: (this.o.now ?? Date.now)(),
            providerKind: this.o.provider.kind,
            toolsHash,
            outcome,
            usage,
            latencyMs: resp.latencyMs,
          });
        }
        this.calls++;
        this.inputTokens += usage.inputTokens;
        this.outputTokens += usage.outputTokens;
        this.costUsd += cost ?? 0;
        used.calls++;
        used.input += usage.inputTokens;
        used.output += usage.outputTokens;
        used.cost = sum(used.cost, cost);
        latencyMs += resp.latencyMs;
        lastCall = emit({
          op: "llm-call",
          attempt,
          model: eff.model,
          providerKind: this.o.provider.kind,
          cacheKey: key,
          cacheHit: hit,
          outcome,
          latencyMs: resp.latencyMs,
          usage,
          ...(cost === undefined ? {} : { costUsd: cost }),
          toolsHash,
          messages,
          response: resp.content !== undefined || asked !== undefined ? { ...(resp.content !== undefined ? { content: resp.content } : {}), ...(asked === undefined ? {} : { toolCalls: asked }) } : { error: resp.error ?? resp.outcome },
          ...(outcome === "invalid" ? { validationError: why } : {}),
        });
        // After the call: a token or cost limit it reached pauses the run with the answer in hand; at 80 % of any limit, one warning.
        for (const l of ["tokens", "costUsd"] as const) if (this.active(l) && this.used(l) >= this.max(l)) await this.hit(l, req, emit, ctx?.trace);
        this.warn(req, emit);
        if (asked !== undefined && compute !== undefined && toolDefs.length > 0) {
          // The model asked for tools instead of answering: each is answered (or refused beyond the cap), recorded as a child of this call, and the model is called again with the answers.
          const parent = lastCall;
          const results: ChatMessage[] = [];
          for (const tc of asked) {
            let out: ComputeOutcome;
            if (toolsAnswered >= maxTools) out = { ok: false, code: "tool_call_limit", message: `you have used your ${maxTools} tool calls for this decision: answer now with one of the allowed actions or idle` };
            else if (!toolDefs.some((d) => d.name === tc.name)) out = { ok: false, code: "tool_not_available", message: `${tc.name.slice(0, 64)} is not a tool you can call` };
            else {
              toolsAnswered++;
              out = compute(tc.name, tc.params);
              await this.checkReplay(key, tc, out, req, eff.model);
            }
            ctx?.trace?.emit({
              source,
              simTime: req.simTimeS,
              kind: "compute",
              agentId: req.agentId,
              tier: "S2",
              detail: "full",
              payload: { op: "tool", tool: tc.name, callId: tc.id, params: tc.params, ok: out.ok, ...(out.ok ? { status: out.status, expansions: out.expansions, result: out.result } : { code: out.code, message: out.message }) },
              ...(parent === undefined ? {} : { parentId: parent }),
            });
            results.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: canonicalJson(out.ok ? out.result : { error: out.code, message: out.message }) });
          }
          messages = [...messages, { role: "assistant", content: resp.content ?? "", toolCalls: asked }, ...results];
          firstOfAttempt = false;
          toolRounds++;
          // A model that keeps asking for tools after being refused is not answering: the attempt fails (and is retried or falls back like any unusable answer).
          if (toolRounds > maxTools + 2) {
            lastWhy = "the model kept calling tools instead of answering";
            start = retryMessages(first, undefined, lastWhy);
            break;
          }
          continue;
        }
        if (asked !== undefined) {
          // Tools were asked for in a run that has none to answer with: the model is told, and the attempt goes on as a retry.
          lastWhy = "tools are not available: answer with one JSON object, without calling a tool";
          start = retryMessages(first, undefined, lastWhy);
          break;
        }
        if (parsed !== undefined) {
          answer = parsed;
          break;
        }
        lastWhy = why === "" ? outcome : why;
        start = retryMessages(first, resp.content, lastWhy);
        break;
      }
      if (answer !== undefined) break;
    }

    const meta = { attempts: used.calls, usage: { inputTokens: used.input, outputTokens: used.output }, latencyMs, ...(this.o.prices === undefined ? {} : { costUsd: used.cost }), ...(this.notReproducibleFromTick === undefined ? {} : { notReproducible: true }) };
    if (answer !== undefined) {
      this.remember(req, answer.decision.kind === "action" ? `${answer.decision.name} ${canonicalJson(answer.decision.params)}` : "idle", answer.rationale, false);
      return {
        decision: answer.decision,
        ...(answer.timers === undefined ? {} : { timers: answer.timers }),
        ...(answer.note === undefined ? {} : { note: answer.note }),
        ...(answer.rationale === undefined ? {} : { rationale: answer.rationale }),
        mind: meta,
      };
    }
    // The logged fallback: `hold` when the agent can hold, `idle` when it is landed (nothing to hold there) or cannot.
    const landed = req.self.kind === "uav" ? (req.self.zM ?? 0) < 0.1 && req.self.running === null : false;
    const canHold = !landed && req.allowedActions.some((a) => a.name === "hold") && (allow === undefined || allow.includes("hold"));
    const decision = canHold ? ({ kind: "action", name: "hold", params: {} } as const) : ({ kind: "idle" } as const);
    emit({ op: "fallback", reason: lastWhy, attempts: used.calls, decision: canHold ? "hold" : "idle" }, lastCall === undefined ? undefined : [lastCall]);
    this.remember(req, canHold ? "hold {}" : "idle", `fallback: ${lastWhy}`, true);
    return { decision, rationale: `fallback after ${used.calls} attempt${used.calls === 1 ? "" : "s"}: ${lastWhy}`, mind: { ...meta, fallback: lastWhy } };
  }

  /**
   * The check of a replay (ADR-0014 addition of 2026-10-29): a compute tool's result is recomputed in every run, and its hash is kept under a key made of the model call that asked for it and the call itself.
   * A run that finds a different hash for the same call is not the run that was recorded (the maps or the planner differ): it stops as divergent instead of going on with an answer that no longer fits.
   * A live run (or a call the cache did not hold) writes the hash.
   */
  private async checkReplay(callKey: string, tc: ToolCall, out: ComputeOutcome, req: DecisionRequest, model: string): Promise<void> {
    const key = `tool:${contentHash64(canonicalJson({ call: callKey, id: tc.id, name: tc.name, params: tc.params }))}`;
    const resultHash = contentHash64(canonicalJson(out.ok ? out.result : { error: out.code }));
    const known = this.o.mode === "live" ? undefined : await this.o.cache.get(key);
    if (known === undefined) {
      await this.o.cache.put(key, { model, value: { resultHash }, createdAtWallMs: (this.o.now ?? Date.now)() });
      return;
    }
    const was = (known.value as { resultHash?: string } | undefined)?.resultHash;
    if (was !== undefined && was !== resultHash) throw new MindError("replay_divergent", `${req.agentId} at tick ${req.tick}: ${tc.name} gave a different result than the recorded run's (${resultHash} instead of ${was})`);
  }

  private remember(req: DecisionRequest, chose: string, rationale: string | undefined, fallback: boolean): void {
    this.history.push({ tick: req.tick, simTimeS: req.simTimeS, chose, ...(rationale === undefined ? {} : { rationale }), ...(fallback ? { fallback: true } : {}) });
    if (this.history.length > HISTORY_CAP) this.history = this.history.slice(-HISTORY_CAP);
  }
}
