import { createMemoryPorts, type StorageAdmin, type StorageInfo } from "@agentsim/storage";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StorageBrowser } from "./storage-browser.tsx";

const info: StorageInfo = {
  mode: "opfs-sahpool", sqliteVersion: "3.53.4", schemaVersion: 1, dbFileBytes: 4096, usageBytes: 1e6,
  quotaBytes: 1e9, persisted: true, quotaThresholdBytes: 256 * 1024 * 1024, warning: null,
};

function setup(adminOverrides: Partial<StorageAdmin> = {}, props: { currentRunId?: string } = {}) {
  const ports = createMemoryPorts();
  const admin: StorageAdmin = {
    info: vi.fn(async () => info),
    exportDb: vi.fn(async () => new Uint8Array([1, 2, 3])),
    exportRun: vi.fn(async () => ({ ok: true as const, value: new Uint8Array([4]) })),
    importDb: vi.fn(async () => ({ ok: true as const, value: undefined })),
    exportRunJsonl: vi.fn(async () => ({ ok: true as const, value: new Uint8Array([6, 7]) })),
    importRun: vi.fn(async () => ({ ok: true as const, value: { runId: "run-000005", importedFrom: "run-000001" } })),
    requestPersistence: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    compact: vi.fn(async () => ({ freedBytes: 0, skipped: false })),
    ...adminOverrides,
  };
  const download = vi.fn();
  render(<StorageBrowser client={{ ports, admin }} download={download} nowWallMs={() => 1_700_000_000_000} {...props} />);
  return { ports, admin, download };
}

