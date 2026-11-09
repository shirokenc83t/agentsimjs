import { runLockstep, type WorldSnapshot } from "@agentsim/core";
import { DEFAULT_PROMPT_TEMPLATE_V2, MemoryMindCache, ScriptedProvider, type MindCache, type ProviderPort, type ScriptedAnswer } from "@agentsim/minds";
import { filterRecord, metadataMindIo, RECORDING_PRESETS, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { MindLibrary } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun } from "../testing/preset-run.ts";

// F4b M1 (T-146): the F4 mission (three points and back to base) flown by an LLM mind of the v2 profile (wake `task`, the `task` tool, the default template v2) on the F2 scene, with a scripted provider (no network, no key,
// no model): the mind writes its task as steps, names the step of each action, and the world marks every step done from the actions' outcomes. The same run twice gives the same hashes, and `replay-strict` makes no call.

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
type Run = ReturnType<typeof buildPresetRun>;

const ok = (obj: unknown): ScriptedAnswer => ({ content: JSON.stringify(obj), usage: { inputTokens: 300, outputTokens: 30 }, latencyMs: 30 });

const STEPS = [
  { text: "take off to 20 m", action: "takeoff", params: { altitudeM: 20 } },
  { text: "inspect P1", action: "goTo", params: { xM: 20, yM: 40 } },
  { text: "inspect P2", action: "goTo", params: { xM: 40, yM: 60 } },
  { text: "inspect P3", action: "goTo", params: { xM: 58, yM: 20 } },
  { text: "return to base and land", action: "returnToBase" },
];
const MISSION = [
  { action: "takeoff", params: { altitudeM: 20 }, task: { steps: STEPS }, step: 1, rationale: "write the plan, then take off" },
  { action: "goTo", params: { xM: 20, yM: 40 }, step: 2 },
  { action: "goTo", params: { xM: 40, yM: 60 }, step: 3 },
  { action: "goTo", params: { xM: 58, yM: 20 }, step: 4 },
  { action: "returnToBase", params: {}, step: 5 },
];

/**
 * The next scripted answer when the request carries an event that ends an action or starts the mind (the mission advances), `continue` for any other request while an action runs, idle otherwise. Under the
 * wake policy `task` the mind is not asked at the others while an action runs, so those answers are rarely used.
 */
function mission(): ScriptedProvider {
  let n = 0;
  return new ScriptedProvider((req) => {
    const text = req.messages[1]?.content ?? "";
    if (/"kind":"(start|actionCompleted|actionFailed|actionRejected)"/.test(text)) return n < MISSION.length ? ok(MISSION[n++]) : ok({ action: "idle" });
    return /"running":\{/.test(text) ? ok({ action: "continue" }) : ok({ action: "idle" });
  });
}

const PROFILE = {
  schemaVersion: 1,
  kind: "mind-profile",
  shape: "s2",
  s2: { provider: "local", model: "test-model", promptTemplate: { id: "default", version: 2 }, wake: "task", tools: { allow: ["takeoff", "goTo", "returnToBase", "land", "hold", "task"] }, limits: { calls: 200, tokens: 1_000_000 } },
};
const library = (): MindLibrary => ({ profile: () => PROFILE as never, template: () => DEFAULT_PROMPT_TEMPLATE_V2 });
const config = (mode?: string): Partial<RunConfigDocument> =>
  ({ ...(mode === undefined ? {} : { mindsRunMode: mode }), minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 2 }, mission: "Inspect P1 (20, 40), P2 (40, 60) and P3 (58, 20), then return to base and land." } } } } }) as unknown as Partial<RunConfigDocument>;

