import type { Brain, SimLoadMessage, SimMindsMessage } from "@agentsim/core";
import { InferenceQueue, LlmBrain, MemoryMindCache, ScriptedProvider, type LimitEvent, type LimitName, type LimitWarning, type LlmBrainHooks, type MindCache, type MindsRunMode, type Prices, type ProviderPort, type ProviderRequest, type ProviderResponse, type ScriptedAnswer } from "@agentsim/minds";
import type { MindLibrary, MindsOptions, ProviderInfo, ResolvedRunConfig, ResolveOptions } from "@agentsim/scenarios";

// What the sim worker holds for the System 2 minds of a run (F4 M1, T-110): the providers it was given, the response cache, the inference queue, the hooks of each mind (the limit warnings and the pause),
// and the status it reports to the main thread. The host asks it for the status every poll and hands it the researcher's answers; nothing here touches the simulation: a mind's pause is a decision that
// has not been answered, which the lockstep world already waits for.

type Spec = NonNullable<SimLoadMessage["minds"]>;
declare function setTimeout(fn: () => void, ms: number): unknown;

/** The scripted provider with a wall-clock delay per answer: what a slow model looks like, for tests and demonstrations (only the test probe sends it). */
class DelayedScripted implements ProviderPort {
  readonly kind: string;
  private readonly inner: ScriptedProvider;
  constructor(
    script: readonly ScriptedAnswer[],
    private readonly delayMs: number,
  ) {
    this.inner = new ScriptedProvider(script);
    this.kind = this.inner.kind;
  }
  call(req: ProviderRequest): Promise<ProviderResponse> {
    return new Promise((resolve) => setTimeout(() => resolve(this.inner.call(req)), this.delayMs));
  }
}

/** The researcher's answer to a limit, as the host hands it over (the message without its type and run). */
export type LimitAnswerBody = { readonly agentId: string; readonly limit: LimitName; readonly action: "raise"; readonly value: number } | { readonly agentId: string; readonly limit: LimitName; readonly action: "stop" };

interface Paused {
  readonly event: LimitEvent;
  readonly answer: (a: { action: "raise"; value: number } | { action: "stop" }) => void;
}

export class MindsRuntime {
  /** The resolution of the run configuration reads these. */
  readonly resolve: Pick<ResolveOptions, "library" | "providers">;
  /** What `createRun` builds the minds from. */
  readonly options: MindsOptions;
  readonly queue: InferenceQueue;
  private readonly warnings = new Map<string, LimitWarning[]>();
  private pausedAt: Paused | undefined;
  private brains: readonly [string, LlmBrain][] = [];
  private lastPosted = "";
  /** Set when a `replay-then-live` mind made a call the cache did not hold: from which tick, for which agent. */
  notReproducible: { readonly agentId: string; readonly tick: number } | undefined;

  constructor(spec: Spec, readonly mode: MindsRunMode, private readonly headless = false, cacheStore?: MindCache) {
    const profiles = new Map(spec.profiles.map((p) => [`${p.id}@${p.version}`, p.document]));
    const templates = new Map(spec.templates.map((t) => [`${t.id}@${t.version}`, t.document]));
    const library: MindLibrary = { profile: (id, v) => profiles.get(`${id}@${v}`) as never, template: (id, v) => templates.get(`${id}@${v}`) as never };
    const entries = new Map(spec.providers.map((p) => [p.id, p]));
    this.resolve = { library, providers: (id): ProviderInfo | undefined => (entries.get(id) === undefined ? undefined : { kind: entries.get(id)?.kind ?? "", baseUrl: entries.get(id)?.baseUrl ?? "" }) };
    this.queue = new InferenceQueue({ ...(spec.queue?.concurrency === undefined ? {} : { concurrency: spec.queue.concurrency }), ...(spec.queue?.backoffMs === undefined ? {} : { backoffMs: spec.queue.backoffMs }) });
    const cache = cacheStore ?? new MemoryMindCache();
    this.options = {
      cache,
      queue: this.queue,
      providers: (id) => {
        const e = entries.get(id);
        if (e === undefined) return undefined;
        // The adapter for OpenAI-compatible servers arrives with M3 (Providers and keys): until then only the scripted kind answers.
        return e.kind === "scripted" ? new DelayedScripted((e.script ?? []) as ScriptedAnswer[], e.delayMs ?? 0) : undefined;
      },
      prices: (id): Prices | undefined => entries.get(id)?.prices,
      hooks: (agentId) => this.hooksOf(agentId),
      onNotReproducible: (agentId, tick) => {
        this.notReproducible ??= { agentId, tick };
      },
    };
  }

