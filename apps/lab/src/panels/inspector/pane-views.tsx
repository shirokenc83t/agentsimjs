import "../panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KIND_STYLE, ROW_PX, useUiContext } from "@agentsim/ui";
import type { StorageClient } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { useEffect, useMemo, useRef, useState } from "react";
import { LogList, type LogListHandle } from "../debug/log-list.tsx";
import { useLogRows } from "../debug/use-log-rows.ts";
import { useSeries, type SeriesLine } from "./use-series.ts";

// The three view types of the multi-log inspector (ADR-0035 section 7): a log, a table and a series. Each is a subscription: the same filter reads the history from storage and,
// for a run that is being recorded, tails it. Picking a record in any of them picks it for all (the shared record and the shared cursor).

export interface PaneViewProps {
  readonly storage: Pick<StorageClient, "ports" | "live">;
  readonly runId: string | undefined;
  readonly filter: string;
  /** The end of what is stored, in sim seconds. */
  readonly headS: number;
  /** Tail the run (Live) or read what is stored (Replay). */
  readonly tail: boolean;
  readonly viewId: string;
  readonly entityIds: readonly string[];
  /** A record was picked: the shared selection and the cursor go to it. */
  readonly onPick: (r: TraceRecord) => void;
  /** The cursor was set to a moment (a click on a series). */
  readonly onMoment: (tS: number) => void;
}

/** A log: the rows of the filter, the tail following unless the list is scrolled up. */
export function LogPane(p: PaneViewProps) {
  const [atEnd, setAtEnd] = useState(true);
  const paused = p.tail && !atEnd;
  const { rows, more, pending, loadMore, flush } = useLogRows({ storage: p.storage, runId: p.runId, filter: p.filter, headS: p.headS, tail: p.tail, paused, viewId: p.viewId });
  const list = useRef<LogListHandle>(null);
  const picked = useUiContext((s) => s.selectedRecord);
  const selectedSeq = picked !== undefined && picked.runId === p.runId ? picked.seq : undefined;
  useEffect(() => {
    if (p.tail && atEnd) list.current?.scrollToEnd();
  }, [rows.length, p.tail, atEnd]);
  return (
    <div className="pane-body" data-testid="pane-log" data-count={rows.length}>
      {paused && (
        <button
          type="button"
          className="kt pane-new"
          onClick={() => {
            flush();
            setAtEnd(true);
            requestAnimationFrame(() => list.current?.scrollToEnd());
          }}
        >
          ❚❚ {pending} new ↓
        </button>
      )}
      <LogList
        ref={list}
        rows={rows}
        more={more}
        onNeedMore={loadMore}
        entityIds={p.entityIds}
        selectedSeq={selectedSeq}
        expanded={new Set()}
        onSelect={p.onPick}
        onJump={p.onPick}
        onAtEnd={setAtEnd}
        label={`Log of ${p.filter === "" ? "everything" : p.filter}`}
        testId="pane-list"
      />
    </div>
  );
}

const FIXED = ["seq", "t", "agent", "kind", "source"] as const;
const MAX_PAYLOAD_COLUMNS = 5;

/** The columns of a table of records: the fixed ones, then the keys of the payloads that most rows have. */
export function tableColumns(rows: readonly TraceRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows.slice(0, 500)) {
    const pl = r.payload;
    if (pl !== null && typeof pl === "object" && !Array.isArray(pl)) for (const k of Object.keys(pl)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_PAYLOAD_COLUMNS).map(([k]) => k);
  return [...FIXED, ...keys];
}

