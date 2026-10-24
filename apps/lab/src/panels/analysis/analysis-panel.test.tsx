import { createMemoryPorts, type StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useUiContext } from "@agentsim/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActionsProvider, ServicesProvider } from "../../services.tsx";
import type { RunSnapshot, RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { AnalysisPanel } from "./analysis-panel.tsx";

// The Analysis workspace as a whole (ADR-0029): a recorded run read from storage, the filter as the one state that the chips, the prompt and the window write, and what each
// view shows of it. The drawing is the canvas's (its model is checked by attributes); the geometry and the files are the model's tests.

const RUN = "run-000001";
const pose = (seq: number, agentId: string, t: number, x: number, y: number): TraceRecord =>
  ({ id: `${RUN}#${seq}`, runId: RUN, seq, simTime: t, wallTime: 1, agentId, source: `${agentId}/body`, kind: "observation", payload: { op: "pose", x, y, z: 0, speedMps: 1, soc: 0.9 } }) as TraceRecord;
const act1 = (seq: number, agentId: string, t: number, payload: Record<string, unknown>): TraceRecord => ({ id: `${RUN}#${seq}`, runId: RUN, seq, simTime: t, wallTime: 1, agentId, source: `${agentId}/actions`, kind: "action", payload }) as TraceRecord;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    useUiContext.getState().setTimeSelection(undefined);
    useUiContext.getState().setSimTime(0);
  });
});

async function setup(): Promise<{ openReplay: ReturnType<typeof vi.fn> }> {
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "completed" });
  const records: TraceRecord[] = [
    pose(1, "ugv-001", 0, 10, 10),
    pose(2, "ugv-001", 10, 50, 10),
    pose(3, "ugv-001", 20, 50, 50),
    pose(4, "uav-001", 0, 20, 20),
    pose(5, "uav-001", 20, 80, 80),
    act1(6, "ugv-001", 1, { op: "start", name: "goTo" }),
    act1(7, "ugv-001", 12, { op: "end", status: "failed", failure: { code: "unreachable" } }),
    act1(8, "uav-001", 15, { op: "end", status: "succeeded" }),
    { ...act1(9, "uav-001", 16, {}), kind: "reflex", source: "uav-001/reflexes", payload: { reflex: "obstacle", code: "obstacle_ahead" } } as TraceRecord,
  ];
  // A run's records are in sim-time order (seq order is time order, ADR-0031): the sequence numbers follow the time.
  const ordered = [...records].sort((x, y) => x.simTime - y.simTime || x.seq - y.seq).map((r, i) => ({ ...r, seq: i, id: `${RUN}#${i}` }));
  const added = await ports.trace.append(ordered);
  expect(added.ok).toBe(true);
  await ports.metrics.append(RUN, [
    { source: "ugv-001/body", name: "agent.soc", tick: 0, simTime: 0, value: 0.9 },
    { source: "ugv-001/body", name: "agent.soc", tick: 200, simTime: 20, value: 0.7 },
    { source: "ugv-001/body", name: "agent.speedMps", tick: 100, simTime: 10, value: 1.5 },
  ]);
  const view = { runId: RUN, entityIds: ["uav-001", "ugv-001"], run: { dtS: 0.1 }, persistedHeadTick: 200, simHeadTick: 200, mode: "replay", grid: undefined } as unknown as RunSnapshot;
  const source = { mode: "replay", snapshot: () => view, cellAt: () => undefined } as unknown as RunSource;
  const storage = { ports, status: () => ({ state: "ready", mode: "memory-fallback" }), onStatus: () => () => {} } as unknown as StorageClient;
  const openReplay = vi.fn();
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source, setReplaySource: () => {} }}>
      <AppActionsProvider value={{ resetLayouts: () => {}, setTheme: () => {}, openWorkspace: () => {}, openReplay, resimulateWindow: () => {}, backToDebug: () => {} }}>
        <AnalysisPanel />
      </AppActionsProvider>
    </ServicesProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("analysis")).toHaveAttribute("data-status", "ready"));
  return { openReplay };
}

const canvas = () => screen.getByTestId("map2d-canvas");

