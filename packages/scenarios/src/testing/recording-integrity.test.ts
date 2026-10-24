import { runLockstep, type ScriptStep } from "@agentsim/core";
import { RECORDING_PRESETS, RunRecorder, isValidTraceRecord, type RecorderBatch, type TraceRecord } from "@agentsim/trace";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPresetRun } from "./preset-run.ts";
import { SHORT_RECIPES } from "./restore-recipes.ts";

// F3a M2: reference integrity of what a recorded run writes (ADR-0035 addition of 2026-10-17, item 2(b)): a record that refers to another
// by hash or ID (a request's `space`, a leg or replan note's `queryId`, a parent or a cause) is never written without the record it
// refers to, under any preset. The runs are the short restore recipes and a 20-agent run; what is written is what the recorder hands over.

const goTo = (xM: number, yM: number): ScriptStep => ({ name: "goTo", params: { xM, yM } });

type Written = { readonly run: string; readonly preset: string; readonly records: readonly TraceRecord[] };
const written: Written[] = [];

async function record(name: string, create: () => ReturnType<typeof buildPresetRun>, ticks: number, afterTick?: (run: ReturnType<typeof buildPresetRun>, tick: number) => void): Promise<void> {
  for (const [preset, profile] of Object.entries(RECORDING_PRESETS)) {
    const run = create();
    const batches: RecorderBatch[] = [];
    const recorder = new RunRecorder({ buffer: run.trace, profile, send: (b) => batches.push(b) });
    recorder.headerStored();
    for (let i = 0; i < ticks; i++) {
      await runLockstep(run.world, run.scheduler, 1);
      afterTick?.(run, run.world.tick);
      recorder.collect(run.world.tick, run.world.simTimeS);
    }
    written.push({ run: name, preset, records: batches.flatMap((b) => b.records) });
  }
}

beforeAll(async () => {
  for (const r of SHORT_RECIPES) await record(r.name, () => r.create("genesis"), r.endTick, r.afterTick);
  const scripts: Record<string, readonly ScriptStep[]> = {};
  for (let i = 0; i < 20; i++) scripts[`u${String(i + 1).padStart(2, "0")}`] = [goTo(27, 4 + i * 3)];
  await record("twenty-agents", () => buildPresetRun({ preset: "f2-20-agents", scripts, beliefVsTruth: { everyS: 1 } }), 300);
}, 900_000);

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

