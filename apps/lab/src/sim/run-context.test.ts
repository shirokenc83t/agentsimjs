import { createUiContextStore } from "@agentsim/ui";
import { describe, expect, it } from "vitest";
import { syncRunContext } from "./run-context.ts";

describe("syncRunContext", () => {
  it("makes a new run the context's run, resets the selection, and lets the cursor follow the live sim head", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 0 });
    expect(store.getState()).toMatchObject({ runId: "run-000001", mode: "live", simTime: 0 });
    store.getState().select({ kind: "agent", id: "uav-001" });
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 4.2 });
    expect(store.getState()).toMatchObject({ simTime: 4.2, selection: { kind: "agent", id: "uav-001" } });
    syncRunContext(store, { mode: "live", runId: "run-000002", simTimeS: 0.1, run: { agents: [{ id: "ugv-001" }] } });
    expect(store.getState()).toMatchObject({ runId: "run-000002", simTime: 0.1, selection: undefined });
  });

  it("a live run replaced by another live run keeps the viewed agent when the new run has it, and a viewed cell", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 0 });
    store.getState().select({ kind: "agent", id: "uav-001" });
    syncRunContext(store, { mode: "live", runId: "run-000002", simTimeS: 0, run: { agents: [{ id: "uav-001" }, { id: "ugv-001" }] } });
    expect(store.getState().selection).toEqual({ kind: "agent", id: "uav-001" });
    store.getState().select({ kind: "cell", id: "4,5" });
    syncRunContext(store, { mode: "live", runId: "run-000003", simTimeS: 0, run: { agents: [] } });
    expect(store.getState().selection).toEqual({ kind: "cell", id: "4,5" });
    store.getState().select({ kind: "agent", id: "uav-001" });
    syncRunContext(store, { mode: "replay", runId: "run-000001", simTimeS: 0 });
    expect(store.getState().selection).toBeUndefined();
  });

  it("never moves the cursor of a replay: it is the user's", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "replay", runId: "run-000003", simTimeS: 99 });
    expect(store.getState()).toMatchObject({ runId: "run-000003", mode: "replay", simTime: 0 });
    store.getState().setSimTime(12.5);
    syncRunContext(store, { mode: "replay", runId: "run-000003", simTimeS: 99 });
    expect(store.getState().simTime).toBe(12.5);
  });

  it("a switch from live to replay of the same run changes the mode and keeps the cursor where it was; a replay of another run starts afresh", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 8 });
    syncRunContext(store, { mode: "replay", runId: "run-000001", simTimeS: 8 });
    expect(store.getState()).toMatchObject({ mode: "replay", simTime: 8 });
    syncRunContext(store, { mode: "replay", runId: "run-000009", simTimeS: 8 });
    expect(store.getState()).toMatchObject({ mode: "replay", runId: "run-000009", simTime: 0 });
  });

  it("a live cursor the user moved is not dragged back to the sim head; one that follows keeps following", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 0 });
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 1 });
    expect(store.getState().simTime).toBe(1); // following
    store.getState().setSimTime(0.4); // the user moves it (a click on the Timeline)
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 2 });
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 3 });
    expect(store.getState().simTime).toBe(0.4);
  });

  it("scrubbing the live run back (the same run, now a replay) keeps the cursor and the selection where they are", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 0 });
    store.getState().select({ kind: "agent", id: "uav-001" });
    store.getState().setSimTime(6.5);
    syncRunContext(store, { mode: "replay", runId: "run-000001", simTimeS: 9 });
    expect(store.getState()).toMatchObject({ mode: "replay", runId: "run-000001", simTime: 6.5, selection: { kind: "agent", id: "uav-001" } });
    // A replay of another run starts afresh.
    syncRunContext(store, { mode: "replay", runId: "run-000002", simTimeS: 0 });
    expect(store.getState()).toMatchObject({ runId: "run-000002", simTime: 0, selection: undefined });
  });

  it("Live from a replay of the same run keeps the selection, and the cursor goes to the sim head", () => {
    const store = createUiContextStore();
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 0 });
    store.getState().select({ kind: "agent", id: "uav-001" });
    syncRunContext(store, { mode: "replay", runId: "run-000001", simTimeS: 9 });
    syncRunContext(store, { mode: "live", runId: "run-000001", simTimeS: 9.5 });
    expect(store.getState()).toMatchObject({ mode: "live", runId: "run-000001", simTime: 9.5, selection: { kind: "agent", id: "uav-001" } });
  });
});
