import { parseFilter, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { agentsShown, boundsOf, buildMapSvg, computeSeriesOf, csvOfSeries, filterRecords, jsonlOfRecords, mapTransform, markersOf, metricSeriesOf, pointsInWindow, poseOfRecord, positionAt, seriesInWindow, stackedLabelYs, thinMarkers, trajectoriesOf, valueAtTime, windowOfFilter, type MapModel, type MapPalette } from "./analysis-model.ts";

const pose = (seq: number, agentId: string, t: number, x: number, y: number, extra: Record<string, unknown> = {}): TraceRecord =>
  ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: t, wallTime: 1, agentId, source: `${agentId}/body`, kind: "observation", payload: { op: "pose", x, y, z: 0, speedMps: 1, soc: 0.9, ...extra } }) as TraceRecord;
const action = (seq: number, agentId: string, t: number, payload: Record<string, unknown>): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: t, wallTime: 1, agentId, source: `${agentId}/actions`, kind: "action", payload }) as TraceRecord;
const ast = (text: string) => {
  const r = parseFilter(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const records = [
  pose(1, "ugv-001", 0, 0, 0),
  pose(2, "ugv-001", 10, 10, 0),
  pose(3, "ugv-001", 20, 10, 10),
  pose(4, "uav-001", 0, 5, 5),
  pose(5, "uav-001", 20, 5, 25),
  pose(6, "ugv-001", 5, 5, 0), // out of order in storage: trajectories sort by time
];

describe("trajectories from pose samples", () => {
  it("reads only the pose samples of the body: one trajectory per agent, in time order, whatever the order stored", () => {
    expect(poseOfRecord(action(7, "ugv-001", 1, { op: "start" }))).toBeUndefined();
    expect(poseOfRecord({ ...pose(8, "ugv-001", 1, 1, 1), kind: "event" } as TraceRecord)).toBeUndefined();
    expect(poseOfRecord(pose(9, "ugv-001", 1, 2, 3, { z: 4, speedMps: 2 }))).toMatchObject({ t: 1, x: 2, y: 3, z: 4, speedMps: 2 });
    const trs = trajectoriesOf([...records, action(7, "ugv-001", 1, { op: "start" })]);
    expect([...trs.keys()]).toEqual(["uav-001", "ugv-001"]);
    expect(trs.get("ugv-001")?.samples.map((s) => s.t)).toEqual([0, 5, 10, 20]);
  });

  it("interpolates a position between samples, clamps outside them, and gives nothing for an agent with no sample", () => {
    const tr = trajectoriesOf(records).get("ugv-001");
    if (!tr) throw new Error("no trajectory");
    expect(positionAt(tr, 7.5)).toEqual({ x: 7.5, y: 0 });
    expect(positionAt(tr, 15)).toEqual({ x: 10, y: 5 });
    expect(positionAt(tr, -3)).toEqual({ x: 0, y: 0 });
    expect(positionAt(tr, 99)).toEqual({ x: 10, y: 10 });
    expect(positionAt({ agentId: "x", samples: [] }, 1)).toBeUndefined();
  });

  it("cuts a window where it is, with its ends interpolated, and has nothing for a window outside the run", () => {
    const tr = trajectoriesOf(records).get("ugv-001");
    if (!tr) throw new Error("no trajectory");
    expect(pointsInWindow(tr, 7.5, 15).map((p) => [p.x, p.y])).toEqual([[7.5, 0], [10, 0], [10, 5]]);
    expect(pointsInWindow(tr, 100, 200)).toEqual([]);
    expect(pointsInWindow(tr, -10, 0.0)).toHaveLength(1); // touches the first sample: a point
    expect(boundsOf(trajectoriesOf(records).values())).toEqual({ x0: 0, y0: 0, x1: 10, y1: 25 });
    expect(boundsOf([])).toBeUndefined();
  });
});

describe("the filter is the window, the agents and the events (one AST)", () => {
  it("reads the sim-time window and the agents a filter selects", () => {
    expect(windowOfFilter(ast("kind:action"))).toBeUndefined();
    expect(windowOfFilter(ast("t:9..18 agent:ugv-001"))).toEqual({ t0: 9, t1: 18 });
    expect(windowOfFilter(ast("-t:9..18"))).toBeUndefined();
    const all = ["uav-001", "ugv-001", "ugv-002"];
    expect(agentsShown(ast(""), all)).toEqual(all);
    expect(agentsShown(ast("agent:ugv-001,ugv-002"), all)).toEqual(["ugv-001", "ugv-002"]);
    expect(agentsShown(ast("-agent:ugv-001"), all)).toEqual(["uav-001", "ugv-002"]);
    expect(agentsShown(ast("agent:ugv-001 -agent:ugv-001"), all)).toEqual([]);
  });

  it("selects the events of the window, the agents and the kinds with the one language", () => {
    const events = [
      action(10, "ugv-001", 1, { op: "start", name: "goTo" }),
      action(11, "ugv-001", 12, { op: "end", status: "failed", failure: { code: "unreachable" } }),
      action(12, "uav-001", 14, { op: "end", status: "succeeded" }),
      action(13, "ugv-001", 15, { op: "phase" }),
    ];
    expect(filterRecords(events, ast("t:10..20")).map((r) => r.seq)).toEqual([11, 12, 13]);
    expect(filterRecords(events, ast("t:10..20 agent:ugv-001")).map((r) => r.seq)).toEqual([11, 13]);
    expect(filterRecords(events, ast("kind:reflex"))).toEqual([]);
  });
});

describe("markers: events on the map", () => {
  it("places the start, the end and the failure of an action where the agent was, with the glyph of its kind and the flag in its role; its phases are not events of the map", () => {
    const trs = trajectoriesOf(records);
    const events = [
      action(10, "ugv-001", 5, { op: "start", name: "goTo" }),
      action(11, "ugv-001", 15, { op: "end", status: "failed", failure: { code: "unreachable" } }),
      action(12, "ugv-001", 16, { op: "phase", from: "a", to: "b" }),
      { ...action(13, "uav-001", 10, {}), kind: "reflex", source: "uav-001/reflexes", payload: { reflex: "obstacle", code: "obstacle_ahead" } } as TraceRecord,
      { ...action(14, "ghost-001", 10, { op: "start" }) } as TraceRecord, // no trajectory: no place
      { ...action(15, "ugv-001", 10, {}), kind: "snapshot", payload: { op: "snapshot" } } as TraceRecord,
    ];
    const m = markersOf(events, trs);
    expect(m.map((x) => x.seq)).toEqual([10, 11, 13]);
    expect(m[0]).toMatchObject({ glyph: "▪", role: undefined, x: 5, y: 0 });
    expect(m[1]).toMatchObject({ glyph: "✕", role: "alarm", x: 10, y: 5 });
    expect(m[1]?.label).toContain("unreachable");
    expect(m[2]).toMatchObject({ glyph: "▲", role: "warning", x: 5, y: 15 });
  });
});

describe("series: metrics, and compute records where there is no metric", () => {
  it("builds battery and speed series from recorded metrics, one per agent and metric, in tick order", () => {
    const s = metricSeriesOf([
      { source: "ugv-001/body", name: "agent.soc", simTime: 2, tick: 20, value: 0.8 },
      { source: "ugv-001/body", name: "agent.soc", simTime: 1, tick: 10, value: 0.9 },
      { source: "ugv-001/body", name: "agent.speedMps", simTime: 1, tick: 10, value: 2 },
      { source: "world/sim", name: "sim.tickMs", simTime: 1, tick: 10, value: 1 },
      { source: "uav-001/body", name: "agent.soc", simTime: 1, tick: 10, value: 0.7 },
    ]);
    expect(s.map((x) => [x.agentId, x.name, x.source])).toEqual([["uav-001", "battery", "metric"], ["ugv-001", "battery", "metric"], ["ugv-001", "speed", "metric"]]);
    expect(s[1]?.points).toEqual([{ t: 1, v: 0.9 }, { t: 2, v: 0.8 }]);
  });

  it("builds expansions and planning latency from the plan records of the planner", () => {
    const plan = (seq: number, agentId: string, t: number, e: number, a: number, b: number) =>
      ({ ...action(seq, agentId, t, { op: "plan", expansionsCharged: e, submittedTick: a, completedTick: b }), kind: "compute", source: `${agentId}/planner` }) as TraceRecord;
    const s = computeSeriesOf([plan(20, "ugv-001", 1, 120, 10, 14), plan(21, "ugv-001", 3, 80, 25, 26), action(22, "ugv-001", 2, { op: "plan" })]);
    expect(s.map((x) => [x.name, x.source, x.unit])).toEqual([["planner expansions", "compute", "per query"], ["planning latency", "compute", "ticks"]]);
    expect(s[0]?.points).toEqual([{ t: 1, v: 120 }, { t: 3, v: 80 }]);
    expect(s[1]?.points).toEqual([{ t: 1, v: 4 }, { t: 3, v: 1 }]);
  });

  it("keeps the series of the agents shown, inside the window", () => {
    const all = [...metricSeriesOf([{ source: "ugv-001/body", name: "agent.soc", simTime: 1, tick: 10, value: 0.9 }, { source: "ugv-001/body", name: "agent.soc", simTime: 9, tick: 90, value: 0.5 }, { source: "uav-001/body", name: "agent.soc", simTime: 1, tick: 10, value: 0.7 }])];
    expect(seriesInWindow(all, new Set(["ugv-001"]), undefined)).toHaveLength(1);
    expect(seriesInWindow(all, new Set(["ugv-001"]), { t0: 5, t1: 20 })[0]?.points).toEqual([{ t: 9, v: 0.5 }]);
    expect(seriesInWindow(all, new Set(["ugv-001"]), { t0: 50, t1: 60 })).toEqual([]);
  });
});

describe("exports", () => {
  it("writes the series as CSV with a header, CRLF lines and quoting where a cell needs it", () => {
    const csv = csvOfSeries([{ key: "k", agentId: "ugv,001", name: 'say "hi"', unit: "m/s", source: "metric", points: [{ t: 1.5, v: 2 }, { t: 2, v: 3.25 }] }]);
    expect(csv).toBe('agent,series,source,unit,t_s,value\r\n"ugv,001","say ""hi""",metric,m/s,1.5,2\r\n"ugv,001","say ""hi""",metric,m/s,2,3.25\r\n');
    expect(csvOfSeries([])).toBe("agent,series,source,unit,t_s,value\r\n");
  });

  it("writes the records as JSON lines, in order, nothing for none", () => {
    const lines = jsonlOfRecords(records.slice(0, 2)).split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 1 });
    expect(lines[2]).toBe("");
    expect(jsonlOfRecords([])).toBe("");
  });

  const model: MapModel = {
    widthM: 100,
    heightM: 50,
    blocked: { cols: 4, rows: 2, cellM: 25, cells: Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1]) },
    trajectories: [{ agentId: "ugv-001", colorIndex: 1, points: [{ x: 0, y: 0 }, { x: 50, y: 25 }] }, { agentId: "short", colorIndex: 0, points: [{ x: 1, y: 1 }] }],
    positions: [{ agentId: "ugv-001", colorIndex: 1, x: 50, y: 25 }],
    markers: [{ seq: 3, t: 1, agentId: "ugv-001", kind: "action", glyph: "✕", role: "alarm", x: 50, y: 25, label: 'a <b> & "c"' }],
  };
  const palette: MapPalette = { background: "#000", obstacle: "#444", text: "#fff", alarm: "#f00", warning: "#fa0", agent: ["#0f0", "#00f"] };

  it("draws the map as a well-formed SVG: a document, the obstacles as runs of cells, the trajectories (not a one-point one), the positions and the events with their text escaped", () => {
    const svg = buildMapSvg(model, palette, 400);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const root = doc.documentElement;
    expect(root.getAttribute("viewBox")).toBe("0 0 400 200");
    expect(doc.querySelectorAll("g[fill='#444'] > rect")).toHaveLength(2); // a run of two cells in row 0, one in row 1
    expect(doc.querySelectorAll("polyline")).toHaveLength(1);
    expect(doc.querySelector("polyline")?.getAttribute("stroke")).toBe("#00f");
    expect(doc.querySelectorAll("circle")).toHaveLength(1);
    expect(doc.querySelector("text")?.textContent).toContain("✕");
    expect(doc.querySelector("text title")?.textContent).toBe('a <b> & "c"');
    // North is up: the point (50, 25) is the middle of the picture, (0, 0) its bottom left.
    expect(doc.querySelector("circle")?.getAttribute("cy")).toBe("100.00");
    expect(doc.querySelector("polyline")?.getAttribute("points")?.startsWith("0.00,200.00")).toBe(true);
  });

  it("fits the world in the view, centred, with y up", () => {
    const t = mapTransform({ widthM: 100, heightM: 50 }, 224, 124, 12);
    expect(t.scale).toBe(2);
    expect(t.px(0)).toBe(12);
    expect(t.px(100)).toBe(212);
    expect(t.py(0)).toBe(112);
    expect(t.py(50)).toBe(12);
  });
});

