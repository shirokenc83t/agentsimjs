import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, filterCommands, type Command } from "./command-palette.tsx";

const cmds = (spy = vi.fn()): Command[] => [
  { id: "ws.scene", title: "Switch to Scene workspace", group: "Workspace", run: () => spy("scene") },
  { id: "ws.data", title: "Switch to Data workspace", group: "Workspace", run: () => spy("data") },
  { id: "db.export", title: "Export database (.sqlite)", group: "Storage", run: () => spy("export") },
  { id: "x.off", title: "Disabled thing", group: "Misc", run: () => spy("off"), disabled: true },
];

describe("CommandPalette", () => {
  it("filters by all terms over group and title, hiding disabled commands", () => {
    expect(filterCommands(cmds(), "work data").map((c) => c.id)).toEqual(["ws.data"]);
    expect(filterCommands(cmds(), "").map((c) => c.id)).toEqual(["ws.scene", "ws.data", "db.export"]);
    expect(filterCommands(cmds(), "disabled")).toEqual([]);
  });

  it("runs the highlighted command with the keyboard and closes", async () => {
    const spy = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open commands={cmds(spy)} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Command" });
    expect(input).toHaveFocus();
    await userEvent.type(input, "workspace");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(spy).toHaveBeenCalledWith("data");
    expect(onClose).toHaveBeenCalled();
  });

  it("a row hovered before filtering never leaves Enter pointing past the filtered list", async () => {
    const spy = vi.fn();
    render(<CommandPalette open commands={cmds(spy)} onClose={vi.fn()} />);
    // The pointer rests over the third row of the unfiltered list (e.g. where the user last clicked).
    await userEvent.hover(screen.getByText("Export database (.sqlite)"));
    await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "data workspace{Enter}");
    expect(spy).toHaveBeenCalledWith("data");
  });

  it("opens with an empty query after a previous use, and keeps what is typed right after opening", async () => {
    const spy = vi.fn();
    const { rerender } = render(<CommandPalette open commands={cmds(spy)} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "export");
    rerender(<CommandPalette open={false} commands={cmds(spy)} onClose={vi.fn()} />);
    rerender(<CommandPalette open commands={cmds(spy)} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Command" });
    expect(input).toHaveValue("");
    await userEvent.type(input, "data{Enter}");
    expect(spy).toHaveBeenCalledWith("data");
  });

  it("closes on Escape and renders nothing when closed", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<CommandPalette open commands={cmds()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    rerender(<CommandPalette open={false} commands={cmds()} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
