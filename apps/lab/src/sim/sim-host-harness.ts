import { MainToSim, SIM_PROTOCOL_VERSION, validate, type SimToMain } from "@agentsim/core";
import { F2_DISCOVERY_ID, f1DemoRunConfig, f1DemoScenario, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { RECORDING_PRESETS, type RecorderBatch, type TraceRecord } from "@agentsim/trace";
import { runSimHost, type SimHostOptions, type SimClock, type SimScope } from "./sim-host.ts";

// Shared by the sim host's recording tests: a fake clock, scope and recorder port (the storage worker's end is played by the test).

/** Fake clock, scope and recorder port: time moves by hand, messages are collected, the storage end is played by the test. */
export function harness(options?: SimHostOptions) {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: SimClock = {
    now: () => t,
    epochNow: () => 1_700_000_000_000 + t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      timers = timers.filter((x) => x.id !== h);
    },
  };
  const out: SimToMain[] = [];
  let listener: ((e: MessageEvent<unknown>) => void) | undefined;
  const scope: SimScope = { postMessage: (m) => out.push(m), addEventListener: (_t, l) => (listener = l) };
  const host = runSimHost(scope, clock, (m) => validate(MainToSim, m), options);
  const send = (data: unknown) => listener?.({ data } as MessageEvent<unknown>);
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = Math.max(t, next.at);
      next.fn();
    }
    t = end;
  };
  // The sim worker's end of the recorder channel.
  const toStorage: { type: string; batch?: RecorderBatch }[] = [];
  let portListener: ((e: MessageEvent<unknown>) => void) | undefined;
  const port = {
    postMessage: (m: { type: string; batch?: RecorderBatch }) => void toStorage.push(m),
    addEventListener: (_t: string, l: (e: MessageEvent<unknown>) => void) => (portListener = l),
    start: () => {},
  };
  const fromStorage = (m: unknown) => portListener?.({ data: m } as MessageEvent<unknown>);
  const batches = () => toStorage.filter((m) => m.type === "batch").map((m) => m.batch as RecorderBatch);
  const states = () => out.filter((m): m is Extract<SimToMain, { type: "state" }> => m.type === "state");
  const events = () => out.filter((m): m is Extract<SimToMain, { type: "events" }> => m.type === "events").flatMap((m) => m.records as TraceRecord[]);
  const errors = () => out.filter((m): m is Extract<SimToMain, { type: "error" }> => m.type === "error");
  return { send, advance, out, states, events, errors, port, fromStorage, batches, toStorage, trace: host.trace };
}

export const demo = (recording?: unknown, runId = "run-000007") => ({
  type: "load",
  runId,
  scenario: f1DemoScenario(),
  scenarioVersion: 1,
  runConfig: f1DemoRunConfig(1),
  ...(recording === undefined ? {} : { recording }),
});
/** The F2 discovery scenario (unknown maps, agents that explore): belief maps to record. */
export const discovery = (recording?: unknown, runId = "run-000007") => ({
  type: "load",
  runId,
  scenario: f2DiscoveryScenario(),
  scenarioVersion: 1,
  runConfig: f2RunConfig(F2_DISCOVERY_ID, 1),
  ...(recording === undefined ? {} : { recording }),
});
export const stored = (name: keyof typeof RECORDING_PRESETS = "default-research") => ({ mode: "stored", profile: RECORDING_PRESETS[name] });
export const init = (h: Harness) => h.send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));


export type Harness = ReturnType<typeof harness>;
