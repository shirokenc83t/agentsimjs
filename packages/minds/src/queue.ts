// The inference queue (ADR-0036 section 10, ADR-0044): the model calls of a run go through one queue, so that a swarm of LLM minds does not open a call per agent at once. It caps how many calls run
// together, gives each call a wall-clock timeout, and spaces the attempts of a decision (the retry of an answer that was not accepted waits a little longer each time). It knows nothing of providers:
// it runs what it is given and says how it ended. Wall time lives here and nowhere in the simulation: the simulated clock waits for the answer (lockstep) or models its latency (`latency-modeled`).

// Timers are the host's (the sim worker, the browser, node): this package is built without a library that declares them, so it names the two it uses.
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

export interface QueueOptions {
  /** Calls running together (default 1). */
  readonly concurrency?: number;
  /** The wait before the second attempt of a decision, in ms; it doubles for each attempt after (none by default). */
  readonly backoffMs?: number;
  /** The longest backoff, in ms (default 30,000). */
  readonly maxBackoffMs?: number;
  /** Sleeps for `ms` (a test pins it; the real one is `setTimeout`). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type QueueResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "timeout" } | { readonly ok: false; readonly reason: "error"; readonly message: string };

export class InferenceQueue {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: QueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(o.concurrency ?? 1));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** What the status line says while a decision waits for S2: calls running and calls waiting for a place. */
  get status(): { readonly active: number; readonly waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }

  /** Runs `fn` when there is a place, giving up on it after `timeoutMs` of wall time; its failure and its timeout are answers, not exceptions. */
  async run<T>(fn: () => Promise<T>, timeoutMs: number): Promise<QueueResult<T>> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    let timer: unknown;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const raced = await Promise.race([fn().then((value) => ({ value }), (e: unknown) => ({ error: e })), timeout]);
      if (raced === "timeout") return { ok: false, reason: "timeout" };
      if ("error" in raced) return { ok: false, reason: "error", message: raced.error instanceof Error ? raced.error.message : String(raced.error) };
      return { ok: true, value: raced.value };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.active--;
      this.waiters.shift()?.();
    }
  }

  /** The wait before attempt `attempt + 1` of a decision (called after the attempt that failed): `backoffMs`, doubling, capped. No backoff configured: no wait. */
  async backoff(attempt: number): Promise<void> {
    const base = this.o.backoffMs;
    if (base === undefined || base <= 0) return;
    await this.sleep(Math.min(this.o.maxBackoffMs ?? 30_000, base * 2 ** (attempt - 1)));
  }
}