  private hooksOf(agentId: string): LlmBrainHooks {
    // A headless run has no one to ask: at a limit it stops (no `onLimitHit`), after the warning is recorded.
    if (this.headless) return { onWarning: (w) => this.warnings.set(agentId, [...(this.warnings.get(agentId) ?? []).filter((x) => x.limit !== w.limit), w]) };
    return {
      onWarning: (w) => {
        const mine = this.warnings.get(agentId) ?? [];
        this.warnings.set(agentId, [...mine.filter((x) => x.limit !== w.limit), w]);
      },
      onLimitHit: (event) =>
        new Promise((resolve) => {
          this.pausedAt = { event, answer: resolve };
        }),
    };
  }

  /** The minds of the created run (read after `createRun`). */
  attach(brains: ReadonlyMap<string, Brain>, resolved: ResolvedRunConfig): void {
    this.brains = [...brains].filter((e): e is [string, LlmBrain] => e[1] instanceof LlmBrain);
    this.names = new Map(resolved.agents.flatMap((a) => (a.s2 === undefined ? [] : [[a.agentId, { profile: a.s2.profileRef === undefined ? undefined : `${a.s2.profileRef.id} v${a.s2.profileRef.version}`, provider: a.s2.provider.id, model: a.s2.effective.model }] as const])));
  }

  /** What each mind is called in the notice: its profile, its provider entry and its model. */
  private names = new Map<string, { readonly profile: string | undefined; readonly provider: string; readonly model: string }>();

  get hasMinds(): boolean {
    return this.brains.length > 0;
  }

  /** The researcher's answer to the limit that paused the run: a raise (the value the dialog stated) or a stop. */
  answer(a: LimitAnswerBody): boolean {
    const p = this.pausedAt;
    if (p === undefined || p.event.agentId !== a.agentId || p.event.limit !== a.limit) return false;
    this.pausedAt = undefined;
    for (const w of [...(this.warnings.get(a.agentId) ?? [])]) if (a.action === "raise" && w.limit === a.limit) this.warnings.set(a.agentId, (this.warnings.get(a.agentId) ?? []).filter((x) => x !== w));
    p.answer(a.action === "raise" ? { action: "raise", value: a.value } : { action: "stop" });
    return true;
  }

  /** The status for the main thread, or undefined while nothing changed since the last time it was asked for. */
  status(tick: number, waiting: number, force = false): Omit<SimMindsMessage, "type" | "runId"> | undefined {
    if (this.brains.length === 0) return undefined;
    const s: Omit<SimMindsMessage, "type" | "runId"> = {
      tick,
      mode: this.mode,
      waiting,
      queue: this.queue.status,
      agents: this.brains.map(([agentId, b]) => ({
        agentId,
        ...(this.names.get(agentId)?.profile === undefined ? {} : { profile: this.names.get(agentId)?.profile as string }),
        provider: this.names.get(agentId)?.provider ?? "",
        model: this.names.get(agentId)?.model ?? "",
        calls: b.usage.calls,
        tokens: b.usage.inputTokens + b.usage.outputTokens,
        costUsd: Math.round(b.usage.costUsd * 1e6) / 1e6,
        limits: b.limitsInForce,
        pricesKnown: b.pricesKnown,
        warnings: (this.warnings.get(agentId) ?? []).map((w) => ({ limit: w.limit as LimitName, pct: w.pct })),
      })),
      ...(this.pausedAt === undefined ? {} : { pausedAt: { ...this.pausedAt.event } }),
      ...(this.notReproducible === undefined ? {} : { notReproducibleFromTick: this.notReproducible.tick }),
    };
    // `tick` moves every poll: the report is compared without it.
    const { tick: _t, ...rest } = s;
    const key = JSON.stringify(rest);
    if (!force && key === this.lastPosted) return undefined;
    this.lastPosted = key;
    return s;
  }
}
