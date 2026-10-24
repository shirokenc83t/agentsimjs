import { err, ok, type CodedError, type Result } from "@agentsim/core";
import { matchesRecord, matchesSample, parseFilter, type FilterAst, type MetricSample, type TraceRecord } from "@agentsim/trace";

// Live subscriptions (ADR-0035 section 5): a filter and a view. The storage worker offers each batch it has stored to the subscriptions; a subscription evaluates the
// filter's predicate (the same filter the SQL backend compiles) on the records or samples of its run, and pushes what matches to the UI batched: at most once per
// interval (10 Hz) and at most `maxPerBatch` items. Above the cap the display samples, evenly, and says how many matched against how many it shows; the recording is
// never sampled (it is stored before it is offered here, and nothing here writes).

export const LIVE_DEFAULTS = { intervalMs: 100, maxPerBatch: 2000, maxSubscriptions: 16 } as const;

/** What the worker posts to the UI for a view. */
export interface LiveBatch {
  readonly viewId: string;
  readonly runId: string;
  /** Records or samples, by what the filter selects; in the order they were stored. */
  readonly records: readonly TraceRecord[];
  readonly samples: readonly MetricSample[];
  /** What matched since the last batch, and what this batch shows of it (less when the display sampled). */
  readonly matched: number;
  readonly shown: number;
  /** Over the life of the subscription: the matches (recorded) and what was shown. */
  readonly totalMatched: number;
  readonly totalShown: number;
  readonly sampled: boolean;
}

export type LiveError = CodedError<"invalid_filter" | "duplicate_view" | "unknown_view" | "too_many_subscriptions" | "invalid_view">;

export interface LiveOptions {
  readonly emit: (batch: LiveBatch) => void;
  /** Wall clock in ms (a policy input for the display; never part of a run). */
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly intervalMs?: number;
  readonly maxPerBatch?: number;
  readonly maxSubscriptions?: number;
}

const VIEW = /^[A-Za-z0-9._:-]{1,64}$/;

interface Subscription {
  readonly viewId: string;
  readonly runId: string;
  ast: FilterAst;
  records: TraceRecord[];
  samples: MetricSample[];
  matched: number;
  totalMatched: number;
  totalShown: number;
  lastEmitAt: number;
  timer: unknown;
}

export class LiveSubscriptions {
  private readonly subs = new Map<string, Subscription>();
  private readonly intervalMs: number;
  private readonly maxPerBatch: number;
  private readonly maxSubscriptions: number;

  constructor(private readonly o: LiveOptions) {
    this.intervalMs = o.intervalMs ?? LIVE_DEFAULTS.intervalMs;
    this.maxPerBatch = o.maxPerBatch ?? LIVE_DEFAULTS.maxPerBatch;
    this.maxSubscriptions = o.maxSubscriptions ?? LIVE_DEFAULTS.maxSubscriptions;
  }

  /** How many subscriptions are open: a closed view leaves none behind. */
  get size(): number {
    return this.subs.size;
  }

  has(viewId: string): boolean {
    return this.subs.has(viewId);
  }

  subscribe(viewId: string, runId: string, filter: string): Result<void, LiveError> {
    if (typeof viewId !== "string" || !VIEW.test(viewId) || typeof runId !== "string" || !/^run-[0-9]{6}$/.test(runId)) return err({ code: "invalid_view", message: "a view id and a run id are needed" });
    if (this.subs.has(viewId)) return err({ code: "duplicate_view", message: `view ${viewId} already has a subscription` });
    if (this.subs.size >= this.maxSubscriptions) return err({ code: "too_many_subscriptions", message: `at most ${this.maxSubscriptions} subscriptions` });
    const parsed = parseFilter(filter);
    if (!parsed.ok) return err({ code: "invalid_filter", message: parsed.error.message });
    this.subs.set(viewId, { viewId, runId, ast: parsed.value, records: [], samples: [], matched: 0, totalMatched: 0, totalShown: 0, lastEmitAt: Number.NEGATIVE_INFINITY, timer: undefined });
    return ok(undefined);
  }

