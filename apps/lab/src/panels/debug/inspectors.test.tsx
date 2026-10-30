import { createMemoryPorts, type StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useUiContext } from "@agentsim/ui";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppActionsProvider, ServicesProvider } from "../../services.tsx";
import type { RunSnapshot, RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { ComputeInspectorPanel } from "./compute-inspector-panel.tsx";
import { LlmInspectorPanel } from "./llm-inspector-panel.tsx";

// The LLM inspector and the Compute inspector on a recorded looped decision (F4 M4, T-123): every record of the chain in order, the sections of a prompt, a run kept at `mind-io: metadata`, and a compute call
// drawn on the agent's belief, with how much of the route lies over what it has not seen.

const RUN = "run-000003";
let seq = 0;
const ref = (n: number) => `${RUN}#${n}`;
const rec = (kind: TraceRecord["kind"], payload: Record<string, unknown>, extra: Partial<TraceRecord> = {}): TraceRecord => {
  const n = seq++;
  return { id: ref(n), runId: RUN, seq: n, simTime: n * 0.1, wallTime: 1, source: "uav-001/s2", kind, agentId: "uav-001", payload, ...extra } as TraceRecord;
};

const PROMPT = [
  { role: "system", content: "You are a mind." },
  { role: "user", content: "## Who you are\nuav-001\n\n## Your notebook\nvisit P1, P2\n\n## What you can do\ngoTo, hold" },
];

/** A decision with a loop: the request, the call that asks for two tools, the tools, the answering call, the decision and the action. `metadata` hashes what that level hashes. */
function run(metadata = false) {
  seq = 0;
  const request = rec("thought", { op: "request", tick: 12, events: [{ kind: "start" }], self: metadata ? "9f8e7d6c5b4a3921" : { xM: 0.5, yM: 0.5, notebook: "visit P1, P2" } });
  const call1 = rec("thought", { op: "llm-call", attempt: 1, model: "fake-7b", providerKind: "openai-compatible", outcome: "ok", latencyMs: 1600, usage: { inputTokens: 2702, outputTokens: 61 }, messages: metadata ? "aaaaaaaaaaaaaaaa" : PROMPT, response: metadata ? "bbbbbbbbbbbbbbbb" : { toolCalls: [{ name: "estimateCost" }, { name: "planPath" }] } }, { parentId: ref(request.seq) });
  const t1 = rec("compute", { op: "tool", tool: "estimateCost", ok: true, status: "found", expansions: 12, params: { route: ["home"] }, result: { status: "found", lengthM: 30, etaS: 15, energyPct: 1, legs: [{ lengthM: 30, etaS: 15, status: "found" }] } }, { parentId: ref(call1.seq) });
  const t2 = rec("compute", { op: "tool", tool: "planPath", ok: true, status: "found", expansions: 212, params: { to: { xM: 7.5, yM: 0.5 } }, result: { status: "found", lengthM: 7, etaS: 3.5, energyPct: 0.2, expansions: 212, waypoints: [{ xM: 0.5, yM: 0.5 }, { xM: 7.5, yM: 0.5 }] } }, { parentId: ref(call1.seq) });
  const call2 = rec("thought", { op: "llm-call", attempt: 1, model: "fake-7b", outcome: "ok", latencyMs: 1700, usage: { inputTokens: 2860, outputTokens: 95 }, messages: metadata ? "cccccccccccccccc" : PROMPT, response: metadata ? "dddddddddddddddd" : { content: '{"action":"goTo","params":{"xM":7.5,"yM":0.5},"rationale":"P2 is cheaper"}' } }, { parentId: ref(request.seq) });
  const decision = rec("thought", { op: "decision", decision: { kind: "action", name: "goTo", params: { xM: 7.5, yM: 0.5 } } }, { causeIds: [ref(request.seq)] });
  const start = rec("action", { op: "start", name: "goTo" }, { source: "uav-001/actions", causeIds: [ref(decision.seq)] });
  return { all: [request, call1, t1, t2, call2, decision, start], request, call1, t1, t2, call2, decision };
}

/** An 8 x 8 map of 1 m cells: the west half free, the east half never seen. */
const BELIEF = { ok: true as const, value: { sizeX: 8, sizeY: 8, chunkSize: 4, coords: Uint16Array.from([0, 0, 0, 1, 1, 0, 1, 1]), data: Uint8Array.from([...new Uint8Array(16).fill(1), ...new Uint8Array(16).fill(1), ...new Uint8Array(32)]) } };

async function mount(records: TraceRecord[], panel: "llm" | "compute", belief: unknown = BELIEF) {
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "completed" });
  const appended = await ports.trace.append(records);
  if (!appended.ok) throw new Error(appended.error.message);
  const view = { runId: RUN, entityIds: ["uav-001"], run: { dtS: 0.1 }, persistedHeadTick: 100, simHeadTick: 100, mode: "replay", grid: { dims: { resolutionM: 1 } } } as unknown as RunSnapshot;
  const source = { mode: "replay", snapshot: () => view } as unknown as RunSource;
  const storage = { ports, status: () => ({ state: "ready", mode: "memory-fallback" }), onStatus: () => () => {}, replay: { beliefAt: () => Promise.resolve(belief), world: () => Promise.resolve({ ok: false }) } } as unknown as StorageClient;
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source, setReplaySource: () => {} }}>
      <AppActionsProvider value={{ resetLayouts: () => {}, setTheme: () => {}, openWorkspace: () => {}, openReplay: () => {}, resimulateWindow: () => {}, backToDebug: () => {}, openPanel: () => {} }}>
        {panel === "llm" ? <LlmInspectorPanel /> : <ComputeInspectorPanel />}
      </AppActionsProvider>
    </ServicesProvider>,
  );
}
const pick = (n: number) => act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: n }));

