import type { RunSizes, RunSummary, StorageClient, StorageInfo } from "@agentsim/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadBytes } from "../download.ts";
import { formatBytes } from "../format.ts";

export interface StorageBrowserProps {
  readonly client: Pick<StorageClient, "ports" | "admin">;
  /** Called after an import replaces the database. */
  readonly onImported?: () => void;
  readonly download?: (bytes: Uint8Array, filename: string) => void;
  readonly nowWallMs?: () => number;
  /** The run being recorded: it cannot be deleted (ADR-0035 addition of 2026-10-17, item 7). */
  readonly currentRunId?: string | undefined;
  /** Shows a recorded run in the panels, read from storage. Offered for runs that were recorded; the others say why not. */
  readonly onReplay?: ((runId: string) => void) | undefined;
}

const totalBytes = (s: RunSizes): number => s.records.bytes + s.blobs.bytes + s.snapshots.bytes + s.beliefFrames.bytes;

/** What a run holds, as the browser lists it: count and size of each kind of data. */
function holds(s: RunSizes): string {
  const part = (name: string, e: { count: number; bytes: number }) => `${name} ${e.count} · ${formatBytes(e.bytes)}`;
  return [part("records", s.records), part("blobs", s.blobs), part("snapshots", s.snapshots), part("belief frames", s.beliefFrames)].join(" · ");
}

