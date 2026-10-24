import { MainToSim, SIM_PROTOCOL_VERSION, validate, type SimToMain } from "@agentsim/core";
import { F2_TWENTY_AGENTS_ID, f2RunConfig, f2TwentyAgentsScenario } from "@agentsim/scenarios";
import { RECORDING_PRESETS, type TraceRecord } from "@agentsim/trace";
import { expect, it } from "vitest";
import { recordResults, summarize } from "../../../../tools/bench/measure.ts";
import { runSimHost, type SimClock, type SimScope } from "./sim-host.ts";

// F3b M4 (ADR-0029, acceptance 5): a headless run against the same run in a live lockstep view, 20 exploring agents, recorded under the default research profile. Both
// run in the sim host on real timers, with the recorder channel played by the bench (nothing acknowledged), and what each posts is copied as postMessage copies it. A live
// lockstep view is paced (8 ticks per 16 ms poll at most) and posts render state; a headless run posts progress only. Report only: headless must be faster, and the state
// hashes at every checkpoint must be the same.

const TICKS = 600; // 60 s of sim time
const SIM_S = TICKS / 10;

const load = (headless: boolean) => ({
  type: "load",
  runId: "run-000007",
  scenario: f2TwentyAgentsScenario(),
  scenarioVersion: 1,
  runConfig: f2RunConfig(F2_TWENTY_AGENTS_ID, 1),
  recording: { mode: "stored", profile: RECORDING_PRESETS["default-research"] },
  ...(headless ? { headless: { untilS: SIM_S } } : {}),
});

interface Host {
  readonly out: SimToMain[];
  readonly send: (m: unknown) => void;
  readonly trace: () => { all(): readonly TraceRecord[] };
  readonly fromStorage: (m: unknown) => void;
  readonly cloneCostMs: () => number;
}

/** The sim host on real timers (the wall time of a worker's own loop), posting to an array; the cost of copying what it posts (postMessage's) is measured in what it posts. */
function start(headless: boolean): Host {
  const clock: SimClock = {
    now: () => performance.now(),
    epochNow: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
  const out: SimToMain[] = [];
  let cloneMs = 0;
  let listener: ((e: MessageEvent<unknown>) => void) | undefined;
  const scope: SimScope = {
    postMessage: (m) => {
      const t0 = performance.now();
      structuredClone(m); // what the sender pays to hand a message over
      cloneMs += performance.now() - t0;
      out.push(m);
    },
    addEventListener: (_t, l) => (listener = l),
  };
  const host = runSimHost(scope, clock, (m) => validate(MainToSim, m));
  const send = (data: unknown) => listener?.({ data } as MessageEvent<unknown>);
  let portListener: ((e: MessageEvent<unknown>) => void) | undefined;
  const port = { postMessage: () => {}, addEventListener: (_t: string, l: (e: MessageEvent<unknown>) => void) => (portListener = l), start: () => {} };
  send({ type: "init", protocolVersion: SIM_PROTOCOL_VERSION, tickRateHz: 10 });
  send({ type: "recorderPort", port });
  send(load(headless));
  portListener?.({ data: { type: "header", runId: "run-000007" } } as MessageEvent<unknown>);
  for (let i = 1; i <= 20; i++) send({ type: "command", op: "explore", agentId: `ugv-${String(i).padStart(3, "0")}`, params: {} });
  return { out, send, trace: host.trace, fromStorage: (m) => portListener?.({ data: m } as MessageEvent<unknown>), cloneCostMs: () => cloneMs };
}

const checkpoints = (h: Host) =>
  h
    .trace()
    .all()
    .filter((r) => (r.payload as { op?: string } | undefined)?.op === "checkpoint")
    .map((r) => ({ tick: (r.payload as { tick: number }).tick, stateHash: (r.payload as { stateHash: string }).stateHash }))
    .filter((c, i, all) => all.findIndex((x) => x.tick === c.tick) === i);

const tickOf = (h: Host): number => {
  for (let i = h.out.length - 1; i >= 0; i--) {
    const m = h.out[i] as SimToMain;
    if (m.type === "progress" || m.type === "state") return (m as { tick: number }).tick;
  }
  return 0;
};

/** Wall time from play to TICKS ticks on real timers. The storage end acknowledges nothing: the recorder's flow control is not what is measured. */
async function run(headless: boolean): Promise<{ ms: number; h: Host }> {
  const h = start(headless);
  // A live lockstep view is paced by its speed: x4 (40 Hz) is the fastest the player offers (x1 would take the 60 s of the run).
  if (!headless) h.send({ type: "control", op: "setTickRate", tickRateHz: 40 });
  const t0 = performance.now();
  h.send({ type: "control", op: "play" });
  while (tickOf(h) < TICKS) await new Promise<void>((r) => setTimeout(r, 2));
  const ms = performance.now() - t0;
  h.send({ type: "control", op: "pause" });
  return { ms, h };
}

it("headless.vsLive: 20 exploring agents, 60 s of sim time, headless against a live lockstep view", async () => {
  await run(true); // warm-up of both paths
  await run(false);
  const head: number[] = [];
  const live: number[] = [];
  let a: Host | undefined;
  let b: Host | undefined;
  for (let i = 0; i < 3; i++) {
    const x = await run(true);
    head.push(x.ms);
    a = x.h;
    const y = await run(false);
    live.push(y.ms);
    b = y.h;
  }
  const liveCheck = checkpoints(b as Host);
  const headCheck = checkpoints(a as Host).filter((c) => liveCheck.some((x) => x.tick === c.tick));
  expect(headCheck.length).toBeGreaterThanOrEqual(5);
  expect(headCheck).toEqual(liveCheck.filter((c) => headCheck.some((x) => x.tick === c.tick))); // the same state at every checkpoint
  const hm = summarize(head);
  const lm = summarize(live);
  console.log(`headless.vsLive: headless median ${hm.median.toFixed(0)} ms, live lockstep at x4 median ${lm.median.toFixed(0)} ms (x1: 60000 ms), ${headCheck.length} checkpoints equal, speed-up ${(lm.median / hm.median).toFixed(2)}x, copy cost of posted messages: headless ${(a as Host).cloneCostMs().toFixed(0)} ms, live ${(b as Host).cloneCostMs().toFixed(0)} ms (last run each)`);
  recordResults("node.json", { "headless.run20Exploring60s": hm, "headless.liveLockstepX4_20Exploring60s": lm });
  expect(hm.median).toBeLessThan(lm.median); // not faster is a stop (acceptance 5)
}, 300_000);
