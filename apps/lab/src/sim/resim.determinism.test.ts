import { RECORDING_PRESETS, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { resimulateWindow, type ResimWindowRequest } from "./resim-window.ts";
import { checkpointsOf, recordedParent, type Parent, type ParentScenario } from "./resim-test-support.ts";

// F3b M2: several windows of recorded fixtures, under several profiles, every checkpoint of each reproduced (ADR-0035 section 3 and its addition of 2026-10-17, item 10). A window
// that does not match here is a determinism bug in restore or in the run, and a stop for the phase: the test names the window and the tick.

const dtS = 0.1;

function request(parent: Parent, window: { t0S: number; t1S: number }, profile = parent.profile): ResimWindowRequest {
  const startTick = Math.max(0, Math.round(window.t0S / dtS) - 1);
  const snap = [...parent.snapshots].filter((s) => s.tick > 0 && s.tick <= startTick).sort((a, b) => b.tick - a.tick)[0];
  return {
    runId: "run-000002",
    scenario: parent.scenario,
    scenarioVersion: parent.version,
    runConfig: parent.runConfig,
    inputs: parent.inputs,
    window,
    profile,
    ...(snap ? { snapshot: { tick: snap.tick, bytes: snap.bytes, resolve: (h: string) => parent.blobs.get(h) } } : {}),
    checkpoints: checkpointsOf(parent.records),
    parentRunId: "run-000001",
    nowWallMs: () => 0,
  };
}

const idOf = (r: TraceRecord) => JSON.stringify([r.simTime, r.source, r.kind, r.agentId ?? null]);

function expectMatches(parent: Parent, w: { t0S: number; t1S: number }, profile = parent.profile) {
  const r = resimulateWindow(request(parent, w, profile));
  if (!r.ok) throw new Error(`${JSON.stringify(w)}: ${r.error.code}: ${r.error.message}`);
  const d = r.value.derived;
  expect(d.status, `${JSON.stringify(w)} diverges at tick ${d.divergence?.tick}: ${d.divergence?.expected} against ${d.divergence?.actual}`).toBe("matches");
  expect(d.checkpointsChecked, JSON.stringify(w)).toBeGreaterThan(0);
  return r.value;
}

describe.each<[string, ParentScenario, number, { t0S: number; t1S: number }[]]>([
  ["F2 discovery, 120 s", "discovery", 1200, [{ t0S: 20, t1S: 30 }, { t0S: 55.5, t1S: 75 }, { t0S: 100, t1S: 119.9 }, { t0S: 0, t1S: 25 }, { t0S: 61, t1S: 61.2 }]],
  ["F2 twenty agents, 40 s", "twenty-agents", 400, [{ t0S: 5, t1S: 12 }, { t0S: 18.3, t1S: 29 }, { t0S: 30, t1S: 39.9 }]],
])("%s", (_name, scenario, ticks, windows) => {
  it("reproduces every checkpoint of every window, from the snapshot before it, and the parent's records of the window are in it", async () => {
    const parent = await recordedParent(ticks, { scenario });
    for (const w of windows) {
      const r = expectMatches(parent, w);
      const mine = r.batches.flatMap((b) => b.records);
      const from = (r.derived.startTick + 1) * dtS - 1e-9;
      const have = new Map<string, number>();
      for (const x of mine) have.set(idOf(x), (have.get(idOf(x)) ?? 0) + 1);
      const theirs = parent.records.filter((x) => x.simTime >= from && x.simTime <= w.t1S + 1e-9 && x.kind !== "snapshot");
      for (const x of theirs) {
        const k = idOf(x);
        const n = have.get(k) ?? 0;
        expect(n, `${JSON.stringify(w)}: ${k}`).toBeGreaterThan(0);
        have.set(k, n - 1);
      }
    }
  }, 600_000);

  it("is the same under every profile: a profile only changes what is recorded", async () => {
    const parent = await recordedParent(Math.min(ticks, 400), { scenario });
    const w = windows[0] as { t0S: number; t1S: number };
    const w2 = { t0S: Math.min(w.t0S, 10), t1S: Math.min(w.t1S, 30) };
    for (const profile of [RECORDING_PRESETS["minimal"], RECORDING_PRESETS["default-research"], RECORDING_PRESETS["debug-full"]]) expectMatches(parent, w2, profile);
  }, 600_000);
});
