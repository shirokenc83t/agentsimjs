import type { RunSummary, StorageClient, StorageInfo } from "@agentsim/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "../format.ts";

/** Triggers a browser download of `bytes` (UI edge; no storage access on the render path). */
export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/vnd.sqlite3"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface StorageBrowserProps {
  readonly client: Pick<StorageClient, "ports" | "admin">;
  /** Called after an import replaces the database. */
  readonly onImported?: () => void;
  readonly download?: (bytes: Uint8Array, filename: string) => void;
  readonly nowWallMs?: () => number;
}

/** Storage browser (UI-SPEC §4, ADR-0010): runs, size, quota, export/import of `.sqlite`. */
export function StorageBrowser(props: StorageBrowserProps) {
  const { client, download = downloadBytes, nowWallMs = Date.now } = props;
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [r, i] = await Promise.all([client.ports.runs.list(), client.admin.info()]);
    setRuns(r);
    setInfo(i);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const exportOne = (runId: string) =>
    act(async () => {
      const r = await client.admin.exportRun(runId);
      if (!r.ok) throw new Error(r.error.message);
      download(r.value, `${runId}.sqlite`);
      return `exported ${runId}`;
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
              <td>
                <button className="btn" disabled={busy} onClick={() => exportOne(r.runId)} aria-label={`Export ${r.runId}`}>
                  ⭳
                </button>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No runs stored yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
