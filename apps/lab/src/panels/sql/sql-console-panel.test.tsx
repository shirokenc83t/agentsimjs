import { createMemoryPorts, type SqlError, type SqlResult, type SqlSchema, type StorageClient } from "@agentsim/storage";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Result } from "@agentsim/core";
import { ServicesProvider } from "../../services.tsx";
import type { RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { SqlConsolePanel } from "./sql-console-panel.tsx";

// The SQL console panel (UI-SPEC section 7): run, the limits it sends, what it shows of a result and of a refusal, cancel, completion and the saved statements.
// The executor and its guarantees are the storage package's tests; here only what the panel does with them.

const schema: SqlSchema = {
  tables: [
    { name: "trace_records", readable: true, columns: [{ name: "run_id", type: "TEXT" }, { name: "seq", type: "INTEGER" }, { name: "kind", type: "TEXT" }] },
    { name: "user_data", readable: false, columns: [] },
  ],
  payloadKeys: ["op"],
};
const result = (over: Partial<SqlResult> = {}): SqlResult => ({ columns: ["kind", "n"], rows: [["action", 12], ["event", 3], ["note", null]], truncated: false, cellsCut: false, elapsedMs: 4.2, ...over });

function setup(run: (sql: string, limits: unknown) => { result: Promise<Result<SqlResult, SqlError>>; cancel?: () => Promise<void> } = () => ({ result: Promise.resolve({ ok: true, value: result() }) })) {
  const ports = createMemoryPorts();
  const calls: { sql: string; limits: unknown }[] = [];
  const storage = {
    ports,
    sql: {
      run: (sql: string, limits: unknown) => {
        calls.push({ sql, limits });
        const j = run(sql, limits);
        return { jobId: "q1", result: j.result, cancel: j.cancel ?? (async () => undefined) };
      },
      schema: async () => schema,
    },
    status: () => ({ state: "ready", mode: "memory-fallback" }),
    onStatus: () => () => {},
  } as unknown as StorageClient;
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source: {} as RunSource, setReplaySource: () => {} }}>
      <SqlConsolePanel />
    </ServicesProvider>,
  );
  return { ports, calls };
}

