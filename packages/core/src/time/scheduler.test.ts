import { describe, expect, it } from "vitest";
import { LockstepDriver, RealtimeDriver, Scheduler, type DegradationEvent, type Steppable, type TickContext } from "./scheduler.ts";

/** Records every tick it sees and fails on any gap or dt change. */
class TickRecorder implements Steppable {
  readonly ticks: number[] = [];
  step(ctx: TickContext): void {
    const prev = this.ticks.at(-1) ?? 0;
    if (ctx.tick !== prev + 1) throw new Error(`gap ${prev} -> ${ctx.tick}`);
    if (ctx.dtS !== 0.1) throw new Error("dt changed");
    if (ctx.simTimeS !== ctx.tick * 0.1) throw new Error("sim time drift");
    this.ticks.push(ctx.tick);
  }
}

describe("scheduler and drivers (ADR-0003, ADR-0013)", () => {
  it("lockstep never skips ticks, even when the host falls far behind", () => {
    const world = new TickRecorder();
    const s = new Scheduler(world, 0.1);
    const d = new LockstepDriver(s, 10, 8);
    d.start(0);
    // Irregular, slow host: huge wall-time jumps between calls (e.g. a slow tick or a stalled tab).
    const calls = [50, 120, 5000, 5010, 9000, 20_000, 20_001];
    for (const t of calls) d.advance(t);
    // Keep calling until the backlog is drained: every due tick runs, in order, none dropped.
    let t = 20_001;
    while (d.backlog(t) > 0) d.advance(t++);
    expect(world.ticks.length).toBe(Math.floor((20_001 * 10) / 1000));
    expect(world.ticks).toEqual(Array.from({ length: world.ticks.length }, (_, i) => i + 1));
  });

  it("lockstep executes at most maxTicksPerAdvance per call (stays responsive) and keeps the rest owed", () => {
    const world = new TickRecorder();
    const d = new LockstepDriver(new Scheduler(world, 0.1), 10, 8);
    d.start(0);
    expect(d.advance(10_000)).toBe(8);
    expect(d.backlog(10_000)).toBe(92);
  });

  it("lockstep stops a batch while the world is not ready (a mind is thinking) and resumes without a burst", () => {
    const world = new TickRecorder();
    let ready = true;
    const d = new LockstepDriver(new Scheduler(world, 0.1), 10, 8, () => ready);
    d.start(0);
    expect(d.advance(300)).toBe(3);
    ready = false;
    expect(d.advance(1000)).toBe(0); // the sim clock stops while a decision is outstanding (ADR-0003)
    ready = true;
    d.start(5000); // the host restarts pacing after the wait: no backlog from the pause
    expect(d.advance(5100)).toBe(1);
    expect(world.ticks).toEqual([1, 2, 3, 4]);
  });

  it("realtime drops overrun ticks and reports every skip as a degradation (never silent)", () => {
    const world = new TickRecorder();
    const s = new Scheduler(world, 0.1);
    const events: DegradationEvent[] = [];
    const d = new RealtimeDriver(s, 10, (e) => events.push(e), 4);
    d.start(0);
    d.advance(100); // 1 due
    d.advance(200); // 1 due
    d.advance(3000); // 28 due -> 4 run, 24 skipped
    d.advance(3100); // 1 due, pacing rebased
    expect(world.ticks).toEqual([1, 2, 3, 4, 5, 6, 7]); // contiguous: the sim never jumps
    expect(events).toEqual([{ kind: "tick-overrun", tick: 6, simTimeS: 6 * 0.1, skippedTicks: 24, maxTicksPerAdvance: 4 }]);
  });

  it("realtime without overrun reports nothing", () => {
    const events: DegradationEvent[] = [];
    const d = new RealtimeDriver(new Scheduler(new TickRecorder(), 0.1), 10, (e) => events.push(e), 4);
    d.start(0);
    for (let t = 0; t <= 5000; t += 100) d.advance(t);
    expect(events).toEqual([]);
  });
});
