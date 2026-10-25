import "../panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SQL_LIMITS, type SqlError, type SqlResult, type SqlSchema } from "@agentsim/storage";
import { downloadBytes, formatBytes, ROW_PX } from "@agentsim/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { loadSnippets, storeSnippets, withoutSnippet, withSnippet, type SqlSnippet } from "../../config/sql-snippets.ts";
import { loadSchemaOpen, storeSchemaOpen } from "../../config/sql-schema-open.ts";
import { useAppActions, useServices } from "../../services.tsx";
import { complete, type Completion } from "./sql-complete.ts";
import { toCsv, toJsonl } from "./sql-export.ts";
import { cellText, columnWidths } from "./sql-grid.ts";
import { highlightSql } from "./sql-highlight.ts";
import { pinSqlResult } from "./sql-pinned.ts";

const EXAMPLE = "SELECT kind, count(*) AS n FROM trace_records GROUP BY kind ORDER BY n DESC";

type Outcome = { readonly kind: "result"; readonly result: SqlResult } | { readonly kind: "error"; readonly error: SqlError } | undefined;

/**
 * The SQL console of the Data workspace (UI-SPEC section 7): one read-only statement at a time against the whole database, with completion from the schema and from the
 * payloads, a virtualized result, export of the result and saved statements. It cannot write: the storage worker refuses every statement that is not a read (see
 * `sql-console.ts` in the storage package for how and why), and it does not read `user_data`.
 */
