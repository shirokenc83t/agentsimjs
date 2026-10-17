import { Clock } from "./clock.ts";

/** Context passed to every step: the tick being executed and the fixed step. */
export interface TickContext {
  readonly tick: number;
  readonly simTimeS: number;
  readonly dtS: number;
}

/** Anything advanced by the scheduler (the world in F1). Must be deterministic given its inputs. */
export interface Steppable {
  step(ctx: TickContext): void;
}

/** Degradation event (ADR-0013): only `realtime` may degrade; every degradation is reported. */
export interface DegradationEvent {
  readonly kind: "tick-overrun";
  /** Tick after which the skip was decided. */
  readonly tick: number;
  readonly simTimeS: number;
  /** Ticks that were due by wall time but dropped. */
  readonly skippedTicks: number;
  readonly maxTicksPerAdvance: number;
}

export type DegradationSink = (e: DegradationEvent) => void;

/**
 * Executes ticks one at a time in order. A tick is never skipped by the scheduler itself: skipping
 * is a decision of the realtime driver (and is reported). The world sees a contiguous tick sequence
 * with a constant `dtS` in every mode.
 */
export class Scheduler {
  readonly clock: Clock;

  constructor(private readonly world: Steppable, dtS: number) {
    this.clock = new Clock(dtS);
  }

  /** Executes exactly one tick. A step the world refuses (throws) leaves the clock where it was. */
  step(): number {
    const tick = this.clock.advance();
    try {
      this.world.step({ tick, simTimeS: this.clock.simTimeS, dtS: this.clock.dtS });
    } catch (e) {
      this.clock.setTick(tick - 1);
      throw e;
    }
    return tick;
  }

  /** Executes exactly `n` ticks (lockstep batch). */
  run(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }
}

/**
 * Paces a scheduler against wall time. The host calls `advance(wallNowMs)` from its timer; the
 * driver itself never reads a clock (wall time is an input, ADR-0002).
 */
export interface TickDriver {
  /** Resets pacing (play, speed change, resume after pause). */
  start(wallNowMs: number): void;
  /** Executes the ticks due at `wallNowMs`; returns how many were executed. */
  advance(wallNowMs: number): number;
  setSpeed(ticksPerSecond: number): void;
}

/**
 * `lockstep` (ADR-0003): never skips. If the host falls behind, owed ticks are carried over and
 * executed in later calls (bounded per call so the worker stays responsive); sim time simply runs
 * slower than wall time. Every tick due is eventually executed, in order.
 */
export class LockstepDriver implements TickDriver {
  private originMs = 0;
  private executedSinceStart = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private ticksPerSecond: number,
    private readonly maxTicksPerAdvance = 8,
    /**
     * Whether the world can take its next tick. False while a mind's decision is outstanding: the batch
     * stops and the sim clock waits (ADR-0003); the host restarts pacing once the decision arrives.
     */
    private readonly ready: () => boolean = () => true,
  ) {}

  start(wallNowMs: number): void {
    this.originMs = wallNowMs;
    this.executedSinceStart = 0;
  }

  setSpeed(ticksPerSecond: number): void {
    this.ticksPerSecond = ticksPerSecond;
  }

  /** Ticks owed but not yet executed. */
  backlog(wallNowMs: number): number {
    return Math.max(0, this.dueSinceStart(wallNowMs) - this.executedSinceStart);
  }

  private dueSinceStart(wallNowMs: number): number {
    return Math.floor(((wallNowMs - this.originMs) * this.ticksPerSecond) / 1000);
  }

  advance(wallNowMs: number): number {
    const due = Math.min(this.backlog(wallNowMs), this.maxTicksPerAdvance);
    let n = 0;
    while (n < due && this.ready()) {
      this.scheduler.step();
      n++;
    }
    this.executedSinceStart += n;
    return n;
  }
}

/**
 * Minimal `realtime` driver (F1; full realtime with mind latency arrives in F5). Sim time follows wall
 * time; when more ticks are due than `maxTicksPerAdvance`, the excess is **dropped** (the sim does not
 * jump: the remaining ticks are simply not executed and pacing is rebased) and a `tick-overrun`
 * degradation is reported. Never silent (ADR-0013).
 */
export class RealtimeDriver implements TickDriver {
  private originMs = 0;
  private executedSinceStart = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private ticksPerSecond: number,
    private readonly onDegradation: DegradationSink,
    private readonly maxTicksPerAdvance = 4,
  ) {}

  start(wallNowMs: number): void {
    this.originMs = wallNowMs;
    this.executedSinceStart = 0;
  }

  setSpeed(ticksPerSecond: number): void {
    this.ticksPerSecond = ticksPerSecond;
  }

  advance(wallNowMs: number): number {
    const due = Math.floor(((wallNowMs - this.originMs) * this.ticksPerSecond) / 1000) - this.executedSinceStart;
    if (due <= 0) return 0;
    const n = Math.min(due, this.maxTicksPerAdvance);
    for (let i = 0; i < n; i++) this.scheduler.step();
    this.executedSinceStart += n;
    const skipped = due - n;
    if (skipped > 0) {
      // Drop the excess: pacing continues from "now" instead of trying to catch up.
      this.executedSinceStart += skipped;
      this.onDegradation({
        kind: "tick-overrun",
        tick: this.scheduler.clock.tick,
        simTimeS: this.scheduler.clock.simTimeS,
        skippedTicks: skipped,
        maxTicksPerAdvance: this.maxTicksPerAdvance,
      });
    }
    return n;
  }
}
