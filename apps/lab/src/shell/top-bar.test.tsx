import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopBar, type TopBarProps } from "./top-bar.tsx";

const WORKSPACES = [
  { id: "scene", title: "Scene" },
  { id: "debug", title: "Debug" },
  { id: "author", title: "Author" },
  { id: "data", title: "Data" },
  { id: "settings", title: "Settings" },
] as const;

function bar(over: Partial<TopBarProps> = {}) {
  const props: TopBarProps = {
    workspaces: WORKSPACES,
    workspace: "debug",
    onWorkspace: vi.fn(),
    layouts: ["wide map", "logs first"],
    layoutActive: undefined,
    onSelectLayout: vi.fn(),
    onSaveLayout: vi.fn(),
    onDeleteLayout: vi.fn(),
    onResetLayout: vi.fn(),
    runLabel: "run-000001 · f1-demo v1",
    runOpen: false,
    onRunClick: vi.fn(),
    replaying: false,
    onPalette: vi.fn(),
    ...over,
  };
  render(<TopBar {...props} />);
  return props;
}

describe("TopBar", () => {
  it("lists the workspaces with their numbers, the open one marked, and opens another on a click", async () => {
    const p = bar();
    const names = screen.getAllByRole("button", { name: /workspace, key \d/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Scene workspace, key 1", "Debug workspace, key 2", "Author workspace, key 3", "Data workspace, key 4", "Settings workspace, key 5"]);
    expect(screen.getByTestId("tab-debug")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("tab-scene")).not.toHaveAttribute("aria-current");
    await userEvent.click(screen.getByTestId("tab-author"));
    expect(p.onWorkspace).toHaveBeenCalledWith("author");
  });

  it("shows the layout with its reset, the run selector, and the palette", async () => {
    const p = bar();
    await userEvent.click(screen.getByTestId("layout-reset"));
    expect(p.onResetLayout).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("run-label"));
    expect(p.onRunClick).toHaveBeenCalled();
    expect(screen.getByTestId("run-label")).toHaveTextContent("run-000001 · f1-demo v1");
    await userEvent.click(screen.getByRole("button", { name: "Command palette" }));
    expect(p.onPalette).toHaveBeenCalled();
  });

  it("lists the named layouts, loads one, saves the dock under a name asked in place, and deletes the one in use", async () => {
    const p = bar({ layoutActive: "wide map" });
    expect(screen.getByRole("combobox", { name: "Layout" })).toHaveValue("wide map");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["autosaved", "wide map", "logs first"]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Layout" }), "logs first");
    expect(p.onSelectLayout).toHaveBeenCalledWith("logs first");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Layout" }), "");
    expect(p.onSelectLayout).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(screen.getByTestId("layout-save"));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the layout" }), "mine{Enter}");
    expect(p.onSaveLayout).toHaveBeenCalledWith("mine");
    expect(screen.queryByRole("textbox", { name: "Name of the layout" })).toBeNull();
    await userEvent.click(screen.getByTestId("layout-delete"));
    expect(p.onDeleteLayout).toHaveBeenCalled();
  });

  it("a name that is not saved (Escape) is dropped", async () => {
    const p = bar();
    await userEvent.click(screen.getByTestId("layout-save"));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the layout" }), "x{Escape}");
    expect(p.onSaveLayout).not.toHaveBeenCalled();
    expect(screen.queryByTestId("layout-delete")).toBeNull(); // nothing named in use
  });

  it("has the ◷ REPLAY segment only while a recording is shown", () => {
    bar({ replaying: true });
    expect(screen.getByRole("status")).toHaveTextContent("◷ REPLAY");
  });

  it("says in the segment, compactly, that the recording is a re-simulated window: its span, its parent and whether it matches; the whole text is in the tooltip", () => {
    bar({ replaying: true, derived: { parentRunId: "run-000001", t0S: 15, t1S: 19, status: "matches" } });
    expect(screen.getByTestId("replay-derived")).toHaveTextContent("◇ 15.0–19.0 of run-000001 · ✓");
    expect(screen.getByRole("status")).toHaveTextContent(/^◷ t 0\.0/);
    expect(screen.getByRole("status")).toHaveAttribute("title", expect.stringContaining("REPLAY · viewing t 0.0 s · a re-simulated window (15.0–19.0 s) of run-000001: every recorded checkpoint in the window was reproduced"));
  });

  it("a derived run that did not reproduce its checkpoints says ✕ and the tick, and the tooltip where it diverged", () => {
    bar({ replaying: true, derived: { parentRunId: "run-000001", t0S: 15, t1S: 19, status: "divergent", divergenceTick: 160 } });
    expect(screen.getByTestId("replay-derived")).toHaveTextContent("✕ @160");
    expect(screen.getByRole("status")).toHaveAttribute("title", expect.stringContaining("tick 160"));
  });

  it("a recording that is not derived has nothing of the kind", () => {
    bar({ replaying: true });
    expect(screen.queryByTestId("replay-derived")).toBeNull();
  });

  it("has no replay segment live", () => {
    bar({ replaying: false });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