describe("StorageBrowser", () => {
  it("shows storage info and an empty run list", async () => {
    setup();
    expect(await screen.findByTestId("storage-mode")).toHaveTextContent("opfs-sahpool");
    expect(screen.getByText("No runs stored yet.")).toBeInTheDocument();
  });

  it("creates a sample run through the ports and lists it with its record count", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    const row = await screen.findByTestId("run-row-run-000001");
    expect(row).toHaveTextContent("100");
    expect(await ports.trace.count("run-000001")).toBe(100);
  });

  it("exports the database and a single run as downloads", async () => {
    const { download } = setup();
    await userEvent.click(await screen.findByTestId("export-db"));
    await waitFor(() => expect(download).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "agentsim.sqlite"));
    await userEvent.click(screen.getByTestId("create-sample-run"));
    await userEvent.click(await screen.findByRole("button", { name: "Export run-000001" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(new Uint8Array([4]), "run-000001.sqlite"));
  });

  it("reports a rejected import with its stable code", async () => {
    setup({ importDb: vi.fn(async () => ({ ok: false as const, error: { code: "not_sqlite" as const, message: "not an SQLite database file" } })) });
    const input = await screen.findByTestId("import-file");
    await userEvent.upload(input, new File([new Uint8Array([0])], "bad.sqlite"));
    expect(await screen.findByTestId("storage-message")).toHaveTextContent("import rejected (not_sqlite)");
  });

  it("shows what each run holds: records, blobs, snapshots and belief frames, with their sizes", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    const size = await screen.findByTestId("run-size-run-000001");
    expect(size).toHaveTextContent(/records 100/);
    expect(size).toHaveTextContent(/blobs 0/);
    expect(size).toHaveTextContent(/snapshots 0/);
    expect(size).toHaveTextContent(/belief frames 0/);
    expect(size).toHaveTextContent(/metric samples 0/);
    expect((await ports.runs.sizes("run-000001"))?.records.count).toBe(100);
  });

  it("deletes a run after a confirmation that names the run and its size, and not before", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete run-000001" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("run-000001");
    expect(dialog).toHaveTextContent(/\d+(\.\d+)? (B|KB|MB)/);
    expect(await ports.runs.get("run-000001")).toBeDefined(); // asking is not deleting
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await ports.runs.get("run-000001")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Delete run-000001" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete the run" }));
    await waitFor(() => expect(screen.queryByTestId("run-row-run-000001")).toBeNull());
    expect(await ports.runs.get("run-000001")).toBeUndefined();
    expect(await screen.findByTestId("storage-message")).toHaveTextContent("deleted run-000001");
  });

  it("the delete dialog is modal: focus moves into it and stays there, Escape cancels and gives the focus back", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    const opener = await screen.findByRole("button", { name: "Delete run-000001" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete the run" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(cancel).toHaveFocus();
    // Tab and Shift+Tab cycle inside the dialog: Cancel, Export first, Delete the run.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Export first" })).toHaveFocus();
    await userEvent.tab();
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
    // Focus sent elsewhere (a click on the page behind) comes back.
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(await ports.runs.get("run-000001")).toBeDefined();
  });

  it("does not offer to delete the run being recorded", async () => {
    setup({}, { currentRunId: "run-000001" });
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    const button = await screen.findByRole("button", { name: "Delete run-000001" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/being recorded/));
  });

  it("shows why a delete was refused", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    vi.spyOn(ports.runs, "delete").mockResolvedValue({ ok: false, error: { code: "unknown_run", message: "unknown run run-000001" } } as never);
    await userEvent.click(await screen.findByRole("button", { name: "Delete run-000001" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete the run" }));
    expect(await screen.findByTestId("storage-message")).toHaveTextContent("unknown run run-000001");
  });

  it("gives back the space deleted runs left when it opens, and still lists the runs if that fails", async () => {
    const compact = vi.fn(async () => ({ freedBytes: 4096, skipped: false }));
    const { ports } = setup({ compact });
    await screen.findByTestId("storage-mode");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(await ports.runs.list()).toEqual([]);
    const failing = vi.fn(async () => {
      throw new Error("busy");
    });
    setup({ compact: failing });
    await waitFor(() => expect(screen.getAllByTestId("storage-mode").length).toBe(2)); // the second browser lists its runs although compaction failed
    expect(failing).toHaveBeenCalled();
  });

  it("exports a run as JSON lines, and adds a run file as a new run (nothing is replaced)", async () => {
    const { admin, download } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    await userEvent.click(await screen.findByTestId("export-jsonl-run-000001"));
    await waitFor(() => expect(download).toHaveBeenCalledWith(new Uint8Array([6, 7]), "run-000001.agentsim.jsonl"));
    const file = new File([new Uint8Array([1, 2, 3])], "a-run.agentsim.jsonl");
    await userEvent.upload(screen.getByTestId("import-run-file"), file);
    await waitFor(() => expect(admin.importRun).toHaveBeenCalled());
    expect(await screen.findByTestId("storage-message")).toHaveTextContent("added a-run.agentsim.jsonl as run-000005 (it was run-000001)");
    expect(admin.importDb).not.toHaveBeenCalled();
  });

  it("says why a run file was rejected", async () => {
    setup({ importRun: vi.fn(async () => ({ ok: false as const, error: { code: "broken_recording" as const, message: "snapshot refers to a missing section" } })) });
    await userEvent.upload(await screen.findByTestId("import-run-file"), new File([new Uint8Array([1])], "bad.jsonl"));
    expect(await screen.findByTestId("storage-message")).toHaveTextContent("run file rejected (broken_recording): snapshot refers to a missing section");
  });

  it("shows usage against the quota as a gauge with the minimum quota marked, and warns when storage is not persistent", async () => {
    setup({ info: vi.fn(async () => ({ ...info, persisted: false })) });
    const meter = await screen.findByRole("meter", { name: "Usage against the quota" });
    expect(meter).toHaveAttribute("aria-valuenow", String(1e6));
    expect(meter).toHaveAttribute("aria-valuemax", String(1e9));
    expect(screen.getByTestId("quota-min-mark")).toBeInTheDocument();
    expect(screen.getByTestId("storage-persisted")).toHaveTextContent("▲");
  });

  it("labels every row action in words, and breaks a run's size down by kind of data", async () => {
    setup({}, {});
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    const row = await screen.findByTestId("run-row-run-000001");
    expect(row).toHaveTextContent("⭳ .sqlite");
    expect(row).toHaveTextContent("⭳ JSONL");
    expect(row).toHaveTextContent("✕ delete");
    expect(row.querySelectorAll(".size-bar i").length).toBeGreaterThan(0);
    expect(row.querySelector(".size-bar")).toHaveAttribute("aria-label", expect.stringMatching(/records/));
  });

  it("the delete dialog offers to export the run first: the file is saved and the dialog stays", async () => {
    const { download } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete run-000001" }));
    await userEvent.click(await screen.findByRole("button", { name: "Export first" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(new Uint8Array([4]), "run-000001.sqlite"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("marks a derived run with its parent and its verdict", async () => {
    const { ports } = setup();
    await userEvent.click(await screen.findByTestId("create-sample-run"));
    await ports.runs.create({
      runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "window 5.0–9.0 s of run-000001", status: "completed", recording: "none",
      derived: { parentRunId: "run-000001", t0S: 5, t1S: 9, startTick: 49, endTick: 90, status: "divergent", checkpointsChecked: 3, divergence: { tick: 60, expected: "aaaaaaaa", actual: "bbbbbbbb" }, copies: 0 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const mark = await screen.findByTestId("derived-run-000002");
    expect(mark).toHaveTextContent("of run-000001");
    expect(mark).toHaveTextContent("✕ divergent @60");
    expect(screen.queryByTestId("derived-run-000001")).toBeNull();
  });
});