export function SqlConsolePanel() {
  const { storage } = useServices();
  const [sql, setSql] = useState(EXAMPLE);
  const [maxRows, setMaxRows] = useState(String(SQL_LIMITS.defaultRows));
  const [timeoutS, setTimeoutS] = useState(String(SQL_LIMITS.defaultTimeoutMs / 1000));
  const [schema, setSchema] = useState<SqlSchema | undefined>(undefined);
  // The schema tree is open unless the researcher closed it, which is remembered per user in `user_data`.
  const [showSchema, setShowSchema] = useState(true);
  useEffect(() => {
    let off = false;
    void loadSchemaOpen(storage.ports.userData).then((open) => !off && open !== undefined && setShowSchema(open), () => undefined);
    return () => {
      off = true;
    };
  }, [storage]);
  // The schema as a tree: database, tables (with their row counts), columns (with their types). A click on a table runs a read-only preview of its first rows; the counts are
  // read by one read-only statement through the same path as any other.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [previewRows, setPreviewRows] = useState<10 | 100>(10);
  // The table whose preview is in the results (and the statement that made it), and what the database is (its mode, schema version and size) for the root of the tree.
  const [previewOf, setPreviewOf] = useState<{ readonly table: string; readonly text: string } | undefined>(undefined);
  const [dbOpen, setDbOpen] = useState(true);
  const [dbInfo, setDbInfo] = useState<string | undefined>(undefined);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  useEffect(() => {
    if (!showSchema) return;
    void storage.admin?.info?.().then(
      (i) => setDbInfo(`${i.mode} \u00b7 schema v${i.schemaVersion} \u00b7 ${formatBytes(i.dbFileBytes)}`),
      () => undefined,
    );
  }, [showSchema, storage]);
  const [counts, setCounts] = useState<Readonly<Record<string, number | undefined>>>({});
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(undefined);
  const [open, setOpen] = useState<(Completion & { index: number }) | undefined>(undefined);
  const [snippets, setSnippets] = useState<SqlSnippet[]>([]);
  const [naming, setNaming] = useState(false);
  // The editor and the results share the panel (U-010 section 5): the editor a quarter of it by default, the border dragged or moved with the arrows; the results can fill the
  // panel (Esc returns) or be pinned in a window of their own that keeps them while the next statement is written.
  const [splitPct, setSplitPct] = useState(25);
  const [maximized, setMaximized] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const { openPanel } = useAppActions();
  const job = useRef<{ cancel(): Promise<void> } | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  /** The pending close of the completion list after the editor lost focus (a moment, so a click on an item still lands): cleared when the panel goes. */
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  /** Where the caret goes after the text was replaced by a completion or an inserted name. */
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !editor.current) return;
    editor.current.focus();
    editor.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [sql]);

  const refreshSchema = useCallback(() => {
    void storage.sql.schema().then(setSchema, () => undefined);
  }, [storage]);
  useEffect(() => {
    refreshSchema();
    let off = false;
    void loadSnippets(storage.ports.userData).then((l) => !off && setSnippets(l));
    return () => {
      off = true;
    };
  }, [storage, refreshSchema]);

  const tableList = (schema?.tables ?? []).filter((t) => t.readable).map((t) => t.name).join(",");
  const countTables = useCallback(() => {
    const names = tableList === "" ? [] : tableList.split(",");
    if (names.length === 0) return;
    const statement = names.map((n) => `SELECT '${n}' AS t, count(*) AS n FROM "${n.replace(/"/g, '""')}"`).join(" UNION ALL ");
    void storage.sql.run(statement, { maxRows: 200, timeoutMs: 5000 }).result.then(
      (r) => {
        if (!r.ok) return;
        const next: Record<string, number> = {};
        for (const row of r.value.rows) next[String(row[0])] = Number(row[1]);
        setCounts(next);
      },
      () => undefined,
    );
  }, [storage, tableList]);
  useEffect(() => {
    if (showSchema) countTables();
  }, [showSchema, countTables]);

  const run = async (statement?: string) => {
    if (running) return;
    const text = statement ?? sql;
    if (statement === undefined) setPreviewOf(undefined);
    const rows = Number(maxRows);
    const ms = Math.round(Number(timeoutS) * 1000);
    setOpen(undefined);
    setRunning(true);
    setOutcome(undefined);
    const j = storage.sql.run(text, { maxRows: rows, timeoutMs: ms });
    job.current = j;
    try {
      const r = await j.result;
      setOutcome(r.ok ? { kind: "result", result: r.value } : { kind: "error", error: r.error });
    } catch (e) {
      setOutcome({ kind: "error", error: { code: "failed", message: e instanceof Error ? e.message : String(e) } });
    } finally {
      job.current = undefined;
      setRunning(false);
      refreshSchema();
    }
  };
  const cancel = () => void job.current?.cancel();

  const accept = (item: string) => {
    const el = editor.current;
    if (!open || !el) return;
    const cursor = el.selectionStart;
    const next = `${sql.slice(0, open.from)}${item}${sql.slice(cursor)}`;
    caret.current = open.from + item.length; // applied as the text is, not a frame later: the researcher goes on typing at once
    setSql(next);
    setOpen(undefined);
  };
  const onChange = (value: string, cursor: number) => {
    setSql(value);
    if (!schema) return setOpen(undefined);
    const c = complete(value, cursor, schema);
    setOpen(c.items.length > 0 ? { ...c, index: 0 } : undefined);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = open.items.length;
      setOpen({ ...open, index: (open.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      accept(open.items[open.index] as string);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(undefined);
    }
  };

  const persist = (next: SqlSnippet[]) => {
    setSnippets(next);
    void storeSnippets(storage.ports.userData, next);
  };
  const result = outcome?.kind === "result" ? outcome.result : undefined;
  const download = (kind: "csv" | "jsonl") => {
    if (!result) return;
    const text = kind === "csv" ? toCsv(result) : toJsonl(result);
    downloadBytes(new TextEncoder().encode(text), `query.${kind}`, kind === "csv" ? "text/csv" : "application/x-ndjson");
  };
  /** A read-only preview of the first rows of a table: the statement is shown in the editor and runs like any other (the same path, never `user_data`). */
  const previewTable = (name: string, limit: 10 | 100 = previewRows) => {
    setPreviewRows(limit);
    const text = `SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT ${limit}`;
    setSql(text);
    setOpen(undefined);
    setPreviewOf({ table: name, text });
    void run(text);
  };
  const insertName = (name: string) => {
    const el = editor.current;
    const at = el?.selectionStart ?? sql.length;
    caret.current = at + name.length;
    setSql(`${sql.slice(0, at)}${name}${sql.slice(at)}`);
  };

  return (
    <div className="panel sql-console" data-testid="sql-console">
      <div className="sql-bar mono">
        <button type="button" className="kt" aria-pressed={showSchema} onClick={() => {
            setShowSchema(!showSchema);
            void storeSchemaOpen(storage.ports.userData, !showSchema).catch(() => undefined);
          }} data-testid="sql-schema-toggle">
          schema
        </button>
        <span className="ps">sql</span>
        <span className="pf">read-only</span>
        <label className="sql-limit">
          rows ≤
          <input className="log-filter mono" value={maxRows} onChange={(e) => setMaxRows(e.target.value)} inputMode="numeric" aria-label="Row limit" data-testid="sql-max-rows" />
        </label>
        <label className="sql-limit">
          timeout s
          <input className="log-filter mono" value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} inputMode="decimal" aria-label="Timeout in seconds" data-testid="sql-timeout" />
        </label>
        <span className="sp" />
        <select
          className="kt"
          value=""
          aria-label="Saved statements"
          data-testid="sql-snippets"
          onChange={(e) => {
            const s = snippets.find((x) => x.name === e.target.value);
            if (s) {
              setSql(s.sql);
              setOpen(undefined);
            }
          }}
        >
          <option value="">saved statements ▾</option>
          {snippets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        {naming ? (
          <input
            className="kt mono"
            autoFocus
            aria-label="Name of the statement"
            placeholder="name, Enter to save"
            maxLength={40}
            data-testid="sql-snippet-name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                persist(withSnippet(snippets, (e.target as HTMLInputElement).value, sql));
                setNaming(false);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setNaming(false);
              }
            }}
            onBlur={() => setNaming(false)}
          />
        ) : (
          <button type="button" className="kt" disabled={sql.trim() === ""} onClick={() => setNaming(true)} data-testid="sql-snippet-save">
            save
          </button>
        )}
        {snippets.some((s) => s.sql === sql) && (
          <button type="button" className="kt" onClick={() => persist(withoutSnippet(snippets, snippets.find((s) => s.sql === sql)?.name ?? ""))} data-testid="sql-snippet-delete">
            unsave
          </button>
        )}
      </div>
      <div className="sql-body">
        {showSchema && schema && (
        <div className="sql-schema mono" data-testid="sql-schema" role="tree" aria-label="The database">
          <div className="sql-tree-head">
            <button type="button" className="tt-node sql-twist" onClick={() => setDbOpen((o) => !o)} aria-expanded={dbOpen} aria-label="The database: open or fold" data-testid="sql-db-twist">
              {dbOpen ? "\u25be" : "\u25b8"}
            </button>
            <span data-testid="sql-db" title={`database ${dbInfo ?? ""}`}>
              database <span className="muted">{dbInfo ?? ""}</span>
            </span>
            <button type="button" className="kt" onClick={countTables} aria-label="Count the rows of the tables again" data-testid="sql-recount">
              ⟳
            </button>
          </div>
          {dbOpen &&
            schema.tables.map((t) => (
              <div key={t.name} className="sql-table" role="treeitem" aria-expanded={t.readable ? expanded.has(t.name) : undefined}>
                {t.readable ? (
                  <div className="sql-trow">
                    <button type="button" className="tt-node sql-twist" onClick={() => setExpanded((s) => new Set(s.has(t.name) ? [...s].filter((x) => x !== t.name) : [...s, t.name]))} aria-label={`Columns of ${t.name}`} data-testid={`sql-twist-${t.name}`}>
                      {expanded.has(t.name) ? "\u25be" : "\u25b8"}
                    </button>
                    <button
                      type="button"
                      className="tt-node sql-tname"
                      // A click previews the table; a double click puts its name in the editor (the click is held a moment so that a double click does not also run a preview).
                      onClick={() => {
                        clearTimeout(clickTimer.current);
                        clickTimer.current = setTimeout(() => void previewTable(t.name), 220);
                      }}
                      onDoubleClick={() => {
                        clearTimeout(clickTimer.current);
                        insertName(t.name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          clearTimeout(clickTimer.current);
                          void previewTable(t.name);
                        } else if (e.key === "i") insertName(t.name);
                      }}
                      title={`Click: preview the first ${previewRows} rows of ${t.name} (read-only) \u00b7 double click: insert its name`}
                      data-testid={`sql-table-${t.name}`}
                    >
                      {t.name}
                    </button>
                    <span className="muted sql-count" data-testid={`sql-count-${t.name}`}>
                      {counts[t.name] === undefined ? "\u2026" : `${counts[t.name]?.toLocaleString("en")} rows`}
                    </span>
                  </div>
                ) : (
                  <div className="sql-trow">
                    <button type="button" className="tt-node sql-tname" disabled title="not readable in the console">
                      {t.name}
                      {"  (not readable here)"}
                    </button>
                  </div>
                )}
                {t.readable &&
                  expanded.has(t.name) &&
                  t.columns.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      className="tt-node sql-col"
                      role="treeitem"
                      onDoubleClick={() => insertName(c.name)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), insertName(c.name))}
                      title={`Double click or Enter: insert ${c.name}${c.indexed ? " \u00b7 indexed" : ""}`}
                      data-testid={`sql-col-${t.name}-${c.name}`}
                    >
                      {c.name} <span className="muted">{c.type.toLowerCase()}</span>
                      {c.indexed ? (
                        <span className="sql-ix" title="indexed" aria-label="indexed">
                          {" "}
                          ●
                        </span>
                      ) : null}
                    </button>
                  ))}
              </div>
            ))}
        </div>
        )}
      <div className="sql-split-host" ref={body} data-maximized={maximized}>
        <div className="sql-top" style={maximized ? { display: "none" } : { flex: `0 0 ${splitPct}%` }}>
        <div className="sql-main">
        <div className="sql-editor-wrap">
            <div className="sql-stack">
              {/* The colours are drawn behind the text area, whose own text is transparent: the caret, the selection and the keys stay the browser's. */}
              <pre ref={painted} className="sql-hl mono" aria-hidden="true" data-testid="sql-highlight">
                {highlightSql(sql).map((t, i) => (
                  <span key={i} className={t.kind === "plain" ? undefined : `sq-${t.kind}`}>
                    {t.text}
                  </span>
                ))}
                {"\n"}
              </pre>
              <textarea
                ref={editor}
                className="sql-editor mono"
                value={sql}
                spellCheck={false}
                onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
                onKeyDown={onKeyDown}
                onScroll={(e) => {
                  if (painted.current) painted.current.scrollTop = e.currentTarget.scrollTop;
                }}
                onBlur={() => {
                  clearTimeout(closing.current);
                  closing.current = setTimeout(() => setOpen(undefined), 120);
                }}
                aria-label="SQL statement"
                data-testid="sql-editor"
              />
            </div>
            {open && (
              <ul className="sql-complete mono" role="listbox" aria-label="Completions" data-testid="sql-complete">
                {open.items.map((item, i) => (
                  <li key={item} role="option" aria-selected={i === open.index} className={i === open.index ? "on" : ""} data-testid="sql-complete-item" onMouseDown={(e) => (e.preventDefault(), accept(item))}>
                    {item}
                  </li>
                ))}
              </ul>
            )}
            <div className="sql-actions">
              <button type="button" className="btn pri tip-up" disabled={running || sql.trim() === ""} onClick={() => void run()} data-testid="sql-run" data-tip="Run · Ctrl+Enter">
                Run
              </button>
              <button type="button" className="btn" disabled={!running} onClick={cancel} data-testid="sql-cancel">
                Cancel
              </button>
            </div>
          </div>
        </div>
        </div>
        {!maximized && (
          <div
            className="sql-sash"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Editor and results: drag or use the arrow keys"
            aria-valuenow={splitPct}
            aria-valuemin={10}
            aria-valuemax={80}
            tabIndex={0}
            data-testid="sql-sash"
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (e.buttons !== 1 || !body.current) return;
              const box = body.current.getBoundingClientRect();
              setSplitPct(Math.round(Math.max(10, Math.min(80, ((e.clientY - box.top) / box.height) * 100))));
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") setSplitPct((v) => Math.max(10, v - 5));
              else if (e.key === "ArrowDown") setSplitPct((v) => Math.min(80, v + 5));
              else return;
              e.preventDefault();
            }}
          />
        )}
        <div className="sql-results" data-testid="sql-results" onKeyDown={(e) => e.key === "Escape" && maximized && (e.stopPropagation(), setMaximized(false))}>
          <div className="sql-res-head">
            <Status running={running} outcome={outcome} limit={maxRows} />
            {previewOf !== undefined && result !== undefined && (
              <span className="sql-preview-note mono" data-testid="sql-preview-note">
                preview · {result.rows.length} of {counts[previewOf.table]?.toLocaleString("en") ?? "?"} rows
                {previewRows === 10 && (counts[previewOf.table] ?? 11) > 10 && (
                  <button type="button" className="kt" onClick={() => previewTable(previewOf.table, 100)} data-testid="sql-show-100">
                    show 100
                  </button>
                )}
              </span>
            )}
            <span className="sp" />
            <button type="button" className="kt" disabled={!result} onClick={() => download("csv")} data-testid="sql-export-csv">
              CSV
            </button>
            <button type="button" className="kt" disabled={!result} onClick={() => download("jsonl")} data-testid="sql-export-jsonl">
              JSONL
            </button>
            <button type="button" className="kt" aria-pressed={maximized} onClick={() => setMaximized((m) => !m)} aria-label={maximized ? "Restore the editor (Esc)" : "Maximize the results"} data-tip={maximized ? "Back to the editor and the results · Esc" : "The results fill the panel"} data-testid="sql-maximize">
              □
            </button>
            <button
              type="button"
              className="kt tip-right"
              disabled={!result}
              onClick={() => {
                if (!result) return;
                pinSqlResult(result, sql);
                openPanel("sqlResult");
              }}
              aria-label="Open the results in a window"
              data-tip="A window with these results that stays while you write the next statement"
              data-testid="sql-window"
            >
              ⧉
            </button>
          </div>
          {result && <Grid result={result} />}
          {outcome === undefined && !running && (
            <div className="sql-empty mono" data-testid="sql-empty">
              <span>No result yet</span>
              <span className="muted">Write a read-only statement and run it (Ctrl+Enter), or click a table in the tree to preview its first 10 rows.</span>
              <button type="button" className="btn pri" onClick={() => void run(sql)} disabled={sql.trim() === ""} data-testid="sql-empty-run">
                Run the statement above
              </button>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function Status(props: { running: boolean; outcome: Outcome; limit: string }) {
  const { running, outcome, limit } = props;
  if (running) {
    return (
      <div className="sql-status mono muted" data-testid="sql-status">
        running…
      </div>
    );
  }
  if (outcome?.kind === "error") {
    return (
      <div className="sql-status mono danger" role="alert" data-testid="sql-error" data-code={outcome.error.code}>
        ✕ {outcome.error.code.replace(/_/g, " ")}: {outcome.error.message}
      </div>
    );
  }
  if (outcome?.kind === "result") {
    const r = outcome.result;
    return (
      <div className="sql-status mono" data-testid="sql-status">
        <span className="ok">✓</span> {r.rows.length} {r.rows.length === 1 ? "row" : "rows"} · {r.elapsedMs.toFixed(0)} ms · limit {limit}
        {r.truncated && <span className="warn"> · ▲ stopped at the row limit: there are more</span>}
        {r.cellsCut && <span className="muted"> · long cells are cut</span>}
      </div>
    );
  }
  return (
    <div className="sql-status mono muted" data-testid="sql-status">
      Ctrl+Enter runs · one read-only statement · user_data is not readable here
    </div>
  );
}

export function Grid(props: { result: SqlResult }) {
  const { columns, rows } = props.result;
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX.compact, overscan: 12 });
  // Columns are as wide as their content (in characters), left to right, with the panel's width left over at the right: a short result is not stretched across it.
  const widths = columnWidths(props.result);
  const template = widths.map((w) => `${w}ch`).join(" ");
  const minWidth = `calc(${widths.reduce((a, b) => a + b, 0)}ch + ${widths.length * 8 + 20}px)`;
  return (
    <div className="sql-grid" ref={scroller} role="table" aria-label="Result" aria-rowcount={rows.length + 1} data-testid="sql-grid" data-rows={rows.length}>
      <div style={{ minWidth }}>
        <div className="sql-head mono" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c, i) => (
            <span key={`${c}-${i}`} role="columnheader" title={c} className={typeof rows[0]?.[i] === "number" ? "num" : ""}>
              {c}
            </span>
          ))}
        </div>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((it) => (
            <div
              key={it.index}
              role="row"
              data-testid={`sql-row-${it.index}`}
              className={`sql-row mono${it.index % 2 === 1 ? " zebra" : ""}`}
              style={{ position: "absolute", top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)`, gridTemplateColumns: template }}
            >
              {(rows[it.index] ?? []).map((v, i) => (
                <span key={i} role="cell" className={v === null ? "muted" : typeof v === "number" ? "num" : ""} title={cellText(v)}>
                  {cellText(v)}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
