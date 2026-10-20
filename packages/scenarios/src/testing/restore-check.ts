import { runLockstep } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import type { RunMode } from "./preset-run.ts";
import type { ReferenceRun } from "./reference-run.ts";

// Restore acceptance harness (F3a M1; ADR-0035 addition of 2026-10-17, item 8). It compares an uninterrupted run
// with a run that was snapshotted at tick N, restored into a freshly assembled run that skips genesis, and continued.
// `stateHash` alone is not the criterion (it does not cover planner queries, RNG states or behaviour internals), so
// the harness compares what a continuation shows: the hash at every tick, the pending decision requests, the trace
// records (timer events included), and the snapshot bytes themselves. It returns a list of mismatches rather than
// asserting, so the harness can be tested with a restore that is right and one that is wrong.

/** What a restore needs from the run composition (`snapshotRun` and `restoreRun` in scenarios/assemble). */
export interface RestoreApi {
  /** The snapshot of a run between ticks, as container bytes (packages/core/src/snapshot). */
  snapshot(run: ReferenceRun): Uint8Array;
  /** Puts the snapshot into a freshly assembled run that skipped genesis, in place. */
  restore(target: ReferenceRun, bytes: Uint8Array): void | Promise<void>;
  /** The harness's own tests restore by replay, so the target already holds the records before the snapshot. */
  readonly allowsHistory?: true;
}

export interface RestoreRecipe {
  readonly name: string;
  /** A run at tick 0: with genesis, or as the target of a restore. */
  readonly create: (mode: RunMode) => ReferenceRun;
  /** The tick the uninterrupted run (and every restored one) ends at. */
  readonly endTick: number;
  /** The ticks to snapshot at: early, mid-action, mid-query. */
  readonly snapshotTicks: readonly number[];
  /**
   * Called after each tick of every run of the recipe (the uninterrupted one, the source and the restored ones, which only run
   * the ticks after their snapshot), with the tick just run: for belief changes injected at the end of a tick, which is when
   * a snapshot finds a query one change behind.
   */
  readonly afterTick?: (run: ReferenceRun, tick: number) => void;
}

/** What a moment of a run looks like, to show that a snapshot tick covers the case it was chosen for. */
export interface MomentFacts {
  readonly tick: number;
  /** Decision requests asked and not yet answered. */
  readonly outstanding: number;
  /** Active timers over all agents. */
  readonly timers: number;
  readonly actions: readonly { readonly agentId: string; readonly name: string; readonly status: string; readonly phase: string }[];
  /**
   * Planner queries in flight. `stagesDone` counts a strategy's completed searches. `pending` is a belief change the query has not
   * examined yet, as its snapshot holds it: `overlap` when the changed chunks include one its search has read (it will restart),
   * `graphMoved` when its HPA* graph moved.
   */
  readonly queries: readonly { readonly agentId: string; readonly strategy: boolean; readonly stagesDone: number; readonly inStage: boolean; readonly lazy: boolean; readonly pending: boolean; readonly overlap: boolean; readonly graphMoved: boolean }[];
  /** Behaviours of running goTo (also inside explore): lazy legs pending, holding for the next leg, backing off. */
  readonly goTo: readonly { readonly agentId: string; readonly legsPending: boolean; readonly holding: boolean; readonly backingOff: boolean }[];
  /** Cells marked unreachable, over all agents. */
  readonly marks: number;
  /** Cells marked unreachable for the current exploration iteration only (ADR-0040), over all agents. */
  readonly temporaryMarks: number;
  /** Running explores: inside an iteration or travelling to the next centre, with the groups they remember failing and whether a goTo is in flight. */
  readonly explores: readonly { readonly agentId: string; readonly iterating: boolean; readonly mode: string; readonly failures: number; readonly inner: boolean }[];
  readonly beliefChunks: number;
}

export interface RestoreReport {
  readonly recipe: string;
  readonly mismatches: readonly string[];
  /** Facts of the uninterrupted run at each snapshot tick. */
  readonly facts: readonly MomentFacts[];
}