describe("the Analysis workspace", () => {
  it("shows the trajectories and the events of the recorded run, a lane per agent, and the series with what they are made of", async () => {
    await setup();
    expect(canvas()).toHaveAttribute("data-trajectories", "2");
    expect(canvas()).toHaveAttribute("data-markers", "4"); // a start, a failed end, a succeeded end, a reflex
    expect(screen.getByTestId("an-count")).toHaveTextContent("2/2 agents · 4 events");
    expect(screen.getByTestId("series-battery")).toHaveTextContent("recorded metric agent.soc");
    expect(screen.getByTestId("series-speed")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-timeline")).toBeInTheDocument();
  });

  it("an agent chip writes the filter, and the typed filter is the same state: the map, the events and the series follow", async () => {
    await setup();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("an-agent-ugv-001"));
    expect(screen.getByTestId("an-filter")).toHaveValue("agent:uav-001"); // ugv-001 hidden: the choices shown are uav-001
    expect(canvas()).toHaveAttribute("data-trajectories", "1");
    expect(screen.getByTestId("an-count")).toHaveTextContent("1/2 agents · 2 events");
    expect(screen.queryByTestId("series-battery")).toBeNull(); // the battery is the rover's here
    await user.clear(screen.getByTestId("an-filter"));
    await user.type(screen.getByTestId("an-filter"), "agent:ugv-001 kind:action");
    expect(canvas()).toHaveAttribute("data-trajectories", "1");
    expect(canvas()).toHaveAttribute("data-markers", "2"); // its start and its end (no reflex of the other agent)
    expect(screen.getByTestId("series-battery")).toBeInTheDocument();
    await user.click(screen.getByTestId("an-kind-action")); // a click on a kind written in the text as a lone choice: shows all again
    expect(screen.getByTestId("an-filter").getAttribute("value")).not.toContain("kind:action");
  });

  it("a window in the filter is the shared selection, the series are cut to it, and clearing it clears it everywhere; a window selected elsewhere is written into the filter", async () => {
    await setup();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("an-filter"), "t:9..18");
    expect(useUiContext.getState().timeSelection).toEqual({ t0S: 9, t1S: 18 });
    expect(screen.getByTestId("an-clear-window")).toHaveTextContent("window 9.0–18.0 s");
    expect(canvas()).toHaveAttribute("data-markers", "3"); // the failed end (12 s), the success (15 s) and the reflex (16 s): the start (1 s) is before the window
    await user.click(screen.getByTestId("an-clear-window"));
    expect(useUiContext.getState().timeSelection).toBeUndefined();
    expect(screen.getByTestId("an-filter")).toHaveValue("");
    // A window brushed on another timeline (the Debug workspace's) is the filter's `t:` term here.
    act(() => useUiContext.getState().setTimeSelection({ t0S: 2.5, t1S: 7.5 }));
    await waitFor(() => expect(screen.getByTestId("an-filter")).toHaveValue("t:2.5..7.5"));
  });

  it("a filter that does not parse says so and does not change what is drawn; one that selects metrics is refused with the reason", async () => {
    await setup();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("an-filter"), "kind:action AND");
    expect(screen.getByTestId("an-error")).toHaveTextContent("✕");
    expect(canvas()).toHaveAttribute("data-trajectories", "2");
    await user.clear(screen.getByTestId("an-filter"));
    await user.type(screen.getByTestId("an-filter"), "metric:agent.soc");
    expect(screen.getByTestId("an-error")).toHaveTextContent("selects samples");
  });

  it("a pick on the map moves the shared cursor and, for an event, the shared record", async () => {
    await setup();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("map2d-agent-uav-001"));
    expect(useUiContext.getState().selection).toEqual({ kind: "agent", id: "uav-001" });
  });

  it("says no filter while the prompt is empty, and its example is an example", async () => {
    await setup();
    const user = userEvent.setup();
    expect(screen.getByTestId("an-count")).toHaveTextContent("no filter · 2/2 agents");
    expect(screen.getByTestId("an-filter")).toHaveAttribute("placeholder", expect.stringMatching(/^e\.g\. /));
    await user.type(screen.getByTestId("an-filter"), "agent:ugv-001");
    expect(screen.getByTestId("an-count")).not.toHaveTextContent("no filter");
  });

  it("the markers chip is on by default and turns the events on the paths off and on", async () => {
    await setup();
    const user = userEvent.setup();
    expect(screen.getByTestId("an-markers")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("an-markers"));
    expect(screen.getByTestId("an-markers")).toHaveAttribute("aria-pressed", "false");
    expect(canvas()).toHaveAttribute("data-trajectories", "2"); // the paths stay
    await user.click(screen.getByTestId("an-markers"));
    expect(screen.getByTestId("an-markers")).toHaveAttribute("aria-pressed", "true");
  });

  it("the series label where each line ends (stacked where they end together), put the battery on a 0 to 1 axis, and dim the lines of the agents that are not selected", async () => {
    await setup();
    expect(screen.getByTestId("series-end-battery-ugv-001")).toBeInTheDocument();
    expect(within(screen.getByTestId("series-battery")).getAllByText("0")).not.toHaveLength(0); // the axis starts at 0, not at the lowest sample
    expect(within(screen.getByTestId("series-battery")).getAllByText("1")).not.toHaveLength(0);
    // A chart with one value (the rover's one speed sample) writes it once, in the middle, not as two neighbouring end labels.
    expect(screen.getByTestId("series-flat-speed")).toHaveTextContent("1.5");
    act(() => useUiContext.getState().select({ kind: "agent", id: "ugv-001" }));
    const lines = screen.getByTestId("series-battery").querySelectorAll("polyline.line");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.classList.contains("sel")).toBe(l.getAttribute("data-agent") === "ugv-001");
    act(() => useUiContext.getState().select(undefined));
  });
});
