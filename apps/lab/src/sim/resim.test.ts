import { RECORDING_PRESETS, type TraceRecord } from "@agentsim/trace";
import { beforeAll, describe, expect, it } from "vitest";
import { completeReferences, MAX_WINDOW_S, resimulateWindow, unresolvedReferences, type ResimWindowRequest } from "./resim-window.ts";
import { checkpointsOf, recordedParent, type Parent } from "./resim-test-support.ts";

// F3b M2 (ADR-0035 section 3 and its addition of 2026-10-17, item 10): a window of a recorded run is executed again from the last snapshot at or before it, into a derived run;
// the checkpoints of the window are compared with the parent's, and a run input that is missing makes it divergent, at the right tick.

let parent: Parent;
beforeAll(async () => {
  parent = await recordedParent(260); // 26 s: a snapshot every 2 s, a checkpoint every 5 ticks, a rover exploring
}, 120_000);

const dtS = 0.1;
/**
 * A record's content without what depends on where the run was recorded from: a snapshot holds the trace's cursor (seq numbers), so its hash, and the checkpoint that
 * names it, differ between a recording that started at tick 0 and one that started at tick 149 although the state is the same.
 */
const keyOf = (r: TraceRecord) => {
  const { snapshotHash: _h, ...payload } = (r.payload !== null && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
  return JSON.stringify([r.simTime, r.source, r.kind, r.agentId ?? null, r.detail ?? null, r.kind === "snapshot" ? null : payload]);
};

function request(window: { t0S: number; t1S: number }, over: Partial<ResimWindowRequest> = {}): ResimWindowRequest {
  const startTick = Math.max(0, Math.round(window.t0S / dtS) - 1);
  const snap = [...parent.snapshots].filter((s) => s.tick > 0 && s.tick <= startTick).sort((a, b) => b.tick - a.tick)[0];
  return {
    runId: "run-000002",
    scenario: parent.scenario,
    scenarioVersion: parent.version,
    runConfig: parent.runConfig,
    inputs: parent.inputs,
    window,
    profile: parent.profile,
    ...(snap ? { snapshot: { tick: snap.tick, bytes: snap.bytes, resolve: (h: string) => parent.blobs.get(h) } } : {}),
    checkpoints: checkpointsOf(parent.records),
    parentRunId: "run-000001",
    nowWallMs: () => 0,
    ...over,
  };
}

function run(window: { t0S: number; t1S: number }, over: Partial<ResimWindowRequest> = {}) {
  const r = resimulateWindow(request(window, over));
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

describe("re-simulating a window of a recorded run", () => {
  it("reproduces every checkpoint of several windows, from a snapshot or from the start", () => {
    for (const w of [{ t0S: 0, t1S: 4 }, { t0S: 5, t1S: 9 }, { t0S: 9.7, t1S: 14.2 }, { t0S: 15, t1S: 25.9 }]) {
      const r = run(w);
      expect(r.derived.status, JSON.stringify(w)).toBe("matches");
      expect(r.derived.checkpointsChecked, JSON.stringify(w)).toBeGreaterThan(0);
      expect(r.derived.endTick).toBe(Math.round(w.t1S / dtS));
      expect(r.derived.parentRunId).toBe("run-000001");
      expect(r.derived.divergence).toBeUndefined();
    }
  }, 120_000);

  it("a window that starts after the start restores a snapshot, and holds the records the parent made in it, with the same content", () => {
    const w = { t0S: 15, t1S: 19 };
    const r = run(w);
    expect(r.derived.startTick).toBe(149);
    const mine = r.batches.flatMap((b) => b.records);
    expect(mine[0]?.runId).toBe("run-000002");
    const from = (r.derived.startTick + 1) * dtS - 1e-9;
    const theirs = parent.records.filter((x) => x.simTime >= from && x.simTime <= w.t1S + 1e-9);
    const have = new Map<string, number>();
    for (const x of mine.filter((y) => y.simTime >= from)) have.set(keyOf(x), (have.get(keyOf(x)) ?? 0) + 1);
    // Every record the parent made in the window is there (a profile of its own may add the ones the parent's did not keep).
    const missing = theirs.filter((x) => {
      const k = keyOf(x);
      const n = have.get(k) ?? 0;
      if (n === 0) return true;
      have.set(k, n - 1);
      return false;
    });
    expect(missing.map((x) => `${x.simTime} ${x.source} ${x.kind}`)).toEqual([]);
    expect(theirs.length).toBeGreaterThan(20);
  }, 120_000);

  it("the same window from a snapshot and from the start gives the same records", () => {
    const w = { t0S: 11, t1S: 13 };
    const a = run(w);
    const { snapshot: _unused, ...rest } = request(w);
    const r2 = resimulateWindow(rest);
    if (!r2.ok) throw new Error(r2.error.message);
    const b = r2.value;
    expect(b.derived.startTick).toBe(a.derived.startTick);
    const norm = (x: ReturnType<typeof run>) => x.batches.flatMap((bt) => bt.records).map((r) => keyOf(r));
    expect(norm(b)).toEqual(norm(a));
    expect(b.derived.status).toBe("matches");
  }, 120_000);

  it("records the window under a profile of its own: a richer one keeps what a lighter one did not, and a profile never changes what happens", () => {
    const w = { t0S: 15, t1S: 17 };
    const light = run(w, { profile: RECORDING_PRESETS["minimal"] });
    const full = run(w, { profile: RECORDING_PRESETS["debug-full"] });
    const count = (x: ReturnType<typeof run>) => x.batches.reduce((n, b) => n + b.records.length, 0);
    expect(count(full)).toBeGreaterThan(count(light));
    expect(light.derived.status).toBe("matches");
    expect(full.derived.status).toBe("matches");
  }, 120_000);

  it("a window whose run input was removed is divergent, at the first checkpoint that differs, and names both hashes", () => {
    expect(parent.inputs.length).toBeGreaterThan(0);
    const r = run({ t0S: 0, t1S: 12 }, { inputs: parent.inputs.slice(1) });
    expect(r.derived.status).toBe("divergent");
    const d = r.derived.divergence;
    expect(d).toBeDefined();
    const recorded = checkpointsOf(parent.records);
    expect(recorded.find((c) => c.tick === d?.tick)?.stateHash).toBe(d?.expected);
    expect(d?.actual).not.toBe(d?.expected);
    // The explore command is at tick 1 and the checkpoints are every 5 ticks: the first one after it is where the hashes part.
    expect(d?.tick).toBeGreaterThan(0);
    expect(d?.tick).toBeLessThanOrEqual(5);
    expect(d?.tick).toBeLessThanOrEqual(r.derived.endTick);
  }, 120_000);

  it("a snapshot is the state and the inputs after it are the record: an input the snapshot already carries is not applied twice", () => {
    // The one run input is at tick 1, so every snapshot after it carries it: with or without it in the list, a window from a snapshot matches.
    expect(run({ t0S: 15, t1S: 17 }, { inputs: [] }).derived.status).toBe("matches");
    expect(run({ t0S: 15, t1S: 17 }).derived.status).toBe("matches");
  }, 120_000);

  it("refuses a window that does not run forward, one that is too long, a scenario that does not open and a snapshot that does not fit", () => {
    const code = (over: Partial<ResimWindowRequest>, w = { t0S: 5, t1S: 6 }) => {
      const r = resimulateWindow(request(w, over));
      return r.ok ? "ok" : r.error.code;
    };
    expect(code({}, { t0S: 6, t1S: 5 })).toBe("window_invalid");
    expect(code({}, { t0S: Number.NaN, t1S: 5 })).toBe("window_invalid");
    expect(code({}, { t0S: 0, t1S: MAX_WINDOW_S + 1 })).toBe("window_too_long");
    expect(code({ scenario: { nonsense: true } })).toBe("scenario_invalid");
    expect(code({ snapshot: { tick: 30, bytes: new Uint8Array([1, 2, 3]), resolve: () => undefined } }, { t0S: 5, t1S: 6 })).toBe("snapshot_not_restorable");
  }, 120_000);

  it("a window is self-contained: what its records refer to and that is not among them is found in the parent and re-emitted as copies, marked with their original IDs", async () => {
    const r = run({ t0S: 17, t1S: 19 });
    const mine = r.batches.flatMap((b) => b.records);
    // The parent's records, as the controller reads them: by space hash, by query and by ID.
    const find = (need: ReturnType<typeof unresolvedReferences>) =>
      parent.records.filter((x) => {
        const p = (x.payload ?? {}) as Record<string, unknown>;
        return (x.kind === "thought" && p["op"] === "space" && need.spaces.has(String(p["hash"]))) || (x.kind === "compute" && need.queries.has(String(p["queryId"]))) || need.records.has(x.id.replace("run-000001", "run-000002"));
      });
    const done = await completeReferences("run-000001", "run-000002", mine, find);
    expect(unresolvedReferences([...done.copies, ...mine])).toEqual({ spaces: new Set(), queries: new Set(), records: new Set() });
    for (const c of done.copies) {
      expect(c.runId).toBe("run-000002");
      expect((c.payload as { copyOf?: string }).copyOf).toMatch(/^run-000001#\d+$/);
    }
    // They come first: before the window's first record, so the run keeps seq order equal to sim-time order.
    const firstSeq = Math.min(...mine.map((x) => x.seq));
    for (const c of done.copies) expect(c.seq).toBeLessThan(firstSeq);
    const all = [...done.copies, ...mine];
    for (let i = 1; i < all.length; i++) expect((all[i] as TraceRecord).simTime).toBeGreaterThanOrEqual((all[i - 1] as TraceRecord).simTime);
  }, 120_000);
});
