import { describe, expect, it } from "vitest";
import { InferenceQueue } from "./queue.ts";

// The inference queue (ADR-0036 section 10, F4 M1): a concurrency cap, a wall-clock timeout per call, a backoff between the attempts of one decision, and a count of what is waiting for the status line.

/** A call a test finishes by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
declare function setTimeout(fn: () => void, ms: number): unknown;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the inference queue", () => {
  it("runs at most `concurrency` calls at a time, the rest wait in order, and says how many wait", async () => {
    const q = new InferenceQueue({ concurrency: 2 });
    const calls = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const results = calls.map((c, i) =>
      q.run(() => {
        started.push(i);
        return c.promise;
      }, 1000),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(q.status).toEqual({ active: 2, waiting: 2 });
    calls[0]?.resolve("a");
    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(q.status).toEqual({ active: 2, waiting: 1 });
    calls[1]?.resolve("b");
    calls[2]?.resolve("c");
    await tick();
    calls[3]?.resolve("d");
    expect(await Promise.all(results)).toEqual([{ ok: true, value: "a" }, { ok: true, value: "b" }, { ok: true, value: "c" }, { ok: true, value: "d" }]);
    expect(q.status).toEqual({ active: 0, waiting: 0 });
  });

  it("gives up on a call that takes longer than its timeout and answers timeout, freeing its place", async () => {
    const q = new InferenceQueue({ concurrency: 1 });
    const never = new Promise<string>(() => {});
    const r = await q.run(() => never, 20);
    expect(r).toEqual({ ok: false, reason: "timeout" });
    expect(q.status).toEqual({ active: 0, waiting: 0 });
    expect(await q.run(() => Promise.resolve("next"), 20)).toEqual({ ok: true, value: "next" });
  });

  it("answers an error when the call throws, and a late answer to a call that timed out is dropped", async () => {
    const q = new InferenceQueue({ concurrency: 1 });
    expect(await q.run(() => Promise.reject(new Error("502 bad gateway")), 100)).toEqual({ ok: false, reason: "error", message: "502 bad gateway" });
    const late = deferred<string>();
    const r = q.run(() => late.promise, 10);
    expect(await r).toEqual({ ok: false, reason: "timeout" });
    late.resolve("too late");
    await tick();
    expect(q.status).toEqual({ active: 0, waiting: 0 });
  });

  it("waits between the attempts of a decision: the delay doubles from the first backoff and is capped, and it is told to the sleeper", async () => {
    const slept: number[] = [];
    const q = new InferenceQueue({ concurrency: 1, backoffMs: 100, maxBackoffMs: 350, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
    for (const attempt of [1, 2, 3, 4]) await q.backoff(attempt);
    expect(slept).toEqual([100, 200, 350, 350]);
    const none = new InferenceQueue({ concurrency: 1 });
    await expect(none.backoff(3)).resolves.toBeUndefined(); // no backoff configured: no wait
  });
});
