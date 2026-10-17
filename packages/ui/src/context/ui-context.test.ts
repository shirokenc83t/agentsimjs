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
});
