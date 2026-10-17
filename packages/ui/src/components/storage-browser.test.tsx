import { createMemoryPorts, type StorageAdmin, type StorageInfo } from "@agentsim/storage";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StorageBrowser } from "./storage-browser.tsx";

const info: StorageInfo = {
  mode: "opfs-sahpool", sqliteVersion: "3.53.4", schemaVersion: 1, dbFileBytes: 4096, usageBytes: 1e6,
  quotaBytes: 1e9, persisted: true, quotaThresholdBytes: 256 * 1024 * 1024, warning: null,
};

function setup(adminOverrides: Partial<StorageAdmin> = {}) {
  const ports = createMemoryPorts();
  const admin: StorageAdmin = {
    info: vi.fn(async () => info),
    exportDb: vi.fn(async () => new Uint8Array([1, 2, 3])),
    exportRun: vi.fn(async () => ({ ok: true as const, value: new Uint8Array([4]) })),
    importDb: vi.fn(async () => ({ ok: true as const, value: undefined })),
    requestPersistence: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    ...adminOverrides,
  };
  const download = vi.fn();
  render(<StorageBrowser client={{ ports, admin }} download={download} nowWallMs={() => 1_700_000_000_000} />);
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
});