const priv = (o: unknown, key: string): unknown => (o === undefined || o === null ? undefined : (o as Record<string, unknown>)[key]);
const values = (m: unknown): unknown[] => (m instanceof Map ? [...m.values()] : Array.isArray(m) ? m : []);
const nameOf = (o: unknown): string => (o as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? "";

export function momentFacts(run: ReferenceRun): MomentFacts {
  const agents = run.agents;
  const infos = agents.flatMap((a) => {
    const i = run.runtime.info(a.id);
    return i ? [{ agentId: a.id, name: i.name, status: i.status, phase: i.phase }] : [];
  });
  // What each query's snapshot holds of its pending change: the same content a restore would carry.
  const held = new Map(run.planner.service.snapshot().active.map((a) => [a.request.agentId, a.strategy ?? a]));
  const queries = (values(priv(run.planner.service, "active")) as Record<string, unknown>[]).map((q) => {
    const strat = priv(q, "strat");
    const agentId = String(priv(priv(q, "request"), "agentId"));
    const h = held.get(agentId);
    const chunks = h?.pending?.chunks ?? [];
    const read = h?.read ?? [];
    return {
      agentId,
      strategy: strat !== undefined,
      stagesDone: strat ? (priv(strat, "completed") as unknown[]).length : 0,
      inStage: strat ? priv(strat, "stage") !== undefined : false,
      lazy: strat ? priv(strat, "lazy") !== undefined : false,
      pending: h?.pending !== undefined,
      overlap: chunks.some((k) => read.includes(k)),
      graphMoved: h?.pending?.graphChanged === true,
    };
  });
  const goTo: { agentId: string; legsPending: boolean; holding: boolean; backingOff: boolean }[] = [];
  for (const [agentId, active] of priv(run.runtime, "active") as Map<string, unknown>) {
    let b = priv(active, "behavior");
    if (nameOf(b) === "ExploreBehavior") b = priv(b, "inner");
    if (nameOf(b) !== "GoToBehavior") continue;
    goTo.push({ agentId, legsPending: priv(b, "legsPending") === true, holding: priv(b, "holdStartS") !== undefined, backingOff: priv(b, "backingOff") === true });
  }
  const explores: { agentId: string; iterating: boolean; mode: string; failures: number; inner: boolean }[] = [];
  for (const [agentId, active] of priv(run.runtime, "active") as Map<string, unknown>) {
    const b = priv(active, "behavior");
    if (nameOf(b) !== "ExploreBehavior") continue;
    explores.push({ agentId, iterating: priv(b, "iteration") !== undefined, mode: String(priv(b, "mode")), failures: (priv(b, "failures") as Map<number, unknown>).size, inner: priv(b, "inner") !== undefined });
  }
  let marks = 0;
  for (const m of values(priv(run.topology, "marks"))) for (const c of values(priv(m, "byChunk"))) marks += (priv(c, "cells") as Set<number>).size;
  let temporaryMarks = 0;
  for (const m of values(priv(run.topology, "temporary"))) for (const c of values(priv(m, "byChunk"))) temporaryMarks += (priv(c, "cells") as Set<number>).size;
  let beliefChunks = 0;
  for (const s of values(priv(run.sensing, "byId"))) beliefChunks += (priv(s, "belief") as { materializedChunks: number }).materializedChunks;
  return {
    tick: run.world.tick,
    outstanding: run.world.outstandingCount,
    timers: (priv(run.world, "timers") as Map<string, number>[]).reduce((n, t) => n + t.size, 0),
    actions: infos,
    queries,
    goTo,
    marks,
    temporaryMarks,
    explores,
    beliefChunks,
  };
}

const norm = (r: TraceRecord): string => JSON.stringify({ ...r, wallTime: 0 });
const strip = (records: readonly TraceRecord[], fromSeq: number): string[] => records.filter((r) => r.seq >= fromSeq).map(norm);
const timerEvents = (records: readonly TraceRecord[], fromSeq: number): string[] =>
  records.filter((r) => r.seq >= fromSeq && r.kind === "event" && ((r.payload as { event?: { kind?: string } }).event?.kind === "timer" || (r.payload as { op?: string }).op?.startsWith("timer-"))).map(norm);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The decision requests a run holds between ticks: the open slots, and what each agent's next request would be. */
function pending(run: ReferenceRun): string {
  return JSON.stringify({ outstanding: run.world.outstanding, peek: run.agents.map((a) => run.world.peekRequest(a.id)) });
}

async function step(run: ReferenceRun, ticks: number, recipe?: RestoreRecipe): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await runLockstep(run.world, run.scheduler, 1);
    recipe?.afterTick?.(run, run.world.tick);
  }
}

interface Baseline {
  readonly hashes: Map<number, string>;
  readonly pendingAt: Map<number, string>;
  readonly seqAt: Map<number, number>;
  readonly facts: Map<number, MomentFacts>;
  readonly records: readonly TraceRecord[];
  readonly snapshotAtEnd: Uint8Array;
  readonly pendingAtEnd: string;
}

