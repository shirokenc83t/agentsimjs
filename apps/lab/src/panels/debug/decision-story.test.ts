import { createMemoryPorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildDecisionStory, callSays, callTokens, notebookAt, promptSections, requestOf } from "./decision-story.ts";

// The story of a decision of a System 2 mind, read from the records' own links (F4 M4, T-123): the chain request → model call → compute call → model call → decision → action, a decision with retries and a
// fallback, the limit records, and the pieces of a model call (prompt sections, tokens, what it says).

const RUN = "run-000001";
let seq = 0;
const rec = (kind: TraceRecord["kind"], source: string, payload: Record<string, unknown>, extra: Partial<TraceRecord> = {}): TraceRecord => {
  const n = seq++;
  return { id: `${RUN}#${n}`, runId: RUN, seq: n, simTime: n * 0.1, wallTime: 1, source, kind, agentId: "uav-001", payload, ...extra } as TraceRecord;
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

/** A looped decision: request, call 1 (asks for two tools), the tools, call 2 (the answer), decision, action start; another decision before and after it. */
function looped() {
  seq = 0;
  const before = rec("thought", "uav-001/s2", { op: "decision" });
  const request = rec("thought", "uav-001/s2", { op: "request", self: { notebook: "visit P1, P2" } });
  const call1 = rec("thought", "uav-001/s2", { op: "llm-call", attempt: 1, usage: { inputTokens: 2702, outputTokens: 61 }, outcome: "ok", latencyMs: 1600, response: { toolCalls: [{ name: "estimateCost" }, { name: "planPath" }] }, messages: [] }, { parentId: id(request) });
  const t1 = rec("compute", "uav-001/s2", { op: "tool", tool: "estimateCost", ok: true, status: "found", expansions: 12 }, { parentId: id(call1) });
  const t2 = rec("compute", "uav-001/s2", { op: "tool", tool: "planPath", ok: true, status: "found", expansions: 212 }, { parentId: id(call1) });
  const warn = rec("thought", "uav-001/s2", { op: "limit-warning", limit: "tokens", pct: 82 }, { parentId: id(request) });
  const call2 = rec("thought", "uav-001/s2", { op: "llm-call", attempt: 1, usage: { inputTokens: 2860, outputTokens: 95 }, outcome: "ok", latencyMs: 1700, response: { content: '{"action":"goTo","params":{"xM":50,"yM":20},"rationale":"P2 is cheaper"}' } }, { parentId: id(request) });
  const decision = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "goTo" } }, { causeIds: [id(request)] });
  const start = rec("action", "uav-001/actions", { op: "start", name: "goTo" }, { causeIds: [id(decision)] });
  const after = rec("thought", "uav-001/s2", { op: "decision" });
  return { all: [before, request, call1, t1, t2, warn, call2, decision, start, after], before, request, call1, t1, t2, warn, call2, decision, start, after };
}

