import { createMemoryPorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildDecisionStory } from "./decision-story.ts";
import { actionWords, continuedOf, decisionExtras, heldKinds, heldOf, taskOfRequest, taskStoryOf, wakeOf } from "./task-story.ts";

// The task list of a mind at one decision, read from the records (F4b M2, T-150): the list as the world held it (`self.task` of the request), how each failed step failed (the `task_step` records), where the list came
// from (the `task` records), what a decision held back and whether it went on with the running action.

const RUN = "run-000001";
let seq = 0;
let t = 0;
const rec = (kind: TraceRecord["kind"], source: string, payload: Record<string, unknown>, extra: Partial<TraceRecord> = {}): TraceRecord => {
  const n = seq++;
  return { id: `${RUN}#${n}`, runId: RUN, seq: n, simTime: extra.simTime ?? t, wallTime: 1, source, kind, agentId: "uav-001", payload, ...extra } as TraceRecord;
};
const id = (r: TraceRecord) => r.id;

async function ports(records: readonly TraceRecord[]) {
  const p = createMemoryPorts();
  const header = { runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "story", status: "running" as const };
  expect((await p.runs.create(header)).ok).toBe(true);
  const r = await p.trace.append(records);
  if (!r.ok) throw new Error(r.error.message);
  return p;
}

const STEPS = [{ text: "take off" }, { text: "inspect P1", action: "goTo", params: { xM: 20, yM: 40 } }, { text: "return to base", action: "returnToBase" }];
const listOf = (statuses: readonly string[], extra: Record<string, unknown> = {}) => ({ steps: STEPS.map((s, i) => ({ ...s, status: statuses[i] ?? "pending", ...(statuses[i] === "pending" || statuses[i] === undefined ? {} : { actionId: `act-00000${i + 1}` }) })), ...extra });

/** Three decisions of a mind: #1 writes the list and takes off; #2 (takeoff done) goes to P1; #3 (a timer, perception events held) goes on with the goTo. */
function run() {
  seq = 0;
  t = 0;
  const req1 = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "start" }], self: { kind: "uav", running: null } });
  const call1 = rec("thought", "uav-001/s2", { op: "llm-call", attempt: 1, messages: [] }, { parentId: id(req1) });
  t = 0.1;
  const dec1 = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "takeoff" }, step: 1, of: 3 }, { causeIds: [id(req1)] });
  const task1 = rec("event", "uav-001/s2", { op: "task", steps: STEPS });
  const start1 = rec("action", "uav-001/actions", { op: "start", name: "takeoff", actionId: "act-000001" }, { causeIds: [id(dec1)] });
  const run1 = rec("event", "uav-001/s2", { op: "task_step", step: 1, of: 3, status: "running", actionId: "act-000001" }, { causeIds: [id(dec1)] });
  t = 10.1;
  const end1 = rec("action", "uav-001/actions", { op: "end", name: "takeoff", actionId: "act-000001", status: "succeeded" });
  const done1 = rec("event", "uav-001/s2", { op: "task_step", step: 1, of: 3, status: "done", actionId: "act-000001" }, { causeIds: [id(end1)] });
  const req2 = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "actionCompleted" }], self: { kind: "uav", running: null, task: listOf(["done"], { last: { step: 1, status: "done", action: "takeoff" } }) } });
  t = 10.2;
  const dec2 = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "goTo" }, step: 2, of: 3 }, { causeIds: [id(req2)] });
  const start2 = rec("action", "uav-001/actions", { op: "start", name: "goTo", actionId: "act-000002" }, { causeIds: [id(dec2)] });
  const run2 = rec("event", "uav-001/s2", { op: "task_step", step: 2, of: 3, status: "running", actionId: "act-000002" }, { causeIds: [id(dec2)] });
  t = 12.2;
  const req3 = rec("thought", "uav-001/s2", {
    op: "request",
    events: [{ kind: "detected" }, { kind: "detected" }, { kind: "lost" }, { kind: "timer" }],
    self: { kind: "uav", running: { actionId: "act-000002", name: "goTo", phase: "following" }, task: listOf(["done", "running"], { running: 2, last: { step: 1, status: "done", action: "takeoff" } }) },
  });
  t = 12.3;
  const dec3 = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" }, step: 2, of: 3, continued: true, actionId: "act-000002", held: 3, mind: { continued: "the answer was continue" } }, { causeIds: [id(req3)] });
  return { all: [req1, call1, dec1, task1, start1, run1, end1, done1, req2, dec2, start2, run2, req3, dec3], req1, dec1, task1, run1, req2, dec2, run2, req3, dec3, done1 };
}

