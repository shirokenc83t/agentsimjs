import { describe, expect, it } from "vitest";
import { LAYOUT_VERSION, panelNumber, tabTitle, WORKSPACES } from "./presets.ts";

const preset = (id: string) => {
  const w = WORKSPACES.find((x) => x.id === id);
  if (!w) throw new Error(id);
  return w;
};

describe("workspace presets", () => {
  it("numbers the docked panels in the order of the preset and puts the number in the tab's title; a floating window has none", () => {
    const scene = preset("scene");
    expect(panelNumber(scene, "scene")).toBe(1);
    expect(panelNumber(scene, "explorer")).toBe(2);
    expect(panelNumber(scene, "inspector")).toBe(3);
    expect(panelNumber(scene, "perf")).toBeUndefined();
    expect(tabTitle(scene, "explorer", "Explorer")).toBe("[2] Explorer");
    expect(tabTitle(scene, "perf", "Performance")).toBe("Performance");
    expect(panelNumber(preset("debug"), "timeline")).toBe(2);
  });

  it("the Performance window starts collapsed inside the map of the Scene and the Debug, and is in no other workspace", () => {
    for (const w of WORKSPACES) {
      const perf = w.panels.find((p) => p.id === "perf");
      if (w.id === "scene" || w.id === "debug") {
        expect(perf?.floating?.collapsed, w.id).toBe(true);
        expect(perf?.floating?.host, w.id).toBe("scene");
      } else expect(perf, w.id).toBeUndefined();
    }
  });

  it("the Scene's own windows stack from the bottom of the map, the Performance window lowest, each at its own height", () => {
    const stack = ["perf", "legend", "overview"].map((id) => preset("scene").panels.find((p) => p.id === id)?.floating?.stack);
    expect(stack).toEqual([0, 1, 2]);
  });

  it("the Debug lays the Timeline out after the column beside the Scene, so it sits under the Scene alone, as tall as its lanes", () => {
    const t = preset("debug").panels.find((p) => p.id === "timeline");
    expect(t?.late).toBe(true);
    expect(t?.initialHeight).toBeLessThanOrEqual(240);
  });

  it("saved layouts are versioned past the one without numbered tabs and the floating window", () => {
    expect(LAYOUT_VERSION).toBeGreaterThanOrEqual(5);
  });

  it("the Scene workspace has the Overview and the Legend as floating windows, collapsed to start with; the numbers are the docked panels'", () => {
    const scene = preset("scene");
    for (const id of ["overview", "legend"] as const) {
      expect(scene.panels.find((p) => p.id === id)?.floating?.collapsed, id).toBe(true);
      expect(panelNumber(scene, id)).toBeUndefined();
    }
    expect(panelNumber(scene, "inspector")).toBe(3);
    expect(LAYOUT_VERSION).toBeGreaterThanOrEqual(6);
  });
});
