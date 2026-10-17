import { decodeValue, encodeValue, runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { checkRestore, recipeFacts, type MomentFacts, type RestoreApi, type RestoreRecipe } from "./restore-check.ts";
import { LONG_RECIPES, SHORT_RECIPES } from "./restore-recipes.ts";

// F3a M1, T-003: the restore harness is tested before it is used on a real restore (T-006). Its comparisons are tried
// on a "restore" by replay (re-run the first N ticks: right by construction) and on restores that are wrong in ways
// the state hash alone does not show. The recipes' snapshot ticks are tied to what each is meant to cover.

const byName = (name: string): RestoreRecipe => {
  const r = SHORT_RECIPES.find((x) => x.name === name);
  if (!r) throw new Error(name);
  return r;
};

/** The recipe on replay: a restore target is an ordinary run (the no-genesis path does not exist yet). */
const onReplay = (r: RestoreRecipe, endTick: number, snapshotTicks: readonly number[]): RestoreRecipe => ({ ...r, create: () => r.create("genesis"), endTick, snapshotTicks });

const priv = (o: unknown, key: string): unknown => (o as Record<string, unknown>)[key];

/** Snapshot = the tick and what the harness compares; restore = re-run N ticks (plus `after` to damage it). */
function replayApi(opts: { extraTicks?: number; nonce?: boolean; after?: (target: Parameters<RestoreApi["restore"]>[0]) => void } = {}): RestoreApi {
  let counter = 0;
  return {
    allowsHistory: true,
    snapshot: (run) => encodeValue({ tick: run.world.tick, hash: run.world.stateHash, records: run.trace.all().length, ...(opts.nonce ? { nonce: counter++ } : {}) }),
    async restore(target, bytes) {
      const { tick } = decodeValue(bytes) as { tick: number };
      await runLockstep(target.world, target.scheduler, tick + (opts.extraTicks ?? 0));
      opts.after?.(target);
    },
  };
}

describe("restore harness (F3a M1, T-003)", () => {
  const plain = onReplay(byName("plain-f1-demo"), 120, [1, 40]);

  it("accepts a restore that is right", async () => {
    const r = await checkRestore(plain, replayApi());
    expect(r.mismatches).toEqual([]);
    expect(r.facts.map((f) => f.tick)).toEqual([1, 40]);
  }, 60_000);

  it("rejects a restore that lands on the wrong tick, naming the first tick whose state hash differs", async () => {
    const r = await checkRestore(plain, replayApi({ extraTicks: 1 }));
    expect(r.mismatches.some((m) => /restored world is at tick/.test(m))).toBe(true);
    expect(r.mismatches.some((m) => /state hash/.test(m))).toBe(true);
  }, 60_000);

  it("rejects a snapshot that is not stable through restore: snapshot(restore(snapshot(w))) must equal snapshot(w)", async () => {
    const r = await checkRestore(plain, replayApi({ nonce: true }));
    expect(r.mismatches.some((m) => /snapshot\(restore\(snapshot\(w\)\)\) differs/.test(m))).toBe(true);
  }, 60_000);

  it("sees what the state hash does not: a restore that forgot the space summaries already traced changes the trace, not the hash", async () => {
    const forgetful = replayApi({ after: (t) => (priv(t.world, "seenSpaces") as Set<string>).clear() });
    // Timers make a request every 1.5 s, so the next request after the restore writes its `space` record again.
    const r = await checkRestore(onReplay(byName("timers-and-pending-requests"), 60, [10]), forgetful);
    expect(r.mismatches.some((m) => /trace records after the snapshot differ/.test(m))).toBe(true);
    expect(r.mismatches.some((m) => /state hash differs/.test(m))).toBe(false);
  }, 60_000);

  it("sees pending decision requests that a restore lost", async () => {
    const lossy = replayApi({
      after: (t) => {
        (priv(t.world, "slots") as unknown[]).fill(undefined);
        Reflect.set(t.world, "unanswered", 0);
      },
    });
    const r = await checkRestore(onReplay(byName("timers-and-pending-requests"), 40, [10]), lossy);
    expect(r.mismatches.some((m) => /pending decision requests/.test(m))).toBe(true);
  }, 60_000);
});

describe("restore recipes cover what they claim (F3a M1, T-003)", () => {
  const facts = new Map<string, readonly MomentFacts[]>();
  async function at(name: string): Promise<(tick: number) => MomentFacts> {
    if (!facts.has(name)) facts.set(name, await recipeFacts(byName(name)));
    const list = facts.get(name) ?? [];
    return (tick) => {
      const f = list.find((x) => x.tick === tick);
      if (!f) throw new Error(`${name}: no facts at tick ${tick}`);
      return f;
    };
  }

  it("plain run: planning at the start, a UAV climbing next to a goTo mid-action, a UAV landing", async () => {
    const f = await at("plain-f1-demo");
    expect(f(1).queries.length).toBeGreaterThan(0);
    expect(f(60).actions.map((a) => `${a.name}/${a.phase}`)).toEqual(expect.arrayContaining(["takeoff/climbing", "goTo/following"]));
    expect(f(330).actions.some((a) => a.name === "returnToBase" && a.phase === "landing")).toBe(true);
  }, 120_000);

  it("timers: decision requests outstanding while timers are active", async () => {
    const f = await at("timers-and-pending-requests");
    for (const t of [10, 250]) expect(f(t).outstanding > 0 && f(t).timers > 0, `tick ${t}`).toBe(true);
    expect(f(160).outstanding).toBeGreaterThan(0);
  }, 120_000);

  it("explore: unreachable marks and a belief change the planner has not seen, a query in flight, a back-off", async () => {
    const f = await at("explore-unknown-map");
    expect(f(140).marks).toBeGreaterThan(0);
    expect(f(140).queries.some((q) => q.unseenChange)).toBe(true);
    expect(f(360).actions.some((a) => a.name === "explore" && a.phase === "planning")).toBe(true);
    expect(f(580).goTo.some((g) => g.backingOff)).toBe(true);
  }, 120_000);

  it("strategy: mid stage 1, then mid stage 2", async () => {
    const f = await at("strategy-mid-stage");
    for (const t of [2, 26]) expect(f(t).queries.some((q) => q.strategy && q.stagesDone === 0 && q.inStage), `tick ${t}`).toBe(true);
    expect(f(5).queries.some((q) => q.strategy && q.stagesDone >= 1 && q.inStage)).toBe(true);
  }, 120_000);

  it("lazy goTo: legs still being planned while the vehicle moves, at every snapshot tick", async () => {
    const f = await at("lazy-goto-mid-leg");
    for (const t of byName("lazy-goto-mid-leg").snapshotTicks) expect(f(t).goTo.some((g) => g.legsPending), `tick ${t}`).toBe(true);
  }, 120_000);

  it("belief-map prior: the rover's map holds the survey from tick 1", async () => {
    const f = await at("belief-map-prior-1km");
    expect(f(1).beliefChunks).toBeGreaterThan(0);
  }, 120_000);

  it("hold and takeoff: a UGV holding while a UAV climbs, then the UAV holding", async () => {
    const f = await at("hold-and-takeoff");
    expect(f(10).actions.map((a) => `${a.name}/${a.phase}`)).toEqual(expect.arrayContaining(["hold/holding", "takeoff/climbing"]));
    expect(f(130).actions.some((a) => a.agentId.startsWith("uav") && a.name === "hold")).toBe(true);
  }, 120_000);

  it("recipes are well formed: unique names, ascending snapshot ticks inside the run; the long set has runs of 1,000+ ticks and 20 agents", () => {
    for (const set of [SHORT_RECIPES, LONG_RECIPES]) {
      expect(new Set(set.map((r) => r.name)).size).toBe(set.length);
      for (const r of set) {
        expect([...r.snapshotTicks].sort((a, b) => a - b)).toEqual([...r.snapshotTicks]);
        expect(Math.max(...r.snapshotTicks)).toBeLessThan(r.endTick);
      }
    }
    expect(SHORT_RECIPES.map((r) => r.name)).toHaveLength(7);
    expect(LONG_RECIPES.every((r) => r.endTick >= 1000)).toBe(true);
    expect(LONG_RECIPES.some((r) => r.name === "twenty-agents")).toBe(true);
  });
});
