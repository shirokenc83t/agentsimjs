import type { TraceRecord } from "@agentsim/trace";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeadlessMonitorView, type MonitorViewProps } from "./headless-monitor-view.tsx";
import type { Progress } from "./monitor-model.ts";

// The monitor is a function of the worker's progress message (its own wall clock is in it): the same message gives the same numbers, whatever the clock of the page says.

const progress = (over: Partial<Progress> = {}): Progress => ({
  type: "progress",
  runId: "run-000003",
  headless: true,
  running: true,
  done: false,
  tick: 1200,
  simTimeS: 120,
  untilS: 300,
  wallMs: 2500,
  ticksPerSecond: 480,
  simSecondsPerSecond: 48,
  tickTimeMeanMs: 1.25,
  tickTimeP95Ms: 2.5,
  waiting: "none",
  recordsHandedOver: 5400,
  backlogRecords: 12,
  backlogBytes: 4096,
  snapshotTicks: [0, 600, 1200],
  ...over,
});

const NO_END = { untilS: undefined } as unknown as Partial<Progress>; // a message without its end condition

const rec = (seq: number, kind: string, op: string): TraceRecord => ({ id: `run-000003#${seq}`, runId: "run-000003", seq, simTime: seq / 10, wallTime: 1, agentId: "ugv-001", source: "ugv-001/actions", kind, payload: { op } }) as TraceRecord;

function view(over: Partial<MonitorViewProps> = {}, p: Progress | undefined = progress()) {
  const actions = { pause: vi.fn(), play: vi.fn(), stop: vi.fn(), openDebug: vi.fn(), openAnalysis: vi.fn() };
  const props: MonitorViewProps = {
    progress: p,
    dtS: 0.1,
    run: { runId: "run-000003", label: "F1 demo", profileName: "default-research", profileHash: "19cfa400" },
    storedBytes: 600_000,
    stream: { rows: [rec(1, "action", "start"), rec(2, "action", "end")], totalMatched: 1500, totalShown: 900, sampled: true },
    sparks: [
      { name: "sim.tickMs", title: "tick cost", unit: "ms", points: [{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 2, v: 1.5 }] },
      { name: "storage.backlogRecords", title: "writer backlog", unit: "records", points: [] },
    ],
    writer: { state: "ok", backlogRecords: 12 },
    actions,
    ...over,
  };
  render(<HeadlessMonitorView {...props} />);
  return actions;
}

