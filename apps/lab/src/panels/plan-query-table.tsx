import "./panels.css";
import { ROW_PX, STATE_GLYPH, type StateName } from "@agentsim/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type KeyboardEvent } from "react";
import type { QueryRow, QueryStatus, SearchView } from "./plan-queries.ts";

/** Rows visible at once; the list scrolls beyond. */
const VISIBLE_ROWS = 8;

const STATUS_STATE: Readonly<Record<QueryStatus, StateName>> = { running: "run", found: "ok", interrupted: "warn", not_found: "alm", budget_exceeded: "alm" };

const plainRestarts = (r: QueryRow): number => r.restarts.filter((x) => !x.interrupted).length;
/** A condition value as shown: the trace keeps the exact number, the table 3 decimals (a click on the map is not exact to the micrometre). */
const shown = (v: number): string => String(Number.isFinite(v) ? Number(v.toFixed(3)) : v);
const tickSpan = (a: number | undefined, b: number | undefined): string => `${a ?? "?"}→${b ?? "…"}`;

function searchText(s: SearchView): string {
  const params = [s.weight !== undefined ? `w=${s.weight}` : undefined, `h=${s.heuristic}`, s.stageBudget !== undefined ? `stage budget ${s.stageBudget}` : undefined].filter((p) => p !== undefined).join(", ");
  return `${s.role} · ${s.algorithm} (${params}) · ${s.expansions} exp · ticks ${tickSpan(s.startedTick, s.endedTick)} · ${s.result}`;
}

/**
 * The agent's planning queries (UI-SPEC: Strategy query table): one line per query, newest last, virtualized
 * (ADR-0016). The selected query is expanded below the list: the branch taken at each condition with the values it saw,
 * each search with its role, parameters, expansions, ticks and result, restarts, and the legs of a lazy plan. State is
 * always glyph + text. Selection is reported, not owned: the Scene's stages overlay follows the same selection.
 */
export function PlanQueryTable(props: { rows: readonly QueryRow[]; selected: string | undefined; onSelect: (queryId: string) => void }) {
  const { rows, selected, onSelect } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const size = ROW_PX.comfortable;
  // `initialRect` gives the first render a window before the element is measured (and in tests, which cannot measure).
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => size, overscan: 6, initialRect: { width: 400, height: VISIBLE_ROWS * size } });
  const selectedIndex = rows.findIndex((r) => r.queryId === selected);
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : undefined;

  if (rows.length === 0) {
    return (
      <p className="muted" data-testid="plan-queries-empty">
        no planning queries yet
      </p>
    );
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(rows.length - 1, Math.max(0, (selectedIndex < 0 ? rows.length - 1 : selectedIndex) + (e.key === "ArrowDown" ? 1 : -1)));
    const r = rows[next];
    if (r) {
      onSelect(r.queryId);
      virtual.scrollToIndex(next, { align: "auto" });
    }
  };
  return (
    <div data-testid="plan-queries-block">
      <div
        ref={scroller}
        className="query-list"
        role="listbox"
        tabIndex={0}
        aria-label="Planning queries"
        data-testid="plan-queries"
        style={{ height: Math.min(rows.length, VISIBLE_ROWS) * size }}
        onKeyDown={onKey}
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((v) => {
            const r = rows[v.index];
            if (!r) return null;
            const state = STATUS_STATE[r.status];
            return (
              <div
                key={r.queryId}
                role="option"
                aria-selected={r.queryId === selected}
                data-testid={`plan-query-row-${r.queryId}`}
                className="query-row mono"
                onClick={() => onSelect(r.queryId)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }}
              >
                <span className={`st-${state}`}>
                  {STATE_GLYPH[state]} {r.status}
                </span>
                <span>{r.queryId}</span>
                <span>tick {tickSpan(r.submittedTick, r.completedTick)}</span>
                <span>{r.expansionsCharged === undefined ? "—" : `${r.expansionsCharged} exp`}</span>
                <span title="restarts">{plainRestarts(r) > 0 ? `↻${plainRestarts(r)}` : ""}</span>
                <span title="interruptions">{r.interruptions > 0 ? `⚡${r.interruptions}` : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
      {selectedRow && <QueryDetail row={selectedRow} />}
    </div>
  );
}

/** The expanded view of one query: its branches with the condition values, each search, restarts and lazy legs. */
export function QueryDetail({ row }: { row: QueryRow }) {
  const s = row.strategy;
  return (
    <div className="query-detail mono" data-testid="plan-query-detail">
      <div>
        {row.queryId} · {s ? `strategy:${s.id}@${s.version} #${s.hash}` : (row.algorithm ?? "plan in progress")}
      </div>
      {s?.selects.map((sel, i) => (
        <div key={i} data-testid={`plan-query-select-${i}`}>
          {sel.path} → {sel.branch}{" "}
          <span className="muted">
            {Object.entries(sel.values)
              .map(([k, v]) => `${k} = ${shown(v)}`)
              .join(", ")}
          </span>
        </div>
      ))}
      {s?.searches.map((x, i) => (
        <div key={i} data-testid={`plan-query-search-${i}`}>
          {x.path}: {searchText(x)}
        </div>
      ))}
      {s?.thinned && (
        <div className="muted">
          {s.thinned.legs} legs thinned to {s.thinned.kept}
        </div>
      )}
      {row.restarts.map((x, i) => (
        <div key={i} data-testid={`plan-query-restart-${i}`}>
          {x.interrupted ? "⚡ interrupted" : "↻ restart"} · {x.reason} · {x.spent} exp spent @ {x.simTimeS.toFixed(1)} s
        </div>
      ))}
      {row.legs.map((l, i) => (
        <div key={i} data-testid={`plan-query-leg-${i}`}>
          leg {l.index + 1}/{l.count} ready at tick {l.tick}
          {l.last ? " (last)" : ""}
        </div>
      ))}
    </div>
  );
}

/** The agent's effective planning strategy as a row of the Inspector's configuration section. */
export function StrategyRow(props: { strategy: { readonly id: string; readonly version: number; readonly hash: string; readonly root: unknown }; source: string }) {
  const { strategy } = props;
  return (
    <>
      <dt>planner</dt>
      <dd data-testid="inspector-strategy">
        <span className="mono">
          strategy:{strategy.id}@{strategy.version}
        </span>{" "}
        <span className="muted mono">#{strategy.hash}</span> <span className="source-tag">{props.source}</span>
        <details>
          <summary>tree</summary>
          <pre className="mono strategy-view" data-testid="inspector-strategy-tree">
            {JSON.stringify(strategy.root, null, 2)}
          </pre>
        </details>
      </dd>
    </>
  );
}
