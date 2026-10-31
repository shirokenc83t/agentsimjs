import { contentHash64 } from "@agentsim/core";
import { canonicalJson } from "./canonical.ts";
import type { ChatMessage, ProviderUsage } from "./provider.ts";

// The response cache as the mind sees it (ADR-0036 section 7, ADR-0020 addition of 2026-10-29): every attempt of every decision is stored, with how it ended, and a replay reads them back. It is the
// shape of storage's `ResponseCache` port (structurally: the entry has the same fields), so the storage ports plug in without an adapter. A cache entry holds answers and figures, never a key or a header.

export type CacheOutcome = "ok" | "invalid" | "timeout" | "error";

export interface CacheEntry {
  readonly model: string;
  /** What came back: `{ content }` of an answer, `{ error }` of a failed call. */
  readonly value: unknown;
  readonly createdAtWallMs: number;
  readonly providerKind?: string;
  readonly toolsHash?: string;
  readonly outcome?: CacheOutcome;
  readonly usage?: unknown;
  readonly latencyMs?: number;
  /** The run the entry was recorded in (ADR-0036 addition of 2026-10-31): a store keeps one entry per key and run, and a replay reads its own run's first. Absent on an entry written before. */
  readonly runId?: string;
}

export interface MindCache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * The cache of one run over a cache that outlives it: what the run writes carries its run ID (so a later run's answers never write over it), and what it already read or wrote is kept, so a retry of a
 * decision or a replay does not ask twice. What the store gives for a key when it is asked is up to the store (the entry of the run the replay follows, else the latest).
 */
export class RunMindCache implements MindCache {
  private readonly front = new Map<string, CacheEntry>();
  constructor(
    private readonly inner: MindCache,
    private readonly runId: string,
  ) {}
  async get(key: string): Promise<CacheEntry | undefined> {
    const own = this.front.get(key);
    if (own !== undefined) return own;
    const e = await this.inner.get(key);
    if (e !== undefined) this.front.set(key, e);
    return e;
  }
  put(key: string, entry: CacheEntry): Promise<void> {
    const e = { ...entry, runId: this.runId };
    this.front.set(key, e);
    return this.inner.put(key, e);
  }
}

/** The cache of a test or of a run that is not stored: a map. */
export class MemoryMindCache implements MindCache {
  readonly entries = new Map<string, CacheEntry>();
  get(key: string): Promise<CacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }
  put(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}

export interface CacheKeyInput {
  readonly providerKind: string;
  readonly model: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The rendered prompt, exactly as sent. */
  readonly messages: readonly ChatMessage[];
  /** The hash of the answer schema and tool definitions offered. */
  readonly toolsHash: string;
  readonly attempt: number;
}

/**
 * The key of one attempt (ADR-0036 section 7: provider kind, model, parameters, rendered prompt, tools schema hash; the attempt number added by ADR-0020's addition so that each attempt of a decision
 * has its own entry). A 64-bit content hash of the canonical text.
 */
export function cacheKey(i: CacheKeyInput): string {
  return contentHash64(canonicalJson({ providerKind: i.providerKind, model: i.model, params: i.params, messages: i.messages, toolsHash: i.toolsHash, attempt: i.attempt }));
}

/** Tokens when the server reported none: characters / 4, rounded up, labelled as an estimate (ADR-0044 §5). */
export function estimateUsage(messages: readonly ChatMessage[], content: string | undefined): ProviderUsage {
  const input = messages.reduce((n, m) => n + m.content.length, 0);
  return { inputTokens: Math.ceil(input / 4), outputTokens: Math.ceil((content?.length ?? 0) / 4), estimated: true };
}
