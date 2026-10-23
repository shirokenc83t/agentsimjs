import { f1DemoRunConfig, f1DemoScenario } from "@agentsim/scenarios";
import type { StorageClient } from "@agentsim/storage";
import { RECORDING_PRESETS } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { rerunHeadless, startRun, type LabRun } from "./run-controller.ts";
import type { SimClient } from "./sim-client.ts";

// A headless run from the lab (ADR-0029): started with the worker's headless option, always recorded, in lockstep, and its status follows its end.

function fakes() {
  const loads: Record<string, unknown>[] = [];
  const statuses: [string, string][] = [];
  let progress: ((m: unknown) => void) | undefined;
  const sim = {
    recorderAttached: true,
    load: async (m: Record<string, unknown>) => {
      loads.push(m);
      return { runId: m["runId"], scenarioId: "f1-demo", scenarioVersion: 1, seed: 1, runConfigHash: "00000000", effectiveConfigHash: "00000000", idealAgents: [], agents: [], timeMode: "lockstep" };
    },
    onInput: () => () => {},
    subscribe: (type: string, l: (m: unknown) => void) => {
      if (type === "progress") progress = l;
      return () => {
        progress = undefined;
      };
    },
  } as unknown as SimClient;
  const storage = {
    status: () => ({ state: "ready", mode: "memory-fallback" }),
    ports: {
      runs: {
        allocateRunId: async () => "run-000001",
        create: async () => ({ ok: true }),
        appendInputs: async () => ({ ok: true }),
        setStatus: async (runId: string, status: string) => {
          statuses.push([runId, status]);
          return { ok: true };
        },
      },
    },
  } as unknown as StorageClient;
  return { sim, storage, loads, statuses, report: (m: unknown) => progress?.(m) };
}

const profile = { mode: "stored" as const, profile: RECORDING_PRESETS["default-research"] };

describe("starting a headless run", () => {
  it("loads it headless with its end condition and a recording profile, and its status follows the worker's report: completed at its end, aborted when stopped early", async () => {
    const f = fakes();
    const run = await startRun(f.storage, f.sim, f1DemoScenario(), 1, f1DemoRunConfig(1), "demo", [], profile, { untilS: 30 });
    expect(f.loads[0]).toMatchObject({ runId: "run-000001", headless: { untilS: 30 }, recording: { mode: "stored" } });
    expect(run.headless).toEqual({ untilS: 30 });
    f.report({ runId: "run-000001", done: false, simTimeS: 10, untilS: 30 });
    expect(f.statuses).toEqual([]);
    f.report({ runId: "run-000001", done: true, simTimeS: 30, untilS: 30 });
    expect(f.statuses).toEqual([["run-000001", "completed"]]);
    // One that is stopped before its end is aborted.
    const g = fakes();
    await startRun(g.storage, g.sim, f1DemoScenario(), 1, f1DemoRunConfig(1), "demo", [], profile, { untilS: 30 });
    g.report({ runId: "run-000001", done: true, simTimeS: 12.3, untilS: 30 });
    expect(g.statuses).toEqual([["run-000001", "aborted"]]);
    // One with no end condition that is stopped is completed.
    const h = fakes();
    await startRun(h.storage, h.sim, f1DemoScenario(), 1, f1DemoRunConfig(1), "demo", [], profile, {});
    expect(h.loads[0]).toMatchObject({ headless: {} });
    h.report({ runId: "run-000001", done: true, simTimeS: 12.3 });
    expect(h.statuses).toEqual([["run-000001", "completed"]]);
  });

  it("a run that is not headless carries no headless option and is not watched for its end", async () => {
    const f = fakes();
    await startRun(f.storage, f.sim, f1DemoScenario(), 1, f1DemoRunConfig(1), "demo", [], profile);
    expect(f.loads[0]).not.toHaveProperty("headless");
    f.report({ runId: "run-000001", done: true, simTimeS: 1 });
    expect(f.statuses).toEqual([]);
  });

  it("runs again headless in lockstep: a run configuration that asked for realtime is run in lockstep, always recorded, for the duration chosen", async () => {
    const f = fakes();
    const first: LabRun = { loaded: { scenarioVersion: 1 } as LabRun["loaded"], header: { label: "demo" } as LabRun["header"], scenario: f1DemoScenario(), runConfig: { ...(f1DemoRunConfig(1) as object), timeMode: "realtime" } };
    await rerunHeadless(f.storage, f.sim, first, { recording: profile, untilS: 45 });
    const sent = f.loads[0] as { runConfig: { timeMode?: string }; headless: { untilS: number }; recording: { mode: string } };
    expect(sent.runConfig.timeMode).toBeUndefined();
    expect(sent.headless).toEqual({ untilS: 45 });
    expect(sent.recording.mode).toBe("stored");
  });
});