describe("SqlConsolePanel", () => {
  it("runs the statement with the limits that are set, and shows the rows, their count and the time", async () => {
    const { calls } = setup();
    await userEvent.clear(screen.getByTestId("sql-max-rows"));
    await userEvent.type(screen.getByTestId("sql-max-rows"), "50");
    await userEvent.clear(screen.getByTestId("sql-timeout"));
    await userEvent.type(screen.getByTestId("sql-timeout"), "2.5");
    await userEvent.clear(screen.getByTestId("sql-editor"));
    await userEvent.type(screen.getByTestId("sql-editor"), "SELECT kind, count(*) AS n FROM trace_records");
    await userEvent.click(screen.getByTestId("sql-run"));
    await waitFor(() => expect(screen.getByTestId("sql-status")).toHaveTextContent("3 rows"));
    expect(calls).toEqual([{ sql: "SELECT kind, count(*) AS n FROM trace_records", limits: { maxRows: 50, timeoutMs: 2500 } }]);
    expect(screen.getByTestId("sql-status")).toHaveTextContent("4 ms");
    expect(screen.getByTestId("sql-grid")).toHaveAttribute("data-rows", "3");
  });

  it("Ctrl+Enter runs it", async () => {
    const { calls } = setup();
    await userEvent.click(screen.getByTestId("sql-editor"));
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(calls.length).toBe(1));
  });

  it("says when the row limit cut the result", async () => {
    setup(() => ({ result: Promise.resolve({ ok: true, value: result({ truncated: true }) }) }));
    await userEvent.click(screen.getByTestId("sql-run"));
    expect(await screen.findByTestId("sql-status")).toHaveTextContent("stopped at the row limit");
  });

  it("shows a refusal with its code and its reason, and no grid", async () => {
    setup(() => ({ result: Promise.resolve({ ok: false, error: { code: "not_read_only", message: "DELETE is not allowed: the console only reads" } }) }));
    await userEvent.click(screen.getByTestId("sql-run"));
    const err = await screen.findByTestId("sql-error");
    expect(err).toHaveAttribute("data-code", "not_read_only");
    expect(err).toHaveTextContent("DELETE is not allowed");
    expect(screen.queryByTestId("sql-grid")).toBeNull();
  });

  it("cancel stops a statement that is running: the run button waits, the cancel button asks", async () => {
    let release: (r: Result<SqlResult, SqlError>) => void = () => undefined;
    const cancel = vi.fn(async () => release({ ok: false, error: { code: "cancelled", message: "cancelled" } }));
    setup(() => ({ result: new Promise((r) => (release = r)), cancel }));
    expect(screen.getByTestId("sql-cancel")).toBeDisabled();
    await userEvent.click(screen.getByTestId("sql-run"));
    expect(screen.getByTestId("sql-run")).toBeDisabled();
    expect(screen.getByTestId("sql-status")).toHaveTextContent("running");
    await userEvent.click(screen.getByTestId("sql-cancel"));
    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByTestId("sql-error")).toHaveAttribute("data-code", "cancelled");
    expect(screen.getByTestId("sql-run")).not.toBeDisabled();
  });

  it("offers completions from the schema and takes one with Tab", async () => {
    setup();
    const editor = screen.getByTestId("sql-editor") as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByTestId("sql-schema-toggle")).toBeInTheDocument());
    await userEvent.clear(editor);
    await userEvent.type(editor, "SELECT * FROM tra");
    await waitFor(() => expect(screen.getAllByTestId("sql-complete-item").map((x) => x.textContent)).toEqual(["trace_records"]));
    await userEvent.keyboard("{Tab}");
    expect(editor.value).toBe("SELECT * FROM trace_records");
    expect(screen.queryByTestId("sql-complete")).toBeNull();
  });

  it("lists the schema, and the table that is not readable cannot be inserted", async () => {
    setup();
    await userEvent.click(screen.getByTestId("sql-schema-toggle"));
    const list = await screen.findByTestId("sql-schema");
    expect(list).toHaveTextContent("trace_records");
    expect(list).toHaveTextContent("user_data (not readable here)");
    expect(screen.getByRole("button", { name: /user_data/ })).toBeDisabled();
  });

  it("keeps the statements the researcher saves, and offers them again", async () => {
    const { ports } = setup();
    const editor = screen.getByTestId("sql-editor");
    await userEvent.clear(editor);
    await userEvent.type(editor, "SELECT 1");
    await userEvent.click(screen.getByTestId("sql-snippet-save"));
    await userEvent.type(screen.getByTestId("sql-snippet-name"), "one{Enter}");
    await waitFor(async () => expect(await ports.userData.get("sql", "snippets")).toEqual([{ name: "one", sql: "SELECT 1" }]));
    await userEvent.clear(editor);
    await userEvent.selectOptions(screen.getByTestId("sql-snippets"), "one");
    expect((editor as HTMLTextAreaElement).value).toBe("SELECT 1");
    await userEvent.click(screen.getByTestId("sql-snippet-delete"));
    await waitFor(async () => expect(await ports.userData.get("sql", "snippets")).toEqual([]));
  });

  it("shows the schema as a tree with the row count of each readable table, and the columns with their types when a table is opened", async () => {
    const { calls } = setup((sql) => ({ result: Promise.resolve({ ok: true, value: sql.includes("UNION ALL") || sql.includes("count(*) AS n FROM \"trace_records\"") ? result({ columns: ["t", "n"], rows: [["trace_records", 12345]] }) : result() }) }));
    await userEvent.click(screen.getByTestId("sql-schema-toggle"));
    await waitFor(() => expect(screen.getByTestId("sql-count-trace_records")).toHaveTextContent("12,345 rows"));
    // The counts are one read-only statement through the console's own path; user_data is not in it.
    expect(calls[0]?.sql).toContain('FROM "trace_records"');
    expect(calls[0]?.sql).not.toContain("user_data");
    expect(screen.queryByTestId("sql-column")).toBeNull();
    await userEvent.click(screen.getByTestId("sql-twist-trace_records"));
    expect(screen.getByTestId("sql-schema")).toHaveTextContent("seq integer");
    expect(screen.getByTestId("sql-schema")).toHaveTextContent("kind text");
  });

  it("a click on a table runs a read-only preview of its first 10 rows (100 on request), shown in the editor and the results; user_data has none", async () => {
    const { calls } = setup();
    await userEvent.click(screen.getByTestId("sql-schema-toggle"));
    await screen.findByTestId("sql-table-trace_records");
    await userEvent.click(screen.getByTestId("sql-table-trace_records"));
    await waitFor(() => expect(screen.getByTestId("sql-status")).toHaveTextContent("3 rows"));
    expect(calls.at(-1)?.sql).toBe('SELECT * FROM "trace_records" LIMIT 10');
    expect((screen.getByTestId("sql-editor") as HTMLTextAreaElement).value).toBe('SELECT * FROM "trace_records" LIMIT 10');
    await userEvent.selectOptions(screen.getByTestId("sql-preview-rows"), "100");
    await userEvent.click(screen.getByTestId("sql-table-trace_records"));
    await waitFor(() => expect(calls.at(-1)?.sql).toBe('SELECT * FROM "trace_records" LIMIT 100'));
    expect(screen.queryByTestId("sql-table-user_data")).toBeNull();
    expect(screen.getByRole("button", { name: /user_data/ })).toBeDisabled();
  });
});