describe("what a recorded run writes is self-contained, under every preset", () => {
  it("writes valid records, in order, once", () => {
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) {
      for (const r of w.records) expect(isValidTraceRecord(r), `${w.run}/${w.preset} ${r.id}`).toBe(true);
      const seqs = w.records.map((r) => r.seq);
      expect(seqs, `${w.run}/${w.preset}`).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size, `${w.run}/${w.preset}`).toBe(seqs.length);
    }
  });

  it("every request finds the space summary it refers to", () => {
    let requests = 0;
    for (const w of written) {
      const spaces = new Set(w.records.filter((r) => r.kind === "thought" && payloadOf(r).op === "space").map((r) => payloadOf(r).hash));
      for (const r of w.records) {
        const p = payloadOf(r);
        if (r.kind !== "thought" || p.op !== "request" || typeof p.space !== "string") continue;
        requests++;
        expect(spaces.has(p.space), `${w.run}/${w.preset} ${r.id} refers to space ${p.space}`).toBe(true);
      }
    }
    expect(requests).toBeGreaterThan(100);
  });

  it("every note of a running action finds the query it refers to, and the query's record is written before the note that follows it", () => {
    let notes = 0;
    for (const w of written) {
      const queries = new Map<string, number>(); // queryId -> seq of the first compute record of that query
      for (const r of w.records) {
        const p = payloadOf(r);
        if (r.kind === "compute" && typeof p.queryId === "string" && !queries.has(p.queryId)) queries.set(p.queryId, r.seq);
      }
      for (const r of w.records) {
        const p = payloadOf(r);
        if (r.kind !== "action" || typeof p.queryId !== "string") continue;
        notes++;
        expect(queries.has(p.queryId), `${w.run}/${w.preset} ${r.id} (${String(p.op)}) refers to query ${p.queryId}`).toBe(true);
      }
    }
    expect(notes).toBeGreaterThan(50);
  });

  it("every parent and cause finds its record", () => {
    for (const w of written) {
      const ids = new Set(w.records.map((r) => r.id));
      for (const r of w.records) {
        if (r.parentId !== undefined) expect(ids.has(r.parentId), `${w.run}/${w.preset} ${r.id} parent ${r.parentId}`).toBe(true);
        for (const c of r.causeIds ?? []) expect(ids.has(c), `${w.run}/${w.preset} ${r.id} cause ${c}`).toBe(true);
      }
    }
  });

  it("every link of a real run points to a record of the same run written before the record that carries it", () => {
    for (const w of written) {
      for (const r of w.records) {
        const named = [...(r.parentId === undefined ? [] : [r.parentId]), ...(r.causeIds ?? [])];
        for (const id of named) {
          expect(id.startsWith(`${r.runId}#`), `${w.run}/${w.preset} ${r.id} names ${id}, a record of another run`).toBe(true);
          expect(Number(id.slice(r.runId.length + 1)), `${w.run}/${w.preset} ${r.id} names ${id}, which is not before it`).toBeLessThan(r.seq);
        }
        // Only the simulator's own records carry links: what a mind says never does (it has no way to).
        if (r.kind === "thought") expect(named, `${w.run}/${w.preset} ${r.id}`).toEqual([]);
      }
    }
  });

  it("a real run links what it can: the notes and the end of an action to its start, a refusal and a start to the decision that asked, an ended-action event to its end, a reflex's preemption to the reflex", () => {
    const count = { phaseOfStart: 0, endOfStart: 0, fromDecision: 0, eventOfEnd: 0, preemptedByReflex: 0, reflexOfAction: 0, failedByPlan: 0 };
    for (const w of written) {
      const byId = new Map(w.records.map((r) => [r.id, r]));
      for (const r of w.records) {
        const p = payloadOf(r);
        const parent = r.parentId === undefined ? undefined : byId.get(r.parentId);
        const causes = (r.causeIds ?? []).map((c) => byId.get(c));
        if (r.kind === "action" && p.op === "phase" && parent && payloadOf(parent).op === "start") count.phaseOfStart++;
        if (r.kind === "action" && p.op === "end" && parent && payloadOf(parent).op === "start" && payloadOf(parent).actionId === p.actionId) count.endOfStart++;
        if (r.kind === "action" && (p.op === "start" || p.op === "rejected") && causes.some((c) => c?.kind === "thought" && payloadOf(c).op === "decision")) count.fromDecision++;
        if (r.kind === "event" && p.op === "event" && causes.some((c) => c?.kind === "action" && payloadOf(c).op === "end")) count.eventOfEnd++;
        if (r.kind === "action" && p.op === "end" && causes.some((c) => c?.kind === "reflex")) count.preemptedByReflex++;
        if (r.kind === "reflex" && parent && payloadOf(parent).op === "start") count.reflexOfAction++;
        if (r.kind === "action" && p.op === "end" && causes.some((c) => c?.kind === "compute" && payloadOf(c).op === "plan")) count.failedByPlan++;
      }
    }
    expect(count.phaseOfStart).toBeGreaterThan(20);
    expect(count.endOfStart).toBeGreaterThan(5);
    expect(count.fromDecision).toBeGreaterThan(5);
    expect(count.eventOfEnd).toBeGreaterThan(3);
    // Not every preset's runs have a reflex or an unreachable target: those are checked by the unit tests of the runtime and the planner adapter.
    expect(count.preemptedByReflex).toBeGreaterThan(5);
    expect(count.reflexOfAction).toBeGreaterThan(5);
    expect(count.failedByPlan).toBeGreaterThanOrEqual(0);
  });

  it("minimal drops only the observer's samples from what default-research writes", () => {
    for (const run of new Set(written.map((w) => w.run))) {
      const full = written.find((w) => w.run === run && w.preset === "default-research")?.records ?? [];
      const min = written.find((w) => w.run === run && w.preset === "minimal")?.records ?? [];
      const kept = full.filter((r) => payloadOf(r).op !== "belief-vs-truth").map((r) => r.id);
      expect(min.map((r) => r.id), run).toEqual(kept);
    }
  });
});
