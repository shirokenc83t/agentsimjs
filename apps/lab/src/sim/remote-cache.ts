import type { CacheEntry, MindCache } from "@agentsim/minds";

// The System 2 minds' response cache across the worker boundary (F4 M2, T-112): the sim worker reads and writes through a message port, the main thread answers from the storage worker's cache. A memory
// front keeps what this session already read or wrote, so a decision's retry or a replay does not ask twice. Entries hold answers and figures, never a key or a header.

/** What either end of the channel needs of a port. */
export interface CachePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
  start?(): void;
}

type ToMain = { readonly type: "get"; readonly id: number; readonly key: string } | { readonly type: "put"; readonly key: string; readonly entry: CacheEntry };
type ToWorker = { readonly type: "value"; readonly id: number; readonly entry: CacheEntry | null };

/** The sim worker's end: a `MindCache` that asks the main thread. */
export class RemoteMindCache implements MindCache {
  private readonly front = new Map<string, CacheEntry>();
  private readonly waiting = new Map<number, (e: CacheEntry | undefined) => void>();
  private nextId = 1;

  constructor(private readonly port: CachePortLike) {
    port.addEventListener("message", (e) => {
      const m = e.data as ToWorker;
      if (m.type !== "value") return;
      const done = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      done?.(m.entry ?? undefined);
    });
    port.start?.();
  }

  get(key: string): Promise<CacheEntry | undefined> {
    const hit = this.front.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, (e) => {
        if (e !== undefined) this.front.set(key, e);
        resolve(e);
      });
      this.port.postMessage({ type: "get", id, key } satisfies ToMain);
    });
  }

  put(key: string, entry: CacheEntry): Promise<void> {
    this.front.set(key, entry);
    this.port.postMessage({ type: "put", key, entry } satisfies ToMain);
    return Promise.resolve();
  }
}

/** The main thread's end: answers the worker's reads and stores its writes in `cache` (the storage worker's port). A failed read is answered as a miss, a failed write is dropped (the run goes on, uncached). */
export function serveMindCache(port: CachePortLike, cache: { get(key: string): Promise<CacheEntry | undefined>; put(key: string, entry: CacheEntry): Promise<void> }): void {
  port.addEventListener("message", (e) => {
    const m = e.data as ToMain;
    if (m.type === "get") {
      cache.get(m.key).then(
        (entry) => port.postMessage({ type: "value", id: m.id, entry: entry ?? null } satisfies ToWorker),
        () => port.postMessage({ type: "value", id: m.id, entry: null } satisfies ToWorker),
      );
    } else if (m.type === "put") {
      cache.put(m.key, m.entry).catch(() => undefined);
    }
  });
  port.start?.();
}