/** The uninterrupted run, to the end, with what the restored runs are compared against. */
async function baseline(recipe: RestoreRecipe, api: RestoreApi): Promise<Baseline> {
  const run = recipe.create("genesis");
  const wanted = new Set(recipe.snapshotTicks);
  const hashes = new Map<number, string>();
  const pendingAt = new Map<number, string>();
  const seqAt = new Map<number, number>();
  const facts = new Map<number, MomentFacts>();
  const note = (tick: number) => {
    if (!wanted.has(tick)) return;
    pendingAt.set(tick, pending(run));
    seqAt.set(tick, run.trace.all().length);
    facts.set(tick, momentFacts(run));
  };
  hashes.set(0, run.world.stateHash);
  note(0);
  for (let t = 1; t <= recipe.endTick; t++) {
    await step(run, 1, recipe);
    hashes.set(t, run.world.stateHash);
    note(t);
  }
  return { hashes, pendingAt, seqAt, facts, records: run.trace.all(), snapshotAtEnd: api.snapshot(run), pendingAtEnd: pending(run) };
}

/** Facts of the uninterrupted run at each snapshot tick (needs no restore). */
export async function recipeFacts(recipe: RestoreRecipe): Promise<readonly MomentFacts[]> {
  const run = recipe.create("genesis");
  const wanted = new Set(recipe.snapshotTicks);
  const out: MomentFacts[] = [];
  if (wanted.has(0)) out.push(momentFacts(run));
  for (let t = 1; t <= Math.max(...recipe.snapshotTicks); t++) {
    await step(run, 1, recipe);
    if (wanted.has(t)) out.push(momentFacts(run));
  }
  return out;
}

/**
 * Runs the restore acceptance check for every snapshot tick of the recipe: snapshot at N, restore into a fresh run that
 * skips genesis, continue to the end, and compare with the uninterrupted run.
 */
export async function checkRestore(recipe: RestoreRecipe, api: RestoreApi): Promise<RestoreReport> {
  const base = await baseline(recipe, api);
  const mismatches: string[] = [];
  const fail = (n: number, what: string) => mismatches.push(`${recipe.name} @${n}: ${what}`);
  for (const n of recipe.snapshotTicks) {
    const source = recipe.create("genesis");
    if (n > 0) await step(source, n, recipe);
    const bytes = api.snapshot(source);
    const target = recipe.create("restore-target");
    await api.restore(target, bytes);
    if (!same(api.snapshot(target), bytes)) fail(n, "snapshot(restore(snapshot(w))) differs from snapshot(w)");
    if (target.world.tick !== n) fail(n, `restored world is at tick ${target.world.tick}`);
    if (target.world.stateHash !== base.hashes.get(n)) fail(n, "state hash right after the restore differs");
    if (pending(target) !== base.pendingAt.get(n)) fail(n, "pending decision requests (outstanding, peekRequest) right after the restore differ");
    for (let t = n + 1; t <= recipe.endTick; t++) {
      await step(target, 1, recipe);
      if (target.world.stateHash !== base.hashes.get(t)) {
        fail(n, `state hash differs at tick ${t}`);
        break;
      }
    }
    const fromSeq = base.seqAt.get(n) ?? 0;
    const want = strip(base.records, fromSeq);
    const got = strip(target.trace.all(), fromSeq);
    if (!api.allowsHistory && target.trace.all().some((r) => r.seq < fromSeq)) fail(n, `the restored run holds records before the snapshot (seq < ${fromSeq})`);
    if (got.length !== want.length || got.some((r, i) => r !== want[i])) {
      const at = got.findIndex((r, i) => r !== want[i]);
      fail(n, `trace records after the snapshot differ (${got.length} vs ${want.length}; first difference at ${at < 0 ? Math.min(got.length, want.length) : at})`);
    }
    const wantTimers = timerEvents(base.records, fromSeq);
    const gotTimers = timerEvents(target.trace.all(), fromSeq);
    if (JSON.stringify(gotTimers) !== JSON.stringify(wantTimers)) fail(n, `timer events differ (${gotTimers.length} vs ${wantTimers.length})`);
    if (pending(target) !== base.pendingAtEnd) fail(n, "pending decision requests at the end differ");
    if (!same(api.snapshot(target), base.snapshotAtEnd)) fail(n, "the snapshot at the end differs from the uninterrupted run's");
  }
  return { recipe: recipe.name, mismatches, facts: [...base.facts.values()] };
}
