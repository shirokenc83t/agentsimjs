import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { AnalysisSeriesView } from "./analysis-series.tsx";
import type { AnalysisSeries } from "./analysis-model.ts";

const line = (agentId: string, name: string, unit: string, values: number[]): AnalysisSeries => ({
  key: `${agentId}/${name}`,
  agentId,
  name,
  unit,
  source: "metric",
  points: values.map((v, i) => ({ t: i, v })),
});
const view = (series: AnalysisSeries[]) =>
  render(<AnalysisSeriesView series={series} indexOf={(id) => Number(id.replace(/\D/g, "")) || 0} span={{ t0: 0, t1: 10 }} cursorS={0} onSeek={() => {}} />);

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("the series charts", () => {
  it("give a series that never moves one line with its value, not a plot, and keep the plot of one that does", () => {
    view([line("ugv-001", "battery", "fraction", [1, 1, 1]), line("ugv-002", "battery", "fraction", [1, 1, 1]), line("ugv-001", "speed", "m/s", [0, 1, 2])]);
    const flat = screen.getByTestId("series-battery");
    expect(flat).toHaveAttribute("data-flat", "true");
    expect(within(flat).getByTestId("series-flat-battery")).toHaveTextContent("1.00");
    expect(flat).toHaveTextContent("all run");
    expect(flat).toHaveTextContent("2 agents");
    expect(flat.querySelector("svg")).toBeNull();
    expect(screen.getByTestId("series-speed").querySelector("svg")).not.toBeNull();
  });

  it("label the ends of a few lines, and for many lines label six and list every one, with its last value, in a legend that scrolls", () => {
    const many = Array.from({ length: 12 }, (_, i) => line(`ugv-${String(i + 1).padStart(3, "0")}`, "speed", "m/s", [0, i + 1]));
    view(many);
    const chart = screen.getByTestId("series-speed");
    expect(chart.querySelectorAll('[data-testid^="series-end-speed-"]')).toHaveLength(6);
    const legend = screen.getByTestId("series-legend-speed");
    expect(legend.querySelectorAll("li")).toHaveLength(12);
    expect(legend).toHaveTextContent("12");
  });

  it("have no legend when the lines fit their labels", () => {
    view([line("ugv-001", "speed", "m/s", [0, 1]), line("ugv-002", "speed", "m/s", [0, 2])]);
    expect(screen.queryByTestId("series-legend-speed")).toBeNull();
    expect(screen.getAllByTestId(/^series-end-speed-/)).toHaveLength(2);
  });

  it("one subject, one hue: with an agent selected its line keeps its colour and the others are neutral; with none every line has its own", () => {
    const series = [line("ugv-001", "battery", "%", [100, 90, 80]), line("ugv-002", "battery", "%", [100, 70, 60]), line("ugv-003", "battery", "%", [100, 95, 92])];
    const idx = (id: string) => Number(id.replace(/\D/g, "")) || 0;
    const stroke = (c: HTMLElement, id: string) => (c.querySelector(`polyline[data-agent="${id}"]`) as SVGElement).style.stroke;
    const none = render(<AnalysisSeriesView series={series} indexOf={idx} span={{ t0: 0, t1: 10 }} cursorS={0} onSeek={() => {}} />).container;
    expect(stroke(none, "ugv-001")).toBe("var(--agent-1)");
    expect(stroke(none, "ugv-002")).toBe("var(--agent-2)");
    const picked = render(<AnalysisSeriesView series={series} indexOf={idx} span={{ t0: 0, t1: 10 }} cursorS={0} selectedAgent="ugv-002" onSeek={() => {}} />).container;
    expect(stroke(picked, "ugv-002")).toBe("var(--agent-2)");
    expect(stroke(picked, "ugv-001")).toBe("var(--fg3)");
    expect(stroke(picked, "ugv-003")).toBe("var(--fg3)");
  });
});
