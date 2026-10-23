import { describe, expect, it } from "vitest";
import { BUILTIN_LAYOUTS, DEBUG_LOGS_LAYOUT, DEBUG_LOGS_PRESET, LAYOUT_VERSION, panelNumber, tabTitle, WORKSPACES } from "./presets.ts";

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

  it("the Legend sits above the Performance window at the right of the map and the Overview at the left, so that the two open together do not touch", () => {
    const f = (id: string) => preset("scene").panels.find((p) => p.id === id)?.floating;
    expect([f("perf")?.stack, f("legend")?.stack, f("overview")?.stack]).toEqual([0, 1, 1]);
    expect(f("overview")?.side).toBe("left");
    expect(f("legend")?.side).toBeUndefined();
  });

  it("the Debug lays the Timeline out after the column beside the Scene, so it sits under the Scene alone, as tall as its lanes", () => {
    const t = preset("debug").panels.find((p) => p.id === "timeline");
    expect(t?.late).toBe(true);
    expect(t?.initialHeight).toBeLessThanOrEqual(240);
  });

  it("the Debug has the Trace under the Log, in a group of its own with the Inspector below it, and the Logs are not a panel of its dock", () => {
    const d = preset("debug");
    expect(d.panels.find((p) => p.id === "traceTree")?.position).toEqual({ referencePanel: "inspector", direction: "above" });
    expect(d.panels.find((p) => p.id === "traceTree")?.background).toBeUndefined();
    expect(d.panels.some((p) => p.id === "logInspector")).toBe(false);
    expect(LAYOUT_VERSION).toBeGreaterThanOrEqual(11);
  });

  it("'debug · logs' ships with the Debug: the multi-log inspector fills the area with the Timeline below it and no Scene", () => {
    expect(BUILTIN_LAYOUTS.debug?.map((b) => b.name)).toEqual([DEBUG_LOGS_LAYOUT]);
    const ids = DEBUG_LOGS_PRESET.panels.map((p) => p.id);
    expect(ids).toEqual(["logInspector", "timeline"]); // the Performance window floats inside the Scene's map: with no Scene it is opened from the status bar
    expect(panelNumber(DEBUG_LOGS_PRESET, "logInspector")).toBe(1);
    expect(DEBUG_LOGS_PRESET.panels.find((p) => p.id === "timeline")?.position).toEqual({ referencePanel: "logInspector", direction: "below" });
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