const cellOf = (r: TraceRecord, col: string): string => {
  switch (col) {
    case "seq":
      return String(r.seq);
    case "t":
      return r.simTime.toFixed(2);
    case "agent":
      return r.agentId ?? "";
    case "kind":
      return r.kind;
    case "source":
      return r.source;
    default: {
      const v = (r.payload as Record<string, unknown> | null)?.[col];
      return v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  }
};

/** A table: the same records as columns, the payload's own keys beside the fixed ones. */
export function TablePane(p: PaneViewProps) {
  const { rows, more, loadMore } = useLogRows({ storage: p.storage, runId: p.runId, filter: p.filter, headS: p.headS, tail: p.tail, paused: false, viewId: p.viewId });
  const columns = useMemo(() => tableColumns(rows), [rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length + (more ? 1 : 0), getScrollElement: () => scroller.current, estimateSize: () => ROW_PX.compact, overscan: 12 });
  const items = virtual.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (last && last.index >= rows.length && more && rows.length > 0) loadMore();
  }, [last, rows.length, more]);
  useEffect(() => {
    if (p.tail && rows.length > 0) virtual.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, p.tail]);
  const picked = useUiContext((s) => s.selectedRecord);
  const template = `repeat(${columns.length}, minmax(70px, 1fr))`;
  return (
    <div className="pane-body" data-testid="pane-table" data-count={rows.length}>
      <div className="sql-grid" ref={scroller} role="table" aria-label="Table of records">
        <div style={{ minWidth: columns.length * 90 }}>
          <div className="sql-head mono" role="row" style={{ gridTemplateColumns: template }}>
            {columns.map((c) => (
              <span key={c} role="columnheader">
                {c}
              </span>
            ))}
          </div>
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {items.map((it) => {
              const r = rows[it.index];
              if (!r) return null;
              const sel = picked !== undefined && picked.runId === p.runId && picked.seq === r.seq;
              const style = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
              return (
                <div
                  key={r.seq}
                  role="row"
                  aria-selected={sel}
                  data-testid={`table-row-${r.seq}`}
                  data-seq={r.seq}
                  className={`sql-row selectable mono${it.index % 2 === 1 ? " zebra" : ""}`}
                  onClick={() => p.onPick(r)}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)`, gridTemplateColumns: template }}
                >
                  {columns.map((c) => (
                    <span key={c} role="cell" className={c === "kind" ? "tag" : ""} style={c === "kind" ? { color: `var(--kind-${style?.family ?? "slate"})` } : undefined} title={cellOf(r, c)}>
                      {cellOf(r, c)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const PAD = { l: 44, r: 8, t: 8, b: 18 };

/** The geometry of a series chart: the span in time, the range of values, and where a point goes. Pure. */
export function chartScale(lines: readonly SeriesLine[], headS: number, W = 600, H = 150): { t0: number; t1: number; v0: number; v1: number; x: (t: number) => number; y: (v: number) => number } {
  let t0 = Infinity;
  let t1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const l of lines) {
    for (const pt of l.points) {
      t0 = Math.min(t0, pt.t);
      t1 = Math.max(t1, pt.t);
      v0 = Math.min(v0, pt.v);
      v1 = Math.max(v1, pt.v);
    }
  }
  if (!Number.isFinite(t0)) [t0, t1, v0, v1] = [0, Math.max(1, headS), 0, 1];
  t1 = Math.max(t1, headS, t0 + 1e-6);
  if (v1 - v0 < 1e-9) [v0, v1] = [v0 - 0.5, v1 + 0.5];
  return { t0, t1, v0, v1, x: (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r), y: (v) => PAD.t + (1 - (v - v0) / (v1 - v0)) * (H - PAD.t - PAD.b) };
}

/** A series: the samples of a `metric:` filter as lines over sim time, the shared cursor drawn on them, a click setting it. */
export function SeriesPane(p: PaneViewProps) {
  const { lines, samples, capped } = useSeries({ storage: p.storage, runId: p.runId, filter: p.filter, tail: p.tail, viewId: p.viewId });
  const cursor = useUiContext((s) => s.simTime);
  // The chart is drawn in pixels (one unit is one pixel), so its text keeps the size of the chrome's whatever the pane's shape.
  const [size, setSize] = useState({ w: 600, h: 150 });
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, Math.round(el.clientWidth)), h: Math.max(70, Math.round(el.clientHeight)) }));
    ro.observe(el);
    setSize({ w: Math.max(200, Math.round(el.clientWidth)), h: Math.max(70, Math.round(el.clientHeight)) });
    return () => ro.disconnect();
  }, []);
  const { w: W, h: H } = size;
  const scale = useMemo(() => chartScale(lines, p.headS, W, H), [lines, p.headS, W, H]);
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = scale.t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (scale.t1 - scale.t0);
    if (t >= scale.t0 && t <= scale.t1) p.onMoment(Math.round(t * 10) / 10);
  };
  return (
    <div className="pane-body series" data-testid="pane-series" data-samples={samples} data-lines={lines.length}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} onClick={click} role="img" aria-label={`Series of ${p.filter}`} data-testid="series-chart">
        <line className="axis" x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} />
        <line className="axis" x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} />
        <text className="tick" x={4} y={PAD.t + 8}>
          {fmt(scale.v1)}
        </text>
        <text className="tick" x={4} y={H - PAD.b}>
          {fmt(scale.v0)}
        </text>
        <text className="tick" x={PAD.l} y={H - 3}>
          {scale.t0.toFixed(1)} s
        </text>
        <text className="tick" x={W - PAD.r} y={H - 3} textAnchor="end">
          {scale.t1.toFixed(1)} s
        </text>
        {lines.map((l, i) => (
          <polyline key={l.key} className="line" style={{ stroke: `var(--agent-${i % 8})` }} points={l.points.map((pt) => `${scale.x(pt.t).toFixed(1)},${scale.y(pt.v).toFixed(1)}`).join(" ")} data-testid={`series-line-${i}`} />
        ))}
        {cursor >= scale.t0 && cursor <= scale.t1 && <line className="cursor" x1={scale.x(cursor)} y1={PAD.t} x2={scale.x(cursor)} y2={H - PAD.b} data-testid="series-cursor" />}
      </svg>
      <ul className="legend mono">
        {lines.map((l, i) => (
          <li key={l.key}>
            <i style={{ background: `var(--agent-${i % 8})` }} /> {l.source} · {l.name} <span className="muted">· {l.points.length}</span>
          </li>
        ))}
        {lines.length === 0 && <li className="muted">no samples yet for this filter</li>}
        {capped && <li className="warn">the pane holds the first {samples} samples; narrow the filter or the run to see the rest</li>}
      </ul>
    </div>
  );
}

const fmt = (v: number): string => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : String(Math.round(v * 100) / 100));