afterEach(() => act(() => useUiContext.getState().selectRecord(undefined)));

describe("the LLM inspector", () => {
  it("asks for a record first, and says when the record is not part of a decision of a mind", async () => {
    const r = run();
    await mount([...r.all, rec("event", { op: "event" }, { source: "uav-001/actions" })], "llm");
    expect(screen.getByTestId("llm-empty")).toBeInTheDocument();
    pick(7);
    await waitFor(() => expect(screen.getByTestId("llm-not-a-mind")).toBeInTheDocument());
  });

  it("shows the request, each model call with what it said, the compute calls it asked for, the answer and the action, in the order they happened, from any record of the decision", async () => {
    const r = run();
    await mount(r.all, "llm");
    pick(r.t2.seq);
    await waitFor(() => expect(screen.getByTestId("llm-lane")).toBeInTheDocument());
    const lane = screen.getByTestId("llm-lane");
    expect([...lane.querySelectorAll("li")].map((li) => li.getAttribute("data-kind"))).toEqual(["request", "call", "tool", "tool", "call", "answer", "action"]);
    expect(lane).toHaveTextContent("asks for estimateCost, planPath");
    expect(lane).toHaveTextContent("P2 is cheaper");
    expect(lane).toHaveTextContent("tool · planPath · found · 212 exp");
    expect(screen.getByTestId("llm-title")).toHaveTextContent("decision #1");
    expect(screen.getByTestId("llm-tiles")).toHaveTextContent("fake-7b");
    expect(screen.getByTestId("llm-tiles")).toHaveTextContent("2 model calls · 2 tool calls");
    expect(screen.getByTestId("llm-action")).toHaveTextContent("goTo");
  });

  it("opens a model call with its prompt by section and the size of each, and the answer, the notebook and the raw record", async () => {
    const r = run();
    await mount(r.all, "llm");
    pick(r.decision.seq);
    await waitFor(() => expect(screen.getByTestId("llm-lane")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`llm-step-${r.call1.seq}`));
    expect(screen.getByTestId("llm-section-0")).toHaveTextContent("system");
    expect(screen.getByTestId("llm-section-2")).toHaveTextContent("Your notebook");
    await user.click(screen.getByTestId("llm-section-2"));
    expect(screen.getByTestId("llm-section-text")).toHaveTextContent("visit P1, P2");
    await user.click(screen.getByTestId("llm-tab-answer"));
    expect(screen.getByTestId("llm-answer-text")).toHaveTextContent("estimateCost");
    await user.click(screen.getByTestId("llm-tab-notebook"));
    expect(screen.getByTestId("llm-notebook")).toHaveTextContent("visit P1, P2");
    await user.click(screen.getByTestId("llm-tab-raw JSON"));
    expect(screen.getByTestId("llm-raw")).toHaveTextContent('"op": "llm-call"');
  });

  it("a run kept at mind-io metadata shows what it has (the sizes, the outcome, the hashes) and says what full would add", async () => {
    const r = run(true);
    await mount(r.all, "llm");
    pick(r.decision.seq);
    await waitFor(() => expect(screen.getByTestId("llm-lane")).toBeInTheDocument());
    const user = userEvent.setup();
    expect(screen.getByTestId("llm-lane")).toHaveTextContent(/2.702 → 61 tok/);
    await user.click(screen.getByTestId(`llm-step-${r.call1.seq}`));
    expect(screen.getByTestId("llm-metadata-note")).toHaveTextContent("kept `mind-io` at `metadata`");
    expect(screen.getByTestId("llm-metadata-note")).toHaveTextContent("aaaaaaaaaaaaaaaa");
    expect(screen.getByTestId("llm-metadata-note")).toHaveTextContent("At `full` the sections would be here");
    await user.click(screen.getByTestId("llm-tab-answer"));
    expect(screen.getByTestId("llm-answer-text")).toHaveTextContent("bbbbbbbbbbbbbbbb");
    await user.click(screen.getByTestId("llm-tab-notebook"));
    expect(screen.getByTestId("llm-notebook")).toHaveTextContent("kept as a hash");
  });

  it("goes from a decision to the one before and after it for the same agent", async () => {
    const r = run();
    const extra = rec("thought", { op: "decision" });
    await mount([...r.all, extra], "llm");
    pick(r.decision.seq);
    await waitFor(() => expect(screen.getByTestId("llm-title")).toHaveTextContent("decision #1"));
    expect(screen.getByTestId("llm-next")).toBeEnabled();
    expect(screen.getByTestId("llm-prev")).toBeDisabled();
  });
});