/** Storage browser (UI-SPEC §4, ADR-0010): runs, size, quota, export/import of `.sqlite`. */
export function StorageBrowser(props: StorageBrowserProps) {
  const { client, download = downloadBytes, nowWallMs = Date.now } = props;
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sizes, setSizes] = useState<Record<string, RunSizes>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // The delete dialog is modal: the focus goes to its safe choice, cannot leave it, Escape cancels and the focus goes back to where it was.
  useEffect(() => {
    if (confirming === null) return;
    const opener = document.activeElement;
    cancelButton.current?.focus();
    const onFocusIn = (e: FocusEvent) => {
      if (dialog.current && e.target instanceof Node && !dialog.current.contains(e.target)) cancelButton.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(null);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [confirming]);
  /** Tab and Shift+Tab cycle among the dialog's buttons. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const runFileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [r, i] = await Promise.all([client.ports.runs.list(), client.admin.info()]);
    const sz = await Promise.all(r.map(async (x) => [x.runId, await client.ports.runs.sizes(x.runId)] as const));
    setRuns(r);
    setInfo(i);
    setSizes(Object.fromEntries(sz.flatMap(([id, v]) => (v ? [[id, v] as const] : []))));
  }, [client]);

  useEffect(() => {
    // Opening the browser is a moment to give back what deleted runs left in the file, if nothing is recording (the worker checks).
    void (async () => {
      try {
        await client.admin.compact();
      } catch {
        // Compaction is housekeeping: a failure here is not the browser's.
      }
      await refresh();
    })();
  }, [client, refresh]);

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "ok", text });
      await refresh();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const createSampleRun = () =>
    act(async () => {
      const runId = await client.ports.runs.allocateRunId();
      const now = nowWallMs();
      const created = await client.ports.runs.create({ runId, schemaVersion: 0, createdAtWallMs: now, label: "sample run", status: "completed" });
      if (!created.ok) throw new Error(created.error.message);
      const records = Array.from({ length: 100 }, (_, seq) => ({
        id: `${runId}#${seq}`, runId, seq, simTime: seq * 0.1, wallTime: now, source: "world/sim", kind: "event" as const, payload: { sample: true, seq },
      }));
      const appended = await client.ports.trace.append(records);
      if (!appended.ok) throw new Error(appended.error.message);
      await client.ports.trace.flush();
      return `created ${runId} with ${records.length} records`;
    });

  const exportAll = () =>
    act(async () => {
      const bytes = await client.admin.exportDb();
      download(bytes, "agentsim.sqlite");
      return `exported ${formatBytes(bytes.byteLength)}`;
    });

  const exportJsonl = (runId: string) =>
    act(async () => {
      const r = await client.admin.exportRunJsonl(runId);
      if (!r.ok) throw new Error(r.error.message);
      download(r.value, `${runId}.agentsim.jsonl`);
      return `exported ${runId} as ${formatBytes(r.value.byteLength)} of JSON lines`;
    });

  /** A run file (JSON lines or a per-run .sqlite) is ADDED as a new run; the database is not replaced. */
  const importRunFile = (file: File) =>
    act(async () => {
      const r = await client.admin.importRun(new Uint8Array(await file.arrayBuffer()));
      if (!r.ok) throw new Error(`run file rejected (${r.error.code}): ${r.error.message}`);
      return `added ${file.name} as ${r.value.runId} (it was ${r.value.importedFrom})`;
    });

  const exportOne = (runId: string) =>
    act(async () => {
      const r = await client.admin.exportRun(runId);
      if (!r.ok) throw new Error(r.error.message);
      download(r.value, `${runId}.sqlite`);
      return `exported ${runId}`;
    });

  /** Deletes a run and everything it owns, the way to free space (the dialog named it and its size first). */
  const deleteRun = (runId: string) =>
    act(async () => {
      setConfirming(null);
      const r = await client.ports.runs.delete(runId);
      if (!r.ok) throw new Error(r.error.message);
      return `deleted ${runId}`;
    });

  const importFile = (file: File) =>
    act(async () => {
      const r = await client.admin.importDb(new Uint8Array(await file.arrayBuffer()));
      if (!r.ok) throw new Error(`import rejected (${r.error.code}): ${r.error.message}`);
      props.onImported?.();
      return `imported ${file.name}`;
    });

  return (
    <div className="panel" data-testid="storage-browser">
      <h3>Storage</h3>
      {info && (
        <dl className="kv" data-testid="storage-info">
          <dt>mode</dt>
          <dd data-testid="storage-mode">{info.mode}</dd>
          <dt>database</dt>
          <dd>{formatBytes(info.dbFileBytes)} · SQLite {info.sqliteVersion} · schema v{info.schemaVersion}</dd>
          <dt>usage / quota</dt>
          <dd>
            {formatBytes(info.usageBytes)} / {formatBytes(info.quotaBytes)}
          </dd>
          <dt>persistent</dt>
          <dd>{info.persisted === null ? "unknown" : info.persisted ? "yes" : "no (may be evicted)"}</dd>
          <dt>min. quota</dt>
          <dd>{formatBytes(info.quotaThresholdBytes)}</dd>
        </dl>
      )}
      <div className="row">
        <button className="btn" disabled={busy} onClick={createSampleRun} data-testid="create-sample-run">
          Create sample run
        </button>
        <button className="btn" disabled={busy} onClick={exportAll} data-testid="export-db">
          ⭳ Export .sqlite
        </button>
        <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="import-db">
          ⭱ Import .sqlite
        </button>
        <button className="btn" disabled={busy} onClick={() => runFileInput.current?.click()} data-testid="import-run" title="Add the run of a .jsonl or per-run .sqlite file as a new run">
          ⭱ Import run
        </button>
        <input
          ref={runFileInput}
          type="file"
          accept=".jsonl,.sqlite,.sqlite3,.db,application/jsonl,application/x-ndjson"
          hidden
          data-testid="import-run-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importRunFile(f);
          }}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3"
          hidden
          data-testid="import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFile(f);
          }}
        />
        <button className="btn" disabled={busy} onClick={() => void refresh()} aria-label="Refresh">
          ⟳
        </button>
      </div>
      {message && (
        <p role="status" data-testid="storage-message" className={message.kind === "error" ? "danger" : "muted"}>
          {message.kind === "error" ? "✗ " : "✓ "}
          {message.text}
        </p>
      )}
      <table className="grid" data-testid="runs-table">
        <thead>
          <tr>
            <th>run</th>
            <th>label</th>
            <th>status</th>
            <th>records</th>
            <th>holds</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} data-testid={`run-row-${r.runId}`}>
              <td>{r.runId}</td>
              <td>{r.label}</td>
              <td>{r.status}</td>
              <td>{r.recordCount}</td>
              <td className="muted" data-testid={`run-size-${r.runId}`}>
                {sizes[r.runId] ? holds(sizes[r.runId] as RunSizes) : "…"}
              </td>
              <td>
                {props.onReplay && (
                  <button
                    className="btn"
                    disabled={busy || r.recording !== "stored"}
                    title={r.recording === "stored" ? "Replay this run from storage" : r.recording === "none" ? "This run was not recorded: there is nothing to replay" : "This run was stored before recording existed: there is nothing to replay"}
                    onClick={() => props.onReplay?.(r.runId)}
                    aria-label={`Replay ${r.runId}`}
                    data-testid={`replay-${r.runId}`}
                  >
                    ▶
                  </button>
                )}
                <button className="btn" disabled={busy} onClick={() => exportOne(r.runId)} aria-label={`Export ${r.runId}`}>
                  ⭳
                </button>
                <button className="btn" disabled={busy} onClick={() => exportJsonl(r.runId)} aria-label={`Export ${r.runId} as JSON lines`} title="Export as a JSON-lines file" data-testid={`export-jsonl-${r.runId}`}>
                  ⭳ jsonl
                </button>
                <button
                  className="btn"
                  disabled={busy || r.runId === props.currentRunId}
                  title={r.runId === props.currentRunId ? "This run is being recorded" : "Delete this run and everything it holds"}
                  onClick={() => setConfirming(r.runId)}
                  aria-label={`Delete ${r.runId}`}
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No runs stored yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {confirming !== null && (
        <div ref={dialog} role="alertdialog" aria-modal="true" aria-label={`Delete ${confirming}`} className="panel" data-testid="delete-run-dialog" onKeyDown={trapTab}>
          <p>
            Delete {confirming} ({sizes[confirming] ? formatBytes(totalBytes(sizes[confirming] as RunSizes)) : "size unknown"})? Its records, snapshots, blobs and belief frames go with it, and it cannot
            be restored.
          </p>
          <div className="row">
            <button ref={cancelButton} className="btn" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void deleteRun(confirming)}>
              Delete the run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