describe("the headless run monitor", () => {
  it("shows where the run is, how fast it goes against real time, its cost and the ETA, all from the progress message", () => {
    view();
    expect(screen.getByTestId("hm-state")).toHaveTextContent("running");
    expect(screen.getByTestId("hm-ticks")).toHaveTextContent("tick 1 200 / 3 000"); // the end condition in ticks
    expect(screen.getByTestId("hm-simtime")).toHaveTextContent("sim 2 min 00 s / 5 min 00 s");
    expect(screen.getByTestId("hm-wall")).toHaveTextContent("wall 2.5 s");
    expect(screen.getByTestId("hm-speed")).toHaveTextContent("×48 real time");
    expect(screen.getByTestId("hm-tps")).toHaveTextContent("480");
    expect(screen.getByTestId("hm-tickcost")).toHaveTextContent("1.25 ms mean · 2.50 p95");
    expect(screen.getByTestId("hm-eta")).toHaveTextContent("ETA 3.8 s"); // 180 sim s left at 48 sim s per wall s
    expect(screen.getByTestId("hm-progress")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getAllByTestId("hm-mark")).toHaveLength(3);
    expect(screen.getByTestId("hm-snapshots")).toHaveTextContent("3 snapshots");
  });

  it("says what the run waits for: nothing, a mind, the writer (wall time only), the quota", () => {
    for (const [w, text] of [["none", "not waiting for anything"], ["decision", "mind"], ["storage_backpressure", "nothing is lost"], ["storage_quota", "quota"]] as const) {
      const { unmount } = render(<HeadlessMonitorView {...({ progress: progress({ waiting: w }), dtS: 0.1, run: { runId: "run-000003", label: "x", profileName: undefined, profileHash: undefined }, storedBytes: undefined, stream: { rows: [], totalMatched: 0, totalShown: 0, sampled: false }, sparks: [], writer: undefined, actions: { pause() {}, play() {}, stop() {}, openDebug() {}, openAnalysis: undefined } } satisfies MonitorViewProps)} />);
      expect(screen.getByTestId("hm-waiting")).toHaveTextContent(text);
      unmount();
    }
  });

  it("names the recording profile with its hash, what is stored with an estimate of the volume, and the writer's state with its backlog", () => {
    view({ writer: { state: "storage_backpressure", backlogRecords: 70_000 } });
    expect(screen.getByTestId("hm-profile")).toHaveTextContent("profile default-research · 19cfa400");
    expect(screen.getByTestId("hm-written")).toHaveTextContent("5 400 records handed over");
    // 600 kB in 120 sim s: 5 kB a sim second, 18 MB an hour, 1.5 MB at 300 s.
    expect(screen.getByTestId("hm-volume").textContent).toMatch(/stored .* · ≈ .* per sim hour · ≈ .* at its end/);
    expect(screen.getByTestId("hm-writer")).toHaveAttribute("data-state", "storage_backpressure");
    expect(screen.getByTestId("hm-writer")).toHaveTextContent("behind: the run waits for it");
    expect(screen.getByTestId("hm-writer")).toHaveTextContent("backlog 12 records · 4.0 KB");
  });

  it("states the sampling of its event stream and lists the latest rows; the sparklines have their points, and one without says so", () => {
    view();
    expect(screen.getByTestId("hm-stream-note")).toHaveTextContent("sampled");
    expect(screen.getByTestId("hm-stream-note")).toHaveTextContent("900 of 1 500 matching records shown");
    expect(screen.getByTestId("hm-stream-note")).toHaveTextContent("the recording is not sampled");
    expect(screen.getByTestId("hm-stream").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("hm-spark-sim.tickMs")).toHaveAttribute("data-points", "3");
    expect(screen.getByTestId("hm-spark-sim.tickMs")).toHaveTextContent("1.5 ms");
    expect(screen.getByTestId("hm-spark-storage.backlogRecords")).toHaveTextContent("no samples yet");
  });

  it("pauses, resumes and stops a running run; a paused one offers to resume; a finished one offers neither and opens in Analysis", () => {
    const a = view();
    fireEvent.click(screen.getByTestId("hm-pause"));
    fireEvent.click(screen.getByTestId("hm-stop"));
    fireEvent.click(screen.getByTestId("hm-open-debug"));
    expect(a.pause).toHaveBeenCalledOnce();
    expect(a.stop).toHaveBeenCalledOnce();
    expect(a.openDebug).toHaveBeenCalledOnce();
    expect(screen.getByTestId("hm-open-analysis")).toBeDisabled(); // not before it is done
  });

  it("a paused run offers Resume, and a finished one is done, shows 100 %, no ETA, and opens in Analysis", () => {
    const paused = view({}, progress({ running: false }));
    expect(screen.getByTestId("hm-state")).toHaveTextContent("paused");
    fireEvent.click(screen.getByTestId("hm-play"));
    expect(paused.play).toHaveBeenCalledOnce();
  });

  it("a finished run is done at 100 % with no ETA, a stopped one says so, and Open in Analysis works once it is done", () => {
    const a = view({}, progress({ done: true, running: false, tick: 3000, simTimeS: 300, simSecondsPerSecond: 0, ticksPerSecond: 0 }));
    expect(screen.getByTestId("hm-state")).toHaveTextContent("done");
    expect(screen.getByTestId("hm-progress")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByTestId("hm-eta")).toHaveTextContent("ended");
    expect(screen.queryByTestId("hm-pause")).toBeNull();
    expect(screen.queryByTestId("hm-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("hm-open-analysis"));
    expect(a.openAnalysis).toHaveBeenCalledOnce();
  });

  it("a finished run shows the average speed of the whole run, and says it is an average", () => {
    view({}, progress({ done: true, running: false, tick: 3000, simTimeS: 300, wallMs: 2500, simSecondsPerSecond: 0, ticksPerSecond: 0 }));
    expect(screen.getByTestId("hm-speed")).toHaveTextContent("×120 real time");
    expect(screen.getByTestId("hm-tps")).toHaveTextContent("1 200");
    expect(screen.getByText(/SPEED · AVERAGE/)).toBeInTheDocument();
  });

  it("a run stopped before its end says stopped, not done, and a run switched to the live view says so", () => {
    view({}, progress({ done: true, running: false, simTimeS: 120 }));
    expect(screen.getByTestId("hm-state")).toHaveTextContent("stopped");
  });

  it("without a headless run it says how to start one, and without an end condition the bar is open and the ETA says why there is none", () => {
    const { unmount } = render(<HeadlessMonitorView {...({ progress: undefined, dtS: 0.1, run: undefined, storedBytes: undefined, stream: { rows: [], totalMatched: 0, totalShown: 0, sampled: false }, sparks: [], writer: undefined, actions: { pause() {}, play() {}, stop() {}, openDebug() {}, openAnalysis: undefined } } satisfies MonitorViewProps)} />);
    expect(screen.getByTestId("hm-empty")).toHaveTextContent("Run headless");
    unmount();
    view({}, progress(NO_END));
    expect(screen.getByTestId("hm-eta")).toHaveTextContent("no end condition");
    expect(screen.getByTestId("hm-progress")).not.toHaveAttribute("aria-valuenow");
  });

  it("a finished run says how it ended (not what it waits for) and its writer flushes then has stored everything", () => {
    view({ writer: { state: "ok", backlogRecords: 1874 } }, progress({ running: false, done: true, tick: 3000, simTimeS: 300, backlogRecords: 1874 }));
    expect(screen.queryByTestId("hm-waiting")).toBeNull();
    expect(screen.getByTestId("hm-ended")).toHaveTextContent("✓ ended · tick 3 000 · end condition: sim time 5 min 00 s reached");
    expect(screen.getByTestId("hm-writer")).toHaveTextContent("flushing · 1 874 records left");
    expect(screen.getByTestId("hm-writer")).not.toHaveTextContent("keeping up");
    expect(screen.getByTestId("hm-writer")).toHaveAttribute("data-flushed", "false");
  });

  it("a finished run whose writer has nothing left is flushed: all the records it handed over are stored", () => {
    view({ writer: { state: "ok", backlogRecords: 0 } }, progress({ running: false, done: true, tick: 3000, simTimeS: 300, backlogRecords: 0 }));
    expect(screen.getByTestId("hm-writer")).toHaveTextContent("✓ flushed · all 5 400 records stored");
    expect(screen.getByTestId("hm-writer")).toHaveAttribute("data-flushed", "true");
  });

  it("a run stopped before its end condition says so, and one that never had one says it was stopped", () => {
    view({}, progress({ running: false, done: true, tick: 1200, simTimeS: 120 }));
    expect(screen.getByTestId("hm-ended")).toHaveTextContent("▲ stopped · tick 1 200 · before its end condition (sim time 5 min 00 s)");
  });
});
