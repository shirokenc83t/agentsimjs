import { describe, expect, it } from "vitest";
import { estimateVolume, etaS, formatDuration, fractionDone, grouped, snapshotMarks, sparkPoints, speedLabel, waitingLabel } from "./monitor-model.ts";

describe("the monitor numbers", () => {
  it("progress is the sim time over the end condition, exactly 1 only when the run is done there, and none without an end condition", () => {
    expect(fractionDone({ simTimeS: 15, untilS: 60, done: false })).toBe(0.25);
    expect(fractionDone({ simTimeS: 59.99, untilS: 60, done: false })).toBeLessThan(1);
    expect(fractionDone({ simTimeS: 60, untilS: 60, done: true })).toBe(1);
    expect(fractionDone({ simTimeS: 12, untilS: 60, done: true })).toBe(0.2); // stopped early: not 1
    expect(fractionDone({ simTimeS: 12, untilS: undefined, done: false })).toBeUndefined();
  });

  it("the ETA is the sim time left at the speed of the last window, and nothing when it cannot say", () => {
    expect(etaS({ simTimeS: 20, untilS: 60, simSecondsPerSecond: 40, done: false, running: true })).toBe(1);
    expect(etaS({ simTimeS: 20, untilS: 60, simSecondsPerSecond: 0, done: false, running: true })).toBeUndefined();
    expect(etaS({ simTimeS: 20, untilS: 60, simSecondsPerSecond: 40, done: false, running: false })).toBeUndefined();
    expect(etaS({ simTimeS: 60, untilS: 60, simSecondsPerSecond: 40, done: true, running: false })).toBeUndefined();
    expect(etaS({ simTimeS: 20, untilS: undefined, simSecondsPerSecond: 40, done: false, running: true })).toBeUndefined();
    expect(etaS({ simTimeS: 70, untilS: 60, simSecondsPerSecond: 40, done: false, running: true })).toBe(0);
  });

  it("durations, counts and speeds read at a glance", () => {
    expect(formatDuration(0.04)).toBe("0.0 s");
    expect(formatDuration(3.26)).toBe("3.3 s");
    expect(formatDuration(42.4)).toBe("42 s");
    expect(formatDuration(185)).toBe("3 min 05 s");
    expect(formatDuration(3725)).toBe("1 h 02 min");
    expect(formatDuration(-1)).toBe("—");
    expect(grouped(1234567)).toBe("1 234 567");
    expect(grouped(12)).toBe("12");
    expect(speedLabel(48)).toBe("×48 real time");
    expect(speedLabel(3.456)).toBe("×3.5 real time");
    expect(speedLabel(0)).toBe("—");
  });

  it("says what the run waits for, in words", () => {
    expect(waitingLabel("none", true, false)).toContain("not waiting");
    expect(waitingLabel("decision", true, false)).toContain("mind");
    expect(waitingLabel("storage_backpressure", true, false)).toContain("nothing is lost");
    expect(waitingLabel("storage_quota", true, false)).toContain("quota");
    expect(waitingLabel("header", true, false)).toContain("header");
    expect(waitingLabel("none", false, false)).toBe("paused");
    expect(waitingLabel("storage_backpressure", false, true)).toBe("done");
  });

  it("estimates the volume from what is stored so far, once there is a second of it", () => {
    expect(estimateVolume(undefined, 30, 60)).toBeUndefined();
    expect(estimateVolume(1000, 0.5, 60)).toBeUndefined();
    expect(estimateVolume(0, 30, 60)).toBeUndefined();
    expect(estimateVolume(3000, 30, 60)).toEqual({ perSimHourBytes: 360_000, atEndBytes: 6000 });
    expect(estimateVolume(3000, 30, undefined)).toEqual({ perSimHourBytes: 360_000, atEndBytes: undefined });
  });

  it("places the snapshot marks along the bar, against the end condition or the time so far", () => {
    expect(snapshotMarks({ snapshotTicks: [0, 300, 600], simTimeS: 45, untilS: 60, tick: 450 }, 0.1)).toEqual([0, 0.5, 1]);
    expect(snapshotMarks({ snapshotTicks: [0, 300], simTimeS: 45, untilS: undefined, tick: 450 }, 0.1)).toEqual([0, 30 / 45]);
    expect(snapshotMarks({ snapshotTicks: [9000], simTimeS: 45, untilS: 60, tick: 450 }, 0.1)).toEqual([1]);
    expect(snapshotMarks({ snapshotTicks: [], simTimeS: 0, untilS: undefined, tick: 0 }, 0.1)).toEqual([]);
  });

  it("draws a sparkline of at most the points asked, in its own range, keeping the first and the last point", () => {
    expect(sparkPoints([{ t: 0, v: 1 }], 100, 20)).toBe("");
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: Math.sin(i / 20) }));
    const line = sparkPoints(pts, 100, 20, 100).split(" ");
    expect(line.length).toBeLessThanOrEqual(101);
    expect(line[0]?.startsWith("0.0,")).toBe(true);
    expect(line.at(-1)?.startsWith("100.0,")).toBe(true);
    const ys = line.map((p) => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(19);
    // A flat series is a line, not a division by zero.
    expect(sparkPoints([{ t: 0, v: 5 }, { t: 1, v: 5 }], 10, 10)).toMatch(/^0\.0,[\d.]+ 10\.0,[\d.]+$/);
  });
});
