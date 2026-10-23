import { describe, expect, it, vi } from "vitest";
import { createUiContextStore } from "./ui-context.ts";

describe("UI context bus (ADR-0016)", () => {
  it("notifies every subscriber of a selection made anywhere", () => {
    const store = createUiContextStore();
    const sceneSeen = vi.fn();
    const inspectorSeen = vi.fn();
    store.subscribe((s) => sceneSeen(s.selection));
    store.subscribe((s) => inspectorSeen(s.selection));
    store.getState().select({ kind: "agent", id: "uav-001" });
    expect(sceneSeen).toHaveBeenLastCalledWith({ kind: "agent", id: "uav-001" });
    expect(inspectorSeen).toHaveBeenLastCalledWith({ kind: "agent", id: "uav-001" });
  });

  it("resets cursor and selection when the run changes; rejects invalid times", () => {
    const store = createUiContextStore();
    store.getState().setSimTime(12.5);
    store.getState().select({ kind: "span", id: "#42" });
    store.getState().setRun("run-000002");
    expect(store.getState()).toMatchObject({ runId: "run-000002", simTime: 0, selection: undefined });
    store.getState().setSimTime(Number.NaN);
    expect(store.getState().simTime).toBe(0);
  });

  it("carries the run mode: live by default, replay when a run is opened for replay, and a new run starts live again", () => {
    const store = createUiContextStore();
    expect(store.getState().mode).toBe("live");
    store.getState().setRun("run-000003", "replay");
    expect(store.getState()).toMatchObject({ runId: "run-000003", mode: "replay", simTime: 0 });
    store.getState().setSimTime(41.2);
    store.getState().setRun("run-000004");
    expect(store.getState()).toMatchObject({ runId: "run-000004", mode: "live", simTime: 0 });
  });

  it("holds a time selection of the Timeline: ordered and forward, none when it is empty or not a number, and a new run clears it", () => {
    const store = createUiContextStore();
    expect(store.getState().timeSelection).toBeUndefined();
    store.getState().setTimeSelection({ t0S: 12, t1S: 18.5 });
    expect(store.getState().timeSelection).toEqual({ t0S: 12, t1S: 18.5 });
    store.getState().setTimeSelection({ t0S: -4, t1S: 3 });
    expect(store.getState().timeSelection).toEqual({ t0S: 0, t1S: 3 });
    store.getState().setTimeSelection({ t0S: 5, t1S: 5 });
    expect(store.getState().timeSelection).toBeUndefined();
    store.getState().setTimeSelection({ t0S: 9, t1S: 4 });
    expect(store.getState().timeSelection).toBeUndefined();
    store.getState().setTimeSelection({ t0S: Number.NaN, t1S: 4 });
    expect(store.getState().timeSelection).toBeUndefined();
    store.getState().setTimeSelection({ t0S: 1, t1S: 2 });
    store.getState().setRun("run-000009");
    expect(store.getState().timeSelection).toBeUndefined();
  });

  it("is read imperatively: the cursor is there at any time without a subscriber (the renderer never re-renders on it)", () => {
    const store = createUiContextStore();
    const seen = vi.fn();
    store.getState().setSimTime(7);
    expect(store.getState().simTime).toBe(7);
    store.subscribe(seen);
    store.getState().setSimTime(8);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.getState().simTime).toBe(8);
  });
});
