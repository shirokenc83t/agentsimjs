import { runLockstep, type ScriptStep } from "@agentsim/core";
import { CHANNELS, RECORDING_PRESETS, channelOf, filterRecord, type TraceRecord } from "@agentsim/trace";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPresetRun } from "./preset-run.ts";
import { SHORT_RECIPES } from "./restore-recipes.ts";

// F3a M2: every record the reference runs emit maps to exactly one channel (ADR-0035 addition of 2026-10-17, item 1), and under
// every preset every decision, action outcome, plan transition and algorithm query still has its record (the tracing rule, §8).
// The runs are the short restore recipes (plain, timers, explore on an unknown map with the observer, strategy mid-stage, lazy
// goTo, prior map, hold and takeoff, UAV altitudes) and a 20-agent run.

const goTo = (xM: number, yM: number): ScriptStep => ({ name: "goTo", params: { xM, yM } });

const records: { readonly run: string; readonly records: readonly TraceRecord[] }[] = [];

beforeAll(async () => {
  for (const r of SHORT_RECIPES) {
    const run = r.create("genesis");
    for (let i = 0; i < r.endTick; i++) {
      await runLockstep(run.world, run.scheduler, 1);
      r.afterTick?.(run, run.world.tick);
    }
    records.push({ run: r.name, records: run.trace.all() });
  }
  const scripts: Record<string, readonly ScriptStep[]> = {};
  for (let i = 0; i < 20; i++) scripts[`u${String(i + 1).padStart(2, "0")}`] = [goTo(27, 4 + i * 3)];
  const twenty = buildPresetRun({ preset: "f2-20-agents", scripts, beliefVsTruth: { everyS: 1 } });
  for (let i = 0; i < 300; i++) await runLockstep(twenty.world, twenty.scheduler, 1);
  records.push({ run: "twenty-agents", records: twenty.trace.all() });
}, 600_000);

describe("channel mapping on the reference runs", () => {
  it("maps every record to a channel", () => {
    const unmapped = new Map<string, number>();
    let total = 0;
    for (const { run, records: rs } of records) {
      for (const r of rs) {
        total++;
        if (channelOf(r) === undefined) {
          const op = (r.payload as { op?: unknown } | undefined)?.op;
          const key = `${run}: ${r.kind} ${r.source.split("/")[1]} ${String(op)}`;
          unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
        }
      }
    }
    expect(total).toBeGreaterThan(3000);
    expect([...unmapped]).toEqual([]);
  });

  it("covers every channel the F3a simulator emits: events, transitions, compute, mind-io and beliefs", () => {
    const seen = new Set<string>();
    for (const { records: rs } of records) for (const r of rs) seen.add(channelOf(r) ?? "none");
    for (const c of ["events", "transitions", "compute", "mind-io", "beliefs"] as const) expect(seen.has(c), c).toBe(true);
    for (const c of seen) expect(c === "none" || (CHANNELS as readonly string[]).includes(c)).toBe(true);
  });

  it("keeps the notes of a running action in `transitions` and the other actions in `events`", () => {
    const byOp = new Map<string, Set<string>>();
    for (const { records: rs } of records)
      for (const r of rs) {
        if (r.kind !== "action") continue;
        const op = String((r.payload as { op?: unknown }).op);
        byOp.set(op, (byOp.get(op) ?? new Set()).add(channelOf(r) ?? "none"));
      }
    for (const [op, channels] of byOp) expect([...channels], op).toEqual([op === "leg" || op === "hold" || op === "replan" ? "transitions" : "events"]);
    expect(byOp.has("leg")).toBe(true);
    expect(byOp.has("start")).toBe(true);
  });
});

describe("the tracing rule under every preset", () => {
  for (const [name, profile] of Object.entries(RECORDING_PRESETS)) {
    it(`${name}: every record outside the observer's samples is kept, in order, with the same id`, () => {
      for (const { run, records: rs } of records) {
        const kept = rs.map((r) => filterRecord(profile, r));
        const expected = rs.filter((r) => channelOf(r) !== "beliefs" || profile.channels.beliefs.level !== "off");
        expect(kept.filter((r) => r !== undefined).map((r) => r?.id), run).toEqual(expected.map((r) => r.id));
        // Detail may be lowered; identity, time, source, kind and subject never are.
        for (const [i, r] of rs.entries()) {
          const k = kept[i];
          if (k) expect({ ...k, payload: 0 }, `${run} ${r.id}`).toEqual({ ...r, payload: 0 });
        }
      }
    });

    it(`${name}: every algorithm query and every plan or action transition still has its record`, () => {
      for (const { run, records: rs } of records) {
        const kept = rs.flatMap((r) => filterRecord(profile, r) ?? []);
        const count = (list: readonly TraceRecord[], channel: string) => list.filter((r) => channelOf(r) === channel).length;
        for (const channel of ["compute", "transitions", "events", "mind-io"]) expect(count(kept, channel), `${run} ${channel}`).toBe(count(rs, channel));
        const queries = (list: readonly TraceRecord[]) => list.filter((r) => r.kind === "compute" && (r.payload as { op?: string }).op === "plan").map((r) => (r.payload as { queryId: string }).queryId);
        expect(queries(kept), run).toEqual(queries(rs));
      }
    });
  }

  it("minimal keeps the observer's samples out and every space record a request refers to in", () => {
    const profile = RECORDING_PRESETS.minimal;
    for (const { run, records: rs } of records) {
      const kept = rs.flatMap((r) => filterRecord(profile, r) ?? []);
      const spaces = new Set(kept.filter((r) => r.kind === "thought" && (r.payload as { op?: string }).op === "space").map((r) => (r.payload as { hash: string }).hash));
      for (const r of kept) {
        const p = r.payload as { op?: string; space?: unknown };
        if (r.kind === "thought" && p.op === "request" && typeof p.space === "string") expect(spaces.has(p.space), `${run} ${r.id}`).toBe(true);
      }
      expect(kept.some((r) => (r.payload as { op?: string }).op === "belief-vs-truth"), run).toBe(false);
    }
  });

  it("minimal replaces the bodies of the requests by hashes and the per-search waypoints of strategy queries by nothing", () => {
    const profile = RECORDING_PRESETS.minimal;
    let requests = 0;
    let strategies = 0;
    for (const { records: rs } of records)
      for (const r of rs) {
        const k = filterRecord(profile, r);
        const p = r.payload as { op?: string; strategy?: { searches: { waypoints?: unknown }[] } };
        if (r.kind === "thought" && p.op === "request") {
          requests++;
          expect((k?.payload as { self: unknown }).self).toMatch(/^[0-9a-f]{16}$/);
        }
        if (r.kind === "compute" && p.strategy) {
          strategies++;
          expect((k?.payload as typeof p).strategy?.searches.every((s) => !("waypoints" in s))).toBe(true);
        }
      }
    expect(requests).toBeGreaterThan(100);
    expect(strategies).toBeGreaterThan(0);
  });
});
