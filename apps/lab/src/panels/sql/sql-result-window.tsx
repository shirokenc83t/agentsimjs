import "../panels.css";
import { Grid } from "./sql-console-panel.tsx";
import { usePinnedSqlResult } from "./sql-pinned.ts";

/**
 * The results of the SQL console in a window of their own (U-010 section 5): what was pinned from the console, kept while the next statement is written and run there. It says
 * the statement and what it returned; pinning another result replaces it.
 */
export function SqlResultWindow() {
  const pinned = usePinnedSqlResult();
  if (!pinned) {
    return (
      <div className="panel sql-pinned" data-testid="sql-pinned">
        <p className="muted tt-empty" data-testid="sql-pinned-empty">
          Nothing pinned: run a statement in the SQL console and choose the window button of its results.
        </p>
      </div>
    );
  }
  const r = pinned.result;
  return (
    <div className="panel sql-pinned" data-testid="sql-pinned">
      <div className="sql-status mono" data-testid="sql-pinned-status">
        <span className="ok">✓</span> {r.rows.length} {r.rows.length === 1 ? "row" : "rows"} · {r.elapsedMs.toFixed(0)} ms · {pinned.sql.replace(/\s+/g, " ").slice(0, 160)}
      </div>
      <Grid result={r} />
    </div>
  );
}