function build(o: { mode?: string; provider: ProviderPort; cache: MindCache }): Run {
  return buildPresetRun({
    preset: "f2-discovery",
    scripts: {},
    runConfig: config(o.mode),
    resolve: { library: library(), providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434" }) },
    minds: { providers: () => o.provider, cache: o.cache, now: () => 0 },
  });
}

// `returnToBase` lands the vehicle: the mission is over when it ends, and the mind is asked once more (the last step done) before the run is read.
const home = (run: Run) => run.trace.all().some((r) => r.kind === "action" && payloadOf(r).op === "end" && payloadOf(r).name === "returnToBase" && r.agentId === "uav-001");
async function fly(run: Run, maxTicks = 12_000): Promise<void> {
  for (let t = 0; t < maxTicks && !home(run); t++) await runLockstep(run.world, run.scheduler, 1);
  if (home(run)) await runLockstep(run.world, run.scheduler, 3);
}
/** Runs a world up to a tick (a replay is run to the tick of the run it replays). */
async function flyTo(run: Run, tick: number): Promise<void> {
  while (run.world.tick < tick) await runLockstep(run.world, run.scheduler, 1);
}
const sameTrace = (run: Run) =>
  run.trace.all().map((r) => {
    const p = payloadOf(r);
    if (p.op !== "llm-call") return { ...r, wallTime: 0 };
    const { cacheHit: _hit, ...rest } = p;
    return { ...r, wallTime: 0, payload: rest };
  });
const taskOf = (run: Run) => (run.world.snapshot() as WorldSnapshot).tasks?.find((t) => t !== null) ?? undefined;

describe("the F4 mission with the v2 profile, a task list and a scripted provider (T-146)", () => {
  it("completes with every step done, each marked by the world from its action's outcome, the mind asked once per step", async () => {
    const provider = mission();
    const run = build({ provider, cache: new MemoryMindCache() });
    await fly(run);
    expect(home(run)).toBe(true);
    const list = taskOf(run);
    expect(list?.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(list?.last).toMatchObject({ step: 5, status: "done", action: "returnToBase" });
    expect(run.trace.all().filter((r) => r.kind === "action" && payloadOf(r).op === "start" && r.agentId === "uav-001").map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "goTo", "goTo", "returnToBase"]);
    // Records: the list once, then each step running and done, the done ones caused by the action's end record.
    const mine = run.trace.all().filter((r) => r.agentId === "uav-001" && r.kind === "event");
    expect(mine.filter((r) => payloadOf(r).op === "task")).toHaveLength(1);
    const stepRecs = mine.filter((r) => payloadOf(r).op === "task_step");
    expect(stepRecs.map((r) => `${String(payloadOf(r).step)}:${String(payloadOf(r).status)}`)).toEqual(["1:running", "1:done", "2:running", "2:done", "3:running", "3:done", "4:running", "4:done", "5:running", "5:done"]);
    for (const r of stepRecs.filter((x) => payloadOf(x).status === "done")) {
      const cause = run.trace.all().find((c) => c.id === r.causeIds?.[0]);
      expect(payloadOf(cause as TraceRecord)).toMatchObject({ op: "end", status: "succeeded" });
    }
    // The mind was asked at each control event and not at the perception events that came while it flew: no more calls than steps, and the decisions say how many perception events rode along.
    expect(provider.calls).toBe(6);
    const decisions = run.trace.all().filter((r) => r.agentId === "uav-001" && payloadOf(r).op === "decision");
    expect(decisions).toHaveLength(6);
    expect(decisions.map((r) => payloadOf(r).step)).toEqual([1, 2, 3, 4, 5, 5]);
    expect(payloadOf(decisions[5] as TraceRecord)).toMatchObject({ step: 5, of: 5, done: true });
    // The perception events of the flight (a vehicle seen or lost) did not ask: they rode along with the control event that did, and the record counts them.
    expect(decisions.reduce((n, r) => n + (typeof payloadOf(r).held === "number" ? (payloadOf(r).held as number) : 0), 0)).toBeGreaterThan(0);
  });

  it("the prompt of each decision carries the task slot with the statuses, the step running and the last outcome", async () => {
    const provider = mission();
    const run = build({ provider, cache: new MemoryMindCache() });
    await fly(run);
    const prompts = provider.requests.map((r) => r.messages[1]?.content ?? "");
    expect(prompts[0]).toContain('## Your task list\n(no list yet: write one with "task", then name the step of each action with "step")');
    expect(prompts[2]).toContain("## Your task list\n1. [done] take off to 20 m (takeoff {\"altitudeM\":20})\n2. [done] inspect P1 (goTo {\"xM\":20,\"yM\":40})\n3. [pending] inspect P2");
    expect(prompts[2]).toContain("Last step outcome: step 2 done (goTo).");
    // The task comes after the mission and before the beliefs and the events; the list is not repeated in the state slot.
    const at = (h: string) => (prompts[2] as string).indexOf(`## ${h}`);
    expect([at("Your mission"), at("Your task list"), at("What you believe"), at("What just happened"), at("What you can do")].every((x, i, a) => x >= 0 && (i === 0 || x > (a[i - 1] as number)))).toBe(true);
    expect(prompts[2]).not.toContain('"task":{');
    // `continue` is offered while an action runs: these requests were asked for the end of one, when nothing runs.
    expect(prompts[2]).not.toContain("- continue");
  });

  it("the same run twice gives the same hashes, and `replay-strict` from its cache makes no call and reproduces the trace", async () => {
    const cache = new MemoryMindCache();
    const a = build({ provider: mission(), cache });
    await fly(a);
    const b = build({ provider: mission(), cache: new MemoryMindCache() });
    await fly(b);
    expect(b.world.tick).toBe(a.world.tick);
    expect(b.world.stateHash).toBe(a.world.stateHash);
    const none = new ScriptedProvider([]);
    const replay = build({ mode: "replay-strict", provider: none, cache });
    await flyTo(replay, a.world.tick);
    expect(none.calls).toBe(0);
    expect(replay.world.stateHash).toBe(a.world.stateHash);
    expect(sameTrace(replay)).toEqual(sameTrace(a));
    expect(taskOf(replay)?.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
  });
});

describe("mind-io with the task slot (T-146)", () => {
  it("at `full` the model call keeps the prompt with the task slot and the answer with the list; at `metadata` the messages and the answer are their hashes, the task records are kept as events", async () => {
    const run = build({ provider: mission(), cache: new MemoryMindCache() });
    await fly(run);
    const calls = run.trace.all().filter((r) => payloadOf(r).op === "llm-call");
    expect(calls).toHaveLength(6);
    const first = calls[0] as TraceRecord;
    expect(JSON.stringify(payloadOf(first).messages)).toContain("## Your task list");
    expect(JSON.stringify(payloadOf(first).response)).toContain("take off to 20 m");
    const full = filterRecord(RECORDING_PRESETS["default-research"], first);
    expect(JSON.stringify(payloadOf(full as TraceRecord).messages)).toContain("## Your task list");
    const meta = metadataMindIo(first);
    expect(payloadOf(meta).messages).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(payloadOf(meta).response).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(JSON.stringify(payloadOf(meta))).not.toContain("Your task list");
    // The task records are events: any recording keeps them, whatever the level of mind-io.
    const minimal = run.trace.all().filter((r) => payloadOf(r).op === "task" || payloadOf(r).op === "task_step").flatMap((r) => filterRecord(RECORDING_PRESETS.minimal, r) ?? []);
    expect(minimal.filter((r) => payloadOf(r).op === "task_step")).toHaveLength(10);
  });
});

describe("continue instead of restart, through the world (T-145, T-146)", () => {
  it("a timer wakes the mind mid-flight and it answers the same goTo: the action is not started again (same id, no restart), the step stays running, the record says continued", async () => {
    let n = 0;
    const provider = new ScriptedProvider((req) => {
      const text = req.messages[1]?.content ?? "";
      if (/"kind":"timer"/.test(text)) return ok({ action: "goTo", params: { yM: 40, xM: 20 }, step: 2, rationale: "still going" });
      if (/"kind":"(start|actionCompleted|actionFailed|actionRejected)"/.test(text)) {
        const next = MISSION[n++] as Record<string, unknown> | undefined;
        // The first goTo sets a timer that wakes the mind two seconds into the flight.
        return next === undefined ? ok({ action: "idle" }) : ok(n === 2 ? { ...next, timers: [{ op: "set", tag: "look", delayS: 2 }] } : next);
      }
      return /"running":\{/.test(text) ? ok({ action: "continue" }) : ok({ action: "idle" });
    });
    const run = build({ provider, cache: new MemoryMindCache() });
    await fly(run);
    expect(home(run)).toBe(true);
    const goTos = run.trace.all().filter((r) => r.kind === "action" && payloadOf(r).op === "start" && payloadOf(r).name === "goTo" && r.agentId === "uav-001");
    expect(goTos.map((r) => payloadOf(r).params)).toEqual([{ xM: 20, yM: 40 }, { xM: 40, yM: 60 }, { xM: 58, yM: 20 }]);
    const decisions = run.trace.all().filter((r) => r.agentId === "uav-001" && payloadOf(r).op === "decision");
    const continued = decisions.filter((r) => payloadOf(r).continued === true);
    expect(continued).toHaveLength(1);
    expect(payloadOf(continued[0] as TraceRecord)).toMatchObject({ decision: { kind: "idle" }, actionId: payloadOf(goTos[0] as TraceRecord).actionId, step: 2, mind: { continued: "the answer was the action that runs, with the same parameters" } });
    expect(taskOf(run)?.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    // The prompt of the wake-up offered `continue` and showed step 2 running.
    const wake = provider.requests.map((r) => r.messages[1]?.content ?? "").find((x) => /"kind":"timer"/.test(x)) as string;
    expect(wake).toContain("- continue: keep doing what you are doing");
    expect(wake).toContain("2. [running] inspect P1");
    expect(wake).toContain("Step running now: 2 — goTo (act-000002), phase following.");
  });
});