describe("the task list at a decision", () => {
  it("at the first decision the world held no list: it is the one the decision wrote, the step it bound running and named, the others pending", async () => {
    const r = run();
    const p = await ports(r.all);
    const story = await buildDecisionStory(p, RUN, r.dec1.seq);
    expect(story?.taskRecords.written?.seq).toBe(r.task1.seq);
    expect(story?.taskRecords.steps.map((x) => x.seq)).toEqual([r.run1.seq]);
    expect(story?.steps.map((s) => s.kind).slice(-3)).toEqual(["action", "task", "task"]);
    const task = await taskStoryOf(p, RUN, story as NonNullable<typeof story>);
    expect(task?.fromThisDecision).toBe(true);
    expect(task?.source).toMatchObject({ kind: "written", at: 1, byThisDecision: true });
    expect(task?.rows.map((x) => [x.n, x.state, x.glyph, x.named])).toEqual([
      [1, "running", "▶", true],
      [2, "pending", "○", false],
      [3, "pending", "○", false],
    ]);
    expect(task?.counts).toEqual({ total: 3, done: 0, running: 1, failed: 0 });
  });

  it("at a later decision it is the list `self.task` of the request, with the counts, where it came from, the step the decision names and how the last step ended", async () => {
    const r = run();
    const p = await ports(r.all);
    const story = await buildDecisionStory(p, RUN, r.dec2.seq);
    const task = await taskStoryOf(p, RUN, story as NonNullable<typeof story>);
    expect(task?.rows.map((x) => [x.state, x.glyph, x.named])).toEqual([
      ["done", "✓", false],
      ["pending", "○", true],
      ["pending", "○", false],
    ]);
    expect(task?.counts).toEqual({ total: 3, done: 1, running: 0, failed: 0 });
    expect(task?.source).toMatchObject({ kind: "written", at: 1, unchanged: true, byThisDecision: false });
    expect(task?.last?.text).toBe("step 1 ✓ done · takeoff act-000001 · at 10.1 s");
    expect(task?.stopped).toBeUndefined();
    // ◂ ▸ shows the list change: at the third decision step 2 runs.
    const third = await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, r.dec3.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>);
    expect(third?.rows.map((x) => x.state)).toEqual(["done", "running", "pending"]);
    expect(third?.counts).toEqual({ total: 3, done: 1, running: 1, failed: 0 });
  });

  it("a failed step says how: ✕ failed with its code, ▲ preempted, ✕ refused; the list is stopped at it", async () => {
    seq = 0;
    t = 0;
    const list = rec("event", "uav-001/s2", { op: "task", steps: STEPS });
    t = 5;
    const failed = rec("event", "uav-001/s2", { op: "task_step", step: 2, of: 3, status: "failed", outcome: "failed", code: "no_path", actionId: "act-000002" });
    const pre = rec("event", "uav-001/s2", { op: "task_step", step: 1, of: 3, status: "failed", outcome: "preempted", code: "preempted", actionId: "act-000001" });
    const ref = rec("event", "uav-001/s2", { op: "task_step", step: 3, of: 3, status: "failed", outcome: "refused", code: "precondition_failed" });
    const req = rec("thought", "uav-001/s2", {
      op: "request",
      events: [{ kind: "actionFailed" }],
      self: { kind: "uav", running: null, task: { steps: [{ ...STEPS[0], status: "failed", actionId: "act-000001" }, { ...STEPS[1], status: "failed", actionId: "act-000002" }, { ...STEPS[2], status: "failed" }], last: { step: 2, status: "failed", action: "goTo", code: "no_path" } } },
    });
    const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" } }, { causeIds: [id(req)] });
    const p = await ports([list, failed, pre, ref, req, dec]);
    const task = await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, dec.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>);
    expect(task?.rows.map((x) => [x.state, x.glyph, x.code])).toEqual([
      ["preempted", "▲", "preempted"],
      ["failed", "✕", "no_path"],
      ["refused", "✕", "precondition_failed"],
    ]);
    expect(task?.stopped).toBe("list stopped at step 2 of 3");
    expect(task?.last?.text).toContain("step 2 ✕ failed · no_path · goTo");
  });

  it("a rewritten list says at which decision and over how many steps; the decision that writes a new one says so", async () => {
    const r = run();
    seq = r.all.length;
    t = 14;
    const rewrite = rec("event", "uav-001/s2", { op: "task", steps: [{ text: "return to base" }, { text: "finish" }] });
    const req4 = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "actionCompleted" }], self: { kind: "uav", running: null, task: { steps: [{ text: "return to base", status: "pending" }, { text: "finish", status: "pending" }] } } });
    const dec4 = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" } }, { causeIds: [id(req4)] });
    const p = await ports([...r.all, rewrite, req4, dec4]);
    const task = await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, dec4.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>);
    expect(task?.source).toMatchObject({ kind: "rewritten", was: 3, unchanged: true });
    expect(task?.rows).toHaveLength(2);
    // The decision before the rewrite sees it as written by the run's later decision: decision 3 `rewrites` nothing here, but the story of the decision that wrote it carries the record.
    const writer = await buildDecisionStory(p, RUN, r.dec3.seq);
    expect(writer?.taskRecords.written).toBeUndefined();
  });

  it("a decision that replaces a running action names only the step of its own action, not the one it ended by preempting", async () => {
    seq = 0;
    t = 1;
    const list = rec("event", "uav-001/s2", { op: "task", steps: STEPS });
    const req = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "timer" }], self: { kind: "uav", running: { actionId: "act-000001", name: "hold", phase: "holding" }, task: { steps: [{ ...STEPS[0], status: "running", actionId: "act-000001" }, { ...STEPS[1], status: "pending" }, { ...STEPS[2], status: "pending" }], running: 1 } } });
    t = 2;
    const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "goTo" }, step: 2, of: 3 }, { causeIds: [id(req)] });
    const pre = rec("event", "uav-001/s2", { op: "task_step", step: 1, of: 3, status: "failed", outcome: "preempted", code: "preempted", actionId: "act-000001" }, { causeIds: [id(dec)] });
    const run2 = rec("event", "uav-001/s2", { op: "task_step", step: 2, of: 3, status: "running", actionId: "act-000002" }, { causeIds: [id(dec)] });
    const p = await ports([list, req, dec, pre, run2]);
    const story = (await buildDecisionStory(p, RUN, dec.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>;
    expect(story.taskRecords.steps.map((x) => x.seq)).toEqual([pre.seq, run2.seq]);
    const task = await taskStoryOf(p, RUN, story);
    expect(task?.rows.map((r) => [r.n, r.state, r.named])).toEqual([
      [1, "running", false],
      [2, "pending", true],
      [3, "pending", false],
    ]);
  });

  it("\"list stopped\" is only for a failure that nothing has followed: a list that goes on after one shows none (U-025 must 1)", async () => {
    const failedList = (running?: number) => ({ steps: [{ ...STEPS[0], status: "done", actionId: "act-000001" }, { ...STEPS[1], status: "failed", actionId: "act-000002" }, { ...STEPS[2], status: running === 3 ? "running" : "pending", ...(running === 3 ? { actionId: "act-000003" } : {}) }], ...(running === undefined ? {} : { running }), last: { step: 2, status: "failed", action: "goTo", code: "no_path" } });
    for (const [running, stopped] of [[undefined, "list stopped at step 2 of 3"], [3, undefined]] as const) {
      seq = 0;
      t = 0;
      const list = rec("event", "uav-001/s2", { op: "task", steps: STEPS });
      const fail = rec("event", "uav-001/s2", { op: "task_step", step: 2, of: 3, status: "failed", outcome: "failed", code: "no_path", actionId: "act-000002" });
      const req = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "timer" }], self: { kind: "uav", running: null, task: failedList(running) } });
      const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" } }, { causeIds: [id(req)] });
      const p = await ports([list, fail, req, dec]);
      const task = await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, dec.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>);
      expect(task?.stopped, `running ${String(running)}`).toBe(stopped);
    }
  });

  it("a decision that rewrites the list names a step of the list it writes; the old list is kept apart with nothing named (U-025 must 2)", async () => {
    seq = 0;
    t = 1;
    const list = rec("event", "uav-001/s2", { op: "task", steps: STEPS });
    const req = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "actionCompleted" }], self: { kind: "uav", running: null, task: { steps: [{ ...STEPS[0], status: "done", actionId: "act-000001" }, { ...STEPS[1], status: "done", actionId: "act-000002" }, { ...STEPS[2], status: "pending" }], last: { step: 2, status: "done", action: "goTo" } } } });
    t = 2;
    const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "returnToBase" }, step: 1, of: 2 }, { causeIds: [id(req)] });
    const rewrite = rec("event", "uav-001/s2", { op: "task", steps: [{ text: "return to base", action: "returnToBase" }, { text: "finish" }] });
    const running = rec("event", "uav-001/s2", { op: "task_step", step: 1, of: 2, status: "running", actionId: "act-000003" }, { causeIds: [id(dec)] });
    const p = await ports([list, req, dec, rewrite, running]);
    const task = await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, dec.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>);
    expect(task?.source).toMatchObject({ kind: "rewritten", was: 3, byThisDecision: true });
    expect(task?.rows.map((r) => [r.text, r.state, r.named])).toEqual([["return to base", "running", true], ["finish", "pending", false]]);
    expect(task?.counts).toEqual({ total: 2, done: 0, running: 1, failed: 0 });
    expect(task?.before?.rows.map((r) => [r.text, r.state, r.named])).toEqual([["take off", "done", false], ["inspect P1", "done", false], ["return to base", "pending", false]]);
    expect(task?.last).toBeUndefined();
    expect(task?.stopped).toBeUndefined();
  });

  it("a mind with no list at all has no section", async () => {
    seq = 0;
    const req = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "start" }], self: { kind: "uav", running: null } });
    const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" } }, { causeIds: [id(req)] });
    const p = await ports([req, dec]);
    expect(await taskStoryOf(p, RUN, (await buildDecisionStory(p, RUN, dec.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>)).toBeUndefined();
  });

  it("a task list the world refused is shown as the refusal in the lane (the list is unchanged)", async () => {
    seq = 0;
    t = 1;
    const req = rec("thought", "uav-001/s2", { op: "request", events: [{ kind: "start" }], self: { kind: "uav", running: null } });
    const dec = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "idle" } }, { causeIds: [id(req)] });
    const refused = rec("event", "uav-001/actions", { op: "event", event: { kind: "actionRejected", name: "task", code: "task_too_many_steps" } });
    const p = await ports([req, dec, refused]);
    const story = await buildDecisionStory(p, RUN, dec.seq);
    expect(story?.taskRecords.refused?.seq).toBe(refused.seq);
    expect(story?.steps.at(-1)).toMatchObject({ kind: "task" });
    expect(await taskStoryOf(p, RUN, story as NonNullable<typeof story>)).toBeUndefined();
  });
});

