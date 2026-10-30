import { runLockstep, type DecisionEnvelope, type DecisionRequest, type StatefulBrain } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildPresetRun } from "../testing/preset-run.ts";
import { restoreRun, snapshotRun } from "./snapshot-run.ts";

// F4 M1 (ADR-0036 addition of 2026-10-29, ADR-0005 addition): the notebook, a bookkeeping capability `note { text, mode }` that may accompany any decision. It is agent state: hashed only when it is
// not empty, in snapshots, returned to the mind in `self.notebook`, traced as an `event` op `note`.

/** A mind that answers from a list, one envelope per request, idle when the list is out, and keeps every request it saw. */
class Scripted implements StatefulBrain {
  readonly tier = "S2" as const;
  readonly requests: DecisionRequest[] = [];
  private n = 0;
  constructor(
    readonly id: string,
    private readonly answers: readonly DecisionEnvelope[],
  ) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    return Promise.resolve(this.answers[this.n++] ?? { decision: { kind: "idle" } });
  }
  snapshotState(): unknown {
    return this.n;
  }
  restoreState(state: unknown): void {
    this.n = state as number;
  }
}

const idle = { kind: "idle" as const };
const note = (text: string, mode: "replace" | "append") => ({ decision: idle, note: { text, mode } }) as DecisionEnvelope;
const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
const build = (answers: readonly DecisionEnvelope[], mode: "genesis" | "restore-target" = "genesis") => {
  const brain = new Scripted("llm", answers);
  const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, brains: { scout: brain } }, mode);
  return { run, brain };
};
const notesOf = (run: ReturnType<typeof buildPresetRun>) => run.trace.all().filter((r) => r.kind === "event" && payloadOf(r).op === "note");
const rejected = (run: ReturnType<typeof buildPresetRun>) => run.trace.all().filter((r) => r.kind === "action" && payloadOf(r).op === "rejected");

/** Runs until the mind has been asked `n` times (the timer of a note-only decision wakes it: a note starts nothing, so a timer is how a test gets its next request). */
async function until(run: ReturnType<typeof buildPresetRun>, brain: Scripted, n: number, maxTicks = 400): Promise<void> {
  for (let t = 0; t < maxTicks && brain.requests.length < n; t += 5) await runLockstep(run.world, run.scheduler, 5);
  if (brain.requests.length < n) throw new Error(`the mind was asked ${brain.requests.length} times, not ${n}`);
}
const withTimer = (e: DecisionEnvelope): DecisionEnvelope => ({ ...e, timers: [{ op: "set", tag: "wake", delayS: 1 }] });

describe("the notebook", () => {
  it("is empty and absent from the request at first, takes a note, and returns it in the next request; append adds after it and replace overwrites it", async () => {
    const { run, brain } = build([withTimer(note("visit B", "replace")), withTimer(note(" then C", "append")), withTimer(note("fresh start", "replace"))]);
    await until(run, brain, 4);
    const books = brain.requests.map((r) => (r.self as { notebook?: string }).notebook);
    expect(books).toEqual([undefined, "visit B", "visit B then C", "fresh start"]);
    expect(notesOf(run).map((r) => [payloadOf(r).mode, payloadOf(r).chars, payloadOf(r).text])).toEqual([
      ["replace", 7, "visit B"],
      ["append", 14, " then C"],
      ["replace", 11, "fresh start"],
    ]);
    expect(notesOf(run).every((r) => r.source === "uav-001/s2" && r.agentId === "uav-001")).toBe(true);
  });

  it("holds at most 2,000 characters: a longer note is refused with note_too_long as the brain hears it, and the notebook stays as it was", async () => {
    const { run, brain } = build([withTimer(note("x".repeat(1500), "replace")), withTimer(note("y".repeat(501), "append")), withTimer(note("z".repeat(2001), "replace")), withTimer(note("w".repeat(500), "append"))]);
    await until(run, brain, 5);
    expect(rejected(run).map((r) => [payloadOf(r).name, (payloadOf(r).failure as { code?: string } | string | undefined) ?? payloadOf(r).code])).toBeDefined();
    const lasts = brain.requests.map((r) => ((r.self as { notebook?: string }).notebook ?? "").length);
    expect(lasts).toEqual([0, 1500, 1500, 1500, 2000]); // the two too-long notes changed nothing, the last fits exactly
    const events = brain.requests.flatMap((r) => r.events).filter((e) => e.kind === "actionRejected" && e.name === "note");
    expect(events.map((e) => (e as { code: string }).code)).toEqual(["note_too_long", "note_too_long"]);
  });

  it("is agent state: a run that never notes hashes as before, a notebook changes the hash, and it is not part of any other agent's", async () => {
    const quiet = build([withTimer({ decision: idle })]);
    const noted = build([withTimer(note("remember", "replace"))]);
    await until(quiet.run, quiet.brain, 2);
    await until(noted.run, noted.brain, 2);
    expect(noted.run.world.stateHash).not.toBe(quiet.run.world.stateHash);
    // The same note again gives the same hash (it is state, not history).
    const again = build([withTimer(note("remember", "replace"))]);
    await until(again.run, again.brain, 2);
    expect(again.run.world.stateHash).toBe(noted.run.world.stateHash);
  });

  it("is in a snapshot: restored into a fresh run, the notebook is back and the run goes on to the same hashes", async () => {
    const answers = [withTimer(note("the plan", "replace")), withTimer({ decision: idle }), withTimer({ decision: idle })];
    const original = build(answers);
    await until(original.run, original.brain, 2);
    const bytes = snapshotRun(original.run);
    const tick = original.run.world.tick;
    const checkpoints = new Map<number, string>();
    for (let i = 0; i < 6; i++) {
      await runLockstep(original.run.world, original.run.scheduler, 10);
      checkpoints.set(original.run.world.tick, original.run.world.stateHash);
    }
    const fork = build(answers, "restore-target");
    restoreRun(fork.run, bytes);
    expect(fork.run.world.tick).toBe(tick);
    for (let i = 0; i < 6; i++) {
      await runLockstep(fork.run.world, fork.run.scheduler, 10);
      expect(fork.run.world.stateHash, `tick ${fork.run.world.tick}`).toBe(checkpoints.get(fork.run.world.tick));
    }
    // The fork's mind was asked again with the notebook the snapshot held.
    expect(fork.brain.requests.some((r) => (r.self as { notebook?: string }).notebook === "the plan")).toBe(true);
  });

  it("accompanies an action too: a decision that starts something and notes, and the note is applied before the action starts", async () => {
    const { run, brain } = build([{ decision: { kind: "action", name: "takeoff", params: { altitudeM: 12 } }, note: { text: "took off to 12", mode: "replace" } }]);
    await until(run, brain, 2);
    const all = run.trace.all();
    const noteAt = all.findIndex((r) => r.kind === "event" && payloadOf(r).op === "note");
    const startAt = all.findIndex((r) => r.kind === "action" && payloadOf(r).op === "start" && payloadOf(r).name === "takeoff");
    expect(noteAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(noteAt);
    expect((brain.requests[1]?.self as { notebook?: string }).notebook).toBe("took off to 12");
  });
});