describe("the story of a decision", () => {
  it("has every record of the chain in order: request, the call that asked for tools, the tools, the limit warning, the answering call, the decision and the action it started", async () => {
    const r = looped();
    const p = await ports(r.all);
    const story = await buildDecisionStory(p, RUN, r.decision.seq);
    expect(story?.request.seq).toBe(r.request.seq);
    expect(story?.calls.map((c) => c.record.seq)).toEqual([r.call1.seq, r.call2.seq]);
    expect(story?.calls[0]?.tools.map((t) => t.seq)).toEqual([r.t1.seq, r.t2.seq]);
    expect(story?.decision?.seq).toBe(r.decision.seq);
    expect(story?.action?.seq).toBe(r.start.seq);
    expect(story?.steps.map((s) => [s.kind, s.record.seq])).toEqual([
      ["request", r.request.seq],
      ["call", r.call1.seq],
      ["tool", r.t1.seq],
      ["tool", r.t2.seq],
      ["limit", r.warn.seq],
      ["call", r.call2.seq],
      ["answer", r.decision.seq],
      ["action", r.start.seq],
    ]);
    expect(story?.decisions).toEqual([r.before.seq, r.decision.seq, r.after.seq]);
  });

  it("is the same story from any record of it: the request, a call, a compute call, a limit record or the decision", async () => {
    const r = looped();
    const p = await ports(r.all);
    const from = async (x: TraceRecord) => (await buildDecisionStory(p, RUN, x.seq))?.request.seq;
    for (const x of [r.request, r.call1, r.t2, r.warn, r.call2, r.decision]) expect(await from(x), `from #${x.seq}`).toBe(r.request.seq);
    expect(await from(r.start)).toBeUndefined(); // an action is not a record of the mind: its decision is, one click away
    expect(await buildDecisionStory(p, RUN, 9999)).toBeUndefined();
    expect((await requestOf(p, RUN, r.t1))?.seq).toBe(r.request.seq);
  });

  it("a decision with retries and a fallback: the invalid call carries its mark, then the fallback, then the decision with no action of the mind's choosing", async () => {
    seq = 0;
    const request = rec("thought", "uav-001/s2", { op: "request" });
    const bad = rec("thought", "uav-001/s2", { op: "llm-call", attempt: 1, outcome: "invalid", validationError: "args.x missing", response: { content: "{}" } }, { parentId: id(request) });
    const retry = rec("thought", "uav-001/s2", { op: "llm-call", attempt: 2, outcome: "timeout", response: { error: "no answer in 60 s" } }, { parentId: id(request) });
    const fb = rec("thought", "uav-001/s2", { op: "fallback", reason: "no answer in 60 s", decision: "hold" }, { parentId: id(request), causeIds: [id(retry)] });
    const decision = rec("thought", "uav-001/s2", { op: "decision", decision: { kind: "action", name: "hold" }, mind: { fallback: "no answer in 60 s" } }, { causeIds: [id(request)] });
    const story = await buildDecisionStory(await ports([request, bad, retry, fb, decision]), RUN, request.seq);
    expect(story?.steps.map((s) => s.kind)).toEqual(["request", "call", "invalid", "call", "fallback", "answer"]);
    expect(story?.fallback?.seq).toBe(fb.seq);
    expect(story?.action).toBeUndefined();
  });

  it("a hit of the limit and a miss of the cache are in the lane too", async () => {
    seq = 0;
    const request = rec("thought", "uav-001/s2", { op: "request" });
    const miss = rec("thought", "uav-001/s2", { op: "cache-miss", attempt: 1 }, { parentId: id(request) });
    const hit = rec("thought", "uav-001/s2", { op: "limit-hit", limit: "calls", used: 20, max: 20 }, { parentId: id(request) });
    const story = await buildDecisionStory(await ports([request, miss, hit]), RUN, request.seq);
    // Written in the order of their records: the miss came first.
    expect(story?.steps.map((s) => s.kind)).toEqual(["request", "cache", "limit"]);
  });
});

describe("the pieces of a model call", () => {
  it("splits a prompt into its sections with their size (characters / 4), keeps the system text and the tool exchanges as sections of their own", () => {
    const messages = [
      { role: "system", content: "You are a mind." },
      { role: "user", content: "## Who you are\nuav-001\n\n## Your notebook\nvisit P1" },
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "planPath", params: {} }] },
      { role: "tool", toolCallId: "c", name: "planPath", content: '{"status":"found"}' },
    ];
    const s = promptSections(messages);
    expect(s.map((x) => x.title)).toEqual(["system", "Who you are", "Your notebook", "assistant · tool calls", "tool result · planPath"]);
    expect(s[2]).toMatchObject({ text: "visit P1", tokens: Math.ceil("## Your notebook\nvisit P1".length / 4) });
    expect(promptSections(undefined)).toEqual([]);
  });

  it("reads the notebook, the tokens and what the call said from the records", () => {
    const r = looped();
    expect(notebookAt(r.request)).toBe("visit P1, P2");
    expect(callTokens(r.call1)).toEqual({ input: 2702, output: 61 });
    expect(callSays(r.call1)).toBe("asks for estimateCost, planPath");
    expect(callSays(r.call2)).toBe("P2 is cheaper");
    expect(callSays(rec("thought", "x/s2", { op: "llm-call", response: { error: "http_error 503" } }))).toBe("http_error 503");
  });
});