describe("what a decision held back and whether it went on", () => {
  it("counts the perception events of the request by kind, and names the control event that asked and the wake policy's effect", async () => {
    const r = run();
    const p = await ports(r.all);
    const story = (await buildDecisionStory(p, RUN, r.dec3.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>;
    expect(heldKinds(r.req3)).toEqual({ total: 3, words: "detected 2 · lost 1" });
    expect(heldOf(story)).toEqual({ n: 3, kinds: "detected 2 · lost 1", trigger: "timer" });
    expect(decisionExtras(r.dec3)).toEqual({ held: 3, continued: true });
    expect(decisionExtras(r.dec2)).toEqual({ held: undefined, continued: false });
    const earlier = (await buildDecisionStory(p, RUN, r.dec2.seq)) as NonNullable<typeof story>;
    expect(heldOf(earlier)).toBeUndefined();
  });

  it("a decision that went on with the running action says which, and why, as the brain wrote it", async () => {
    const r = run();
    const p = await ports(r.all);
    const story = (await buildDecisionStory(p, RUN, r.dec3.seq)) as NonNullable<Awaited<ReturnType<typeof buildDecisionStory>>>;
    expect(continuedOf(story)).toEqual({ actionId: "act-000002", name: "goTo", reason: "the answer was continue" });
    expect(continuedOf((await buildDecisionStory(p, RUN, r.dec2.seq)) as NonNullable<typeof story>)).toBeUndefined();
  });

  it("reads the wake policy from the agent's configuration record (all when it says nothing)", async () => {
    seq = 0;
    const cfg = rec("lifecycle", "uav-001/config", { op: "config", mindS2: { effective: { wake: "task" } } });
    const other = rec("lifecycle", "ugv-001/config", { op: "config", mindS2: { effective: {} } }, { agentId: "ugv-001" });
    const p = await ports([cfg, other]);
    expect(await wakeOf(p, RUN, "uav-001")).toBe("task");
    expect(await wakeOf(p, RUN, "ugv-001")).toBe("all");
  });
});

describe("small readers", () => {
  it("takes the list out of a request record, and nothing from one kept at metadata (its body is a hash)", () => {
    const r = run();
    expect(taskOfRequest(r.req3)?.steps).toHaveLength(3);
    expect(taskOfRequest(r.req1)).toBeUndefined();
    expect(taskOfRequest({ ...r.req3, payload: { op: "request", self: "5f0d33a1" } } as TraceRecord)).toBeUndefined();
  });

  it("writes an action and its parameters in one cut line", () => {
    expect(actionWords("goTo", { xM: 40, yM: 60 })).toBe('goTo {"xM":40,"yM":60}');
    expect(actionWords("returnToBase", {})).toBe("returnToBase");
    expect(actionWords("goTo", { xM: 40.123456789, yM: 60.987654321, altitudeM: 20 }, 24)).toHaveLength(24);
    expect(actionWords("goTo", { xM: 40.123456789, yM: 60.987654321, altitudeM: 20 }, 24).endsWith("…")).toBe(true);
    expect(actionWords(undefined, undefined)).toBe("");
  });
});
