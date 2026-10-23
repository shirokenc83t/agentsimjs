import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapTransform, type MapModel } from "./analysis-model.ts";
import { TopDownMap } from "./top-down-map.tsx";

// What a click or a hover on the map picks: an event first, then an agent, then a sample of a trajectory; nothing where there is nothing.

const model: MapModel = {
  widthM: 100,
  heightM: 100,
  blocked: undefined,
  trajectories: [{ agentId: "ugv-001", colorIndex: 0, points: [{ x: 10, y: 10, t: 0 }, { x: 50, y: 10, t: 5 }, { x: 50, y: 50, t: 10 }] }],
  positions: [{ agentId: "ugv-001", colorIndex: 0, x: 50, y: 50 }],
  markers: [{ seq: 7, t: 5, agentId: "ugv-001", kind: "action", glyph: "✕", role: "alarm", x: 50, y: 10, label: "5.0 s ugv-001 action end failed" }],
};
// The map is 80 × 80 px when jsdom measures nothing: the world fits with the margin.
const tf = mapTransform(model, 80, 80);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 80, bottom: 80, width: 80, height: 80, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => vi.unstubAllGlobals());

const at = (x: number, y: number) => ({ clientX: tf.px(x), clientY: tf.py(y) });

describe("TopDownMap picks", () => {
  it("an event is picked by its record, with its moment and its agent, in preference to the line under it", () => {
    const onPick = vi.fn();
    render(<TopDownMap model={model} onPick={onPick} label="map" />);
    fireEvent.click(screen.getByTestId("map2d-canvas"), at(50, 10));
    expect(onPick).toHaveBeenCalledWith({ seq: 7, t: 5, agentId: "ugv-001" });
  });

  it("an agent is picked where it is; a sample of a trajectory is a moment; empty map is nothing", () => {
    const onPick = vi.fn();
    render(<TopDownMap model={model} onPick={onPick} label="map" />);
    const c = screen.getByTestId("map2d-canvas");
    fireEvent.click(c, at(50, 50));
    expect(onPick).toHaveBeenLastCalledWith({ agentId: "ugv-001" });
    fireEvent.click(c, at(10, 10));
    expect(onPick).toHaveBeenLastCalledWith({ t: 0, agentId: "ugv-001" });
    onPick.mockClear();
    fireEvent.click(c, at(90, 90));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a hover names what is under the pointer, and goes away when the pointer leaves or there is nothing", () => {
    render(<TopDownMap model={model} label="map" />);
    const c = screen.getByTestId("map2d-canvas");
    fireEvent.pointerMove(c, at(50, 10));
    expect(screen.getByTestId("map2d-tip")).toHaveTextContent("5.0 s ugv-001 action end failed");
    fireEvent.pointerMove(c, at(90, 90));
    expect(screen.queryByTestId("map2d-tip")).toBeNull();
    fireEvent.pointerMove(c, at(10, 10));
    expect(screen.getByTestId("map2d-tip")).toHaveTextContent("ugv-001 at 0.0 s");
    fireEvent.pointerLeave(c);
    expect(screen.queryByTestId("map2d-tip")).toBeNull();
  });

  it("lists the agents as buttons, for the keyboard and a screen reader; each picks its agent", () => {
    const onPick = vi.fn();
    render(<TopDownMap model={model} onPick={onPick} label="map" />);
    const b = screen.getByTestId("map2d-agent-ugv-001");
    expect(b).toHaveTextContent("ugv-001 at 50.0 m, 50.0 m");
    fireEvent.click(b);
    expect(onPick).toHaveBeenCalledWith({ agentId: "ugv-001" });
  });

  it("says what it holds as attributes of its canvas, and has an accessible name", () => {
    render(<TopDownMap model={model} label="Top-down map of run-000001" />);
    const c = screen.getByRole("img", { name: "Top-down map of run-000001" });
    expect(c).toHaveAttribute("data-markers", "1");
    expect(c).toHaveAttribute("data-trajectories", "1");
  });
});