  /** Replaces the filter of a view: what was waiting under the old one is dropped, the counts start again. */
  change(viewId: string, filter: string): Result<void, LiveError> {
    const sub = this.subs.get(viewId);
    if (!sub) return err({ code: "unknown_view", message: `view ${String(viewId).slice(0, 40)} has no subscription` });
    const parsed = parseFilter(filter);
    if (!parsed.ok) return err({ code: "invalid_filter", message: parsed.error.message });
    if (sub.timer !== undefined) this.o.clearTimer(sub.timer);
    sub.timer = undefined;
    sub.ast = parsed.value;
    sub.records = [];
    sub.samples = [];
    sub.matched = 0;
    sub.totalMatched = 0;
    sub.totalShown = 0;
    return ok(undefined);
  }

  unsubscribe(viewId: string): boolean {
    const sub = this.subs.get(viewId);
    if (!sub) return false;
    if (sub.timer !== undefined) this.o.clearTimer(sub.timer);
    this.subs.delete(viewId);
    return true;
  }

  /** Records that were stored: the subscriptions of their run take the ones that match. */
  offerRecords(records: readonly TraceRecord[]): void {
    if (this.subs.size === 0) return;
    for (const sub of this.subs.values()) {
      if (sub.ast.target !== "records") continue;
      let any = false;
      for (const r of records) {
        if (r.runId !== sub.runId || !matchesRecord(sub.ast, r)) continue;
        sub.records.push(r);
        sub.matched++;
        any = true;
      }
      if (any) this.schedule(sub);
    }
  }

  /** Metric samples that were stored, offered to the subscriptions of their run (`runId`: samples do not carry it). */
  offerSamples(runId: string, samples: readonly MetricSample[]): void {
    if (this.subs.size === 0) return;
    for (const sub of this.subs.values()) {
      if (sub.ast.target !== "metrics" || sub.runId !== runId) continue;
      let any = false;
      for (const s of samples) {
        if (!matchesSample(sub.ast, s)) continue;
        sub.samples.push(s);
        sub.matched++;
        any = true;
      }
      if (any) this.schedule(sub);
    }
  }

  /** Pushes what every subscription holds now (the interval aside): at a stop, and in tests. */
  flushNow(): void {
    for (const sub of this.subs.values()) this.emit(sub);
  }

  dispose(): void {
    for (const sub of this.subs.values()) if (sub.timer !== undefined) this.o.clearTimer(sub.timer);
    this.subs.clear();
  }

  private schedule(sub: Subscription): void {
    if (sub.timer !== undefined) return;
    const wait = Math.max(0, sub.lastEmitAt + this.intervalMs - this.o.now());
    sub.timer = this.o.setTimer(() => {
      sub.timer = undefined;
      this.emit(sub);
    }, wait);
  }

  private emit(sub: Subscription): void {
    if (sub.matched === 0) return;
    const pick = <T>(items: T[]): T[] => {
      if (items.length <= this.maxPerBatch) return items;
      // An even spread over the matches, so the display shows the whole interval rather than its start.
      return Array.from({ length: this.maxPerBatch }, (_, i) => items[Math.floor((i * items.length) / this.maxPerBatch)] as T);
    };
    const records = pick(sub.records);
    const samples = pick(sub.samples);
    const shown = records.length + samples.length;
    sub.totalMatched += sub.matched;
    sub.totalShown += shown;
    const batch: LiveBatch = { viewId: sub.viewId, runId: sub.runId, records, samples, matched: sub.matched, shown, totalMatched: sub.totalMatched, totalShown: sub.totalShown, sampled: shown < sub.matched };
    sub.records = [];
    sub.samples = [];
    sub.matched = 0;
    sub.lastEmitAt = this.o.now();
    this.o.emit(batch);
  }
}
