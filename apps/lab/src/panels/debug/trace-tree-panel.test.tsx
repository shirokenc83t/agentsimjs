import { createMemoryPorts, type StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useUiContext } from "@agentsim/ui";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppActionsProvider, ServicesProvider } from "../../services.tsx";
import type { RunSnapshot, RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { firstPart, TraceTreePanel } from "./trace-tree-panel.tsx";

// The trace tree panel (UI-SPEC section 4): what it says before a record is picked, the sections around one, the mark on a copy, and what a click does.

const RUN = "run-000002";
const rec = (seq: number, over: Partial<TraceRecord> = {}): TraceRecord => ({ id: `${RUN}#${seq}`, runId: RUN, seq, simTime: seq, wallTime: 1, source: "uav-001/actions", kind: "action", agentId: "uav-001", payload: { op: "phase", seq }, ...over });
const ref = (seq: number) => `${RUN}#${seq}`;

async function setup(records: TraceRecord[]) {
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "completed" });
  await ports.trace.append(records);
  const view = { runId: RUN, entityIds: ["uav-001"], run: { dtS: 0.1 }, persistedHeadTick: 100, simHeadTick: 100, mode: "replay" } as unknown as RunSnapshot;
  const source = { mode: "replay", snapshot: () => view } as unknown as RunSource;
  const storage = { ports, status: () => ({ state: "ready", mode: "memory-fallback" }), onStatus: () => () => {} } as unknown as StorageClient;
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source, setReplaySource: () => {} }}>
      <AppActionsProvider value={{ resetLayouts: () => {}, setTheme: () => {}, openWorkspace: () => {}, openReplay: () => {}, resimulateWindow: () => {}, backToDebug: () => {}, openPanel: () => {} }}>
        <TraceTreePanel />
      </AppActionsProvider>
    </ServicesProvider>,
  );
}

afterEach(() => act(() => useUiContext.getState().selectRecord(undefined)));

describe("TraceTreePanel", () => {
  it("asks for a record before one is picked", async () => {
    await setup([rec(0)]);
    expect(screen.getByTestId("trace-tree-empty")).toHaveTextContent("Pick a record in the log");
  });

  it("draws the parents, the causes, the record, its children and its effects, one part at a time behind the toggles of a small window", async () => {
    await setup([rec(0), rec(1, { parentId: ref(0) }), rec(2, { causeIds: [ref(1)] }), rec(3, { parentId: ref(2), causeIds: [ref(1)] }), rec(4, { parentId: ref(3) }), rec(5, { causeIds: [ref(3)] })]);
    act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: 3 }));
    await waitFor(() => expect(screen.getByTestId("trace-tree-selected")).toHaveAttribute("data-seq", "3"));
    const user = userEvent.setup();
    // The header counts every part; the part opened first is the first that is not empty after the record (its children).
    expect(screen.getByTestId("tt-head")).toHaveTextContent("↑ parents 1← causes 1↓ children 1→ effects 1");
    expect(screen.getByTestId("tt-children")).toHaveTextContent("#4");
    expect(screen.queryByTestId("tt-parents")).toBeNull();
    for (const [tab, id, text] of [["parents", "tt-parents", "#2"], ["causes", "tt-causes", "#1"], ["effects", "tt-effects", "#5"], ["children", "tt-children", "#4"]] as const) {
      await user.click(screen.getByTestId(`tt-tab-${tab}`));
      expect(screen.getByTestId(id)).toHaveTextContent(text);
      expect(screen.getByTestId(`tt-tab-${tab}`)).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("opens on the first part that is not empty after the record, else before it, and says none for an empty part", async () => {
    await setup([rec(0), rec(1, { parentId: ref(0) })]);
    act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: 1 }));
    await waitFor(() => expect(screen.getByTestId("trace-tree-selected")).toBeInTheDocument());
    expect(screen.getByTestId("tt-parents")).toHaveTextContent("#0"); // nothing after it: the parents
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tt-tab-effects"));
    expect(screen.getByTestId("tt-effects")).toHaveTextContent("none");
    expect(firstPart({ parents: 0, causes: 0, children: 0, effects: 0 })).toBe("children");
    expect(firstPart({ parents: 2, causes: 1, children: 0, effects: 3 })).toBe("effects");
    expect(firstPart({ parents: 2, causes: 1, children: 0, effects: 0 })).toBe("causes");
  });

  it("marks a record a derived run copied from its parent, with the ID it had there", async () => {
    await setup([rec(0, { payload: { op: "config", copyOf: "run-000001#0" } }), rec(1, { parentId: ref(0) })]);
    act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: 1 }));
    await waitFor(() => expect(screen.getByTestId("trace-copy-0")).toHaveTextContent("◇ copy of run-000001#0"));
  });

  it("a click on a node picks that record in the shared context, and the tree is drawn around it", async () => {
    await setup([rec(0), rec(1, { parentId: ref(0) })]);
    act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: 1 }));
    await userEvent.click(await screen.findByTestId("trace-node-0"));
    expect(useUiContext.getState().selectedRecord).toEqual({ runId: RUN, seq: 0 });
    await waitFor(() => expect(screen.getByTestId("trace-tree-selected")).toHaveAttribute("data-seq", "0"));
    expect(screen.getByTestId("tt-children")).toHaveTextContent("#1");
  });

  it("says when the picked record is not in the run", async () => {
    await setup([rec(0)]);
    act(() => useUiContext.getState().selectRecord({ runId: RUN, seq: 77 }));
    expect(await screen.findByTestId("trace-tree-missing")).toHaveTextContent("#77 is not in this run");
  });

  it("ignores a record picked in another run", async () => {
    await setup([rec(0)]);
    act(() => useUiContext.getState().selectRecord({ runId: "run-000009", seq: 0 }));
    expect(screen.getByTestId("trace-tree-empty")).toBeInTheDocument();
  });
});
