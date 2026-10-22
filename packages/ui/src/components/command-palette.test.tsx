import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, filterCommands, matchedChars, type Command } from "./command-palette.tsx";

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

  it("Escape closes the palette and puts the focus back where it was before it opened", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <CommandPalette open={open} commands={cmds()} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "opener" });
    await userEvent.click(opener);
    expect(screen.getByRole("textbox", { name: "Command" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("groups the results under their group's heading, in the order the groups first appear", () => {
    const mixed: Command[] = [
      { id: "a", title: "Switch to Scene workspace", group: "Workspace", run: () => {} },
      { id: "b", title: "Export database (.sqlite)", group: "Storage", run: () => {} },
      { id: "c", title: "Switch to Data workspace", group: "Workspace", run: () => {} },
    ];
    render(<CommandPalette open commands={mixed} onClose={vi.fn()} />);
    const heads = screen.getAllByRole("presentation").map((h) => h.textContent);
    expect(heads).toEqual(["Workspace", "Storage"]);
    // The two workspace commands sit together under their heading.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Switch to Scene workspace", "Switch to Data workspace", "Export database (.sqlite)"]);
  });

  it("marks the letters the query matched and shows a command's key", async () => {
    const withKey: Command[] = [{ id: "p", title: "Play", group: "Run", keys: "Space", run: () => {} }, ...cmds()];
    render(<CommandPalette open commands={withKey} onClose={vi.fn()} />);
    expect(screen.getByText("Space")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "exp");
    expect(Array.from(document.querySelectorAll(".palette mark")).map((m) => m.textContent)).toEqual(["Exp"]);
    expect(matchedChars("Export database", ["exp", "data"]).filter(Boolean).length).toBe(7);
    expect(matchedChars("Play", [])).toEqual([false, false, false, false]);
  });
});