describe("the Compute inspector", () => {
  it("shows the call in words and draws its route on the agent's belief: the route the belief agent planned straight through the east it has not seen says so", async () => {
    const r = run();
    await mount(r.all, "compute");
    expect(screen.getByTestId("compute-empty")).toBeInTheDocument();
    pick(r.t2.seq);
    await waitFor(() => expect(screen.getByTestId("compute-title")).toHaveTextContent("planPath"));
    expect(screen.getByTestId("compute-result")).toHaveTextContent("2 waypoints · 7.0 m");
    expect(screen.getByTestId("compute-params")).toHaveTextContent('"to"');
    expect(screen.getByTestId("compute-map")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("compute-belief-note")).toHaveTextContent("lie over cells it has not seen"));
    expect(screen.getByTestId("compute-belief-note")).toHaveTextContent("own belief at tick 12");
    expect(screen.getByTestId("compute-belief-note")).toHaveTextContent("never the truth");
    const user = userEvent.setup();
    expect(screen.getByTestId("compute-prev")).toHaveTextContent("estimateCost");
    await user.click(screen.getByTestId("compute-to-call"));
  });

  it("says so when the run recorded no belief map, and draws the route alone", async () => {
    const r = run();
    await mount(r.all, "compute", { ok: false, error: { code: "not_recorded" } });
    pick(r.t2.seq);
    await waitFor(() => expect(screen.getByTestId("compute-belief-note")).toHaveTextContent("not recorded"));
  });

  it("says that a record that is not a compute call is not one", async () => {
    const r = run();
    await mount(r.all, "compute");
    pick(r.decision.seq);
    await waitFor(() => expect(screen.getByTestId("compute-not-a-tool")).toBeInTheDocument());
  });
});
