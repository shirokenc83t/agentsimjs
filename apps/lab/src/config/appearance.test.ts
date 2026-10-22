import { createMemoryPorts } from "@agentsim/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, saveAppearance } from "./appearance.ts";

describe("appearance preferences (Settings)", () => {
  beforeEach(() => {
    delete document.documentElement.dataset["motion"];
    delete document.documentElement.dataset["dockgrid"];
  });

  it("defaults to the OS motion preference and the dock dot grid on, and puts nothing on the document", async () => {
    const { userData } = createMemoryPorts();
    expect(await loadAppearance(userData)).toEqual(DEFAULT_APPEARANCE);
    applyAppearance(DEFAULT_APPEARANCE);
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
    expect(document.documentElement.dataset["dockgrid"]).toBeUndefined();
  });

  it("keeps what is saved in user data and puts it on the document, so the CSS can follow it", async () => {
    const { userData } = createMemoryPorts();
    await saveAppearance(userData, { reducedMotion: true, dockGrid: false });
    const back = await loadAppearance(userData);
    expect(back).toEqual({ reducedMotion: true, dockGrid: false });
    applyAppearance(back);
    expect(document.documentElement.dataset["motion"]).toBe("reduce");
    expect(document.documentElement.dataset["dockgrid"]).toBe("off");
    applyAppearance(DEFAULT_APPEARANCE);
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
    expect(document.documentElement.dataset["dockgrid"]).toBeUndefined();
  });
});
