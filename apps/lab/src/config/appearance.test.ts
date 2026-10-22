import { beforeEach, describe, expect, it } from "vitest";
import { applyAppearance, readAppearance, writeAppearance } from "./appearance.ts";

describe("appearance preferences (Settings)", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset["motion"];
    delete document.documentElement.dataset["dockgrid"];
  });

  it("defaults to the OS motion preference and the dock dot grid on", () => {
    expect(readAppearance()).toEqual({ reducedMotion: false, dockGrid: true });
    applyAppearance(readAppearance());
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
    expect(document.documentElement.dataset["dockgrid"]).toBeUndefined();
  });

  it("keeps what is written and puts it on the document, so the CSS can follow it", () => {
    writeAppearance({ reducedMotion: true, dockGrid: false });
    expect(readAppearance()).toEqual({ reducedMotion: true, dockGrid: false });
    applyAppearance(readAppearance());
    expect(document.documentElement.dataset["motion"]).toBe("reduce");
    expect(document.documentElement.dataset["dockgrid"]).toBe("off");
    writeAppearance({ reducedMotion: false, dockGrid: true });
    applyAppearance(readAppearance());
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
    expect(document.documentElement.dataset["dockgrid"]).toBeUndefined();
  });
});
