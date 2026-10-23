import { describe, expect, it } from "vitest";
import { trackLayout } from "./track.ts";

describe("player track layout", () => {
  it("a stored run read on its own: saved to its end, no gap, the cursor where it is", () => {
    expect(trackLayout({ headS: 20, simHeadS: undefined, shownS: 5, dtS: 0.1 })).toEqual({ scaleS: 20, savedPct: 100, gapLeftPct: 100, gapWidthPct: 0, cursorPct: 25 });
  });

  it("a live run being scrubbed: the track spans the sim head and the gap is what is not saved yet", () => {
    const t = trackLayout({ headS: 15, simHeadS: 20, shownS: 15, dtS: 0.1 });
    expect(t.scaleS).toBe(20);
    expect(t.savedPct).toBe(75);
    expect(t.gapLeftPct).toBe(75);
    expect(t.gapWidthPct).toBe(25);
    expect(t.cursorPct).toBe(75);
  });

  it("a re-simulated window: the track starts at the window's start, so the cursor and the end are measured from it", () => {
    const t = trackLayout({ headS: 19, simHeadS: undefined, shownS: 17, dtS: 0.1, startS: 15 });
    expect(t.scaleS).toBe(19);
    expect(t.savedPct).toBe(100);
    expect(t.cursorPct).toBe(50);
    expect(trackLayout({ headS: 19, simHeadS: undefined, shownS: 15, dtS: 0.1, startS: 15 }).cursorPct).toBe(0);
    expect(trackLayout({ headS: 19, simHeadS: undefined, shownS: 3, dtS: 0.1, startS: 15 }).cursorPct).toBe(0); // before the window: its start
  });

  it("never divides by zero: an empty run is one tick wide", () => {
    const t = trackLayout({ headS: 0, simHeadS: 0, shownS: 0, dtS: 0.1 });
    expect(t.scaleS).toBe(0.1);
    expect(t.cursorPct).toBe(0);
  });
});