describe("the markers drawn on a dense map", () => {
  const mk = (seq: number, x: number, y: number, role?: "alarm" | "warning", kind = "action") => ({ seq, t: seq, agentId: "ugv-001", kind, glyph: role === "alarm" ? "✕" : role === "warning" ? "▲" : "▪", role, x, y, label: `m${seq}` });
  const id = (v: number) => v;

  it("are all kept while the plain ones are few, and above the limit thinned per pixel bin and kind, the flags never", () => {
    const few = Array.from({ length: 50 }, (_, i) => mk(i, i * 0.1, 0));
    expect(thinMarkers(few, id, id, 400)).toBe(few);
    // 1,000 plain marks on the same two pixels (one kind) and 5 flags among them.
    const dense = [...Array.from({ length: 1000 }, (_, i) => mk(i, (i % 2) * 8, 0)), mk(2000, 0, 0, "alarm"), mk(2001, 0, 0, "alarm"), mk(2002, 3, 0, "warning"), mk(2003, 3, 0, "warning"), mk(2004, 4, 0, "warning")];
    const out = thinMarkers(dense, id, id, 400);
    expect(out.filter((m) => m.role !== undefined)).toHaveLength(5); // never thinned
    expect(out.filter((m) => m.role === undefined)).toHaveLength(2); // one per bin of 6 px and kind
    // Another kind in the same bin is another mark.
    const two = [...Array.from({ length: 500 }, (_, i) => mk(i, 0, 0)), mk(900, 0, 0, undefined, "reflex")];
    expect(thinMarkers(two, id, id, 400).map((m) => m.kind).sort()).toEqual(["action", "reflex"]);
  });
});

describe("the labels at the right end of a chart", () => {
  it("are where the lines end when they are apart, stacked at least a gap apart where lines end together, and never leave the chart", () => {
    expect(stackedLabelYs([10, 40, 70], 11, 5, 90)).toEqual([10, 40, 70]);
    const together = stackedLabelYs([30, 30, 30], 11, 5, 90);
    expect(together).toEqual([30, 41, 52]);
    // Order of the input is kept in the output.
    expect(stackedLabelYs([50, 20, 50], 11, 5, 90)).toEqual([50, 20, 61]);
    // At the bottom edge the pile moves up instead of leaving.
    const bottom = stackedLabelYs([88, 88, 88], 11, 5, 90);
    expect(Math.max(...bottom)).toBeLessThanOrEqual(90);
    expect([...bottom].sort((a, b) => a - b).map((v, i, a) => (i === 0 ? 11 : v - (a[i - 1] as number))).every((d) => d >= 11)).toBe(true);
    expect(stackedLabelYs([], 11, 5, 90)).toEqual([]);
  });
});

describe("the value of a series at a moment", () => {
  it("is the last sample at or before it, the first before them all, and none for no samples", () => {
    const pts = [{ t: 1, v: 10 }, { t: 5, v: 20 }, { t: 9, v: 30 }];
    expect(valueAtTime(pts, 0)).toBe(10);
    expect(valueAtTime(pts, 5)).toBe(20);
    expect(valueAtTime(pts, 8.9)).toBe(20);
    expect(valueAtTime(pts, 100)).toBe(30);
    expect(valueAtTime([], 3)).toBeUndefined();
  });
});
