import "../panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { identityOf, KIND_STYLE, ROW_PX } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { copyOfRecord } from "./derived-tag.tsx";
import { resultOf, summary } from "./log-rows.ts";

/** The list's own controls, for the console around it: where it is, and moving it. */
export interface LogListHandle {
  scrollToEnd(): void;
  scrollToStart(): void;
  scrollToSeq(seq: number): void;
  /** The sim times of the first and last row in view, or undefined when the list is empty. */
  visibleRange(): { t0S: number; t1S: number } | undefined;
  focus(): void;
}

export interface LogListProps {
  readonly rows: readonly TraceRecord[];
  /** More rows exist in storage than are read: the last row is "Loading…" and reaching it asks for the next page. */
  readonly more: boolean;
  readonly onNeedMore: () => void;
  readonly entityIds: readonly string[];
  readonly selectedSeq: number | undefined;
  /** Rows shown open, with their whole payload. */
  readonly expanded: ReadonlySet<number>;
  readonly onSelect: (r: TraceRecord) => void;
  /** Enter on the selected row: take the shared cursor there. */
  readonly onJump: (r: TraceRecord) => void;
  /** The trace graph of a record (the row's context menu, and the T key which the app takes): when given, the context menu offers it. */
  readonly onOpenGraph?: ((r: TraceRecord) => void) | undefined;
  /** The researcher's keys that are the console's (follow, expand, copy, flags): offered the key first. Returns true when it took it. */
  readonly onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  /** The list is at its end (within a row or two) or is not: the console pauses a tail that is not. */
  readonly onAtEnd: (atEnd: boolean) => void;
  readonly label: string;
  readonly testId?: string;
}

const NEAR_END_PX = 28;

/**
 * The virtualized rows of a log, zebra, a failure on the alarm tint, a row that opens inline to its whole payload: one list for the console and for the panes of the
 * inspector (ADR-0035 section 7). It owns scrolling and the keys that move the selection (j k ↑ ↓ Home End g G, ⏎); the rest of the keys are the console's.
 */
export const LogList = forwardRef<LogListHandle, LogListProps>(function LogList(props, ref) {
  const { rows, more, entityIds, selectedSeq, expanded } = props;
  const scroller = useRef<HTMLDivElement>(null);
  // The row's context menu: what can be done with the record under the pointer.
  const [menu, setMenu] = useState<{ readonly r: TraceRecord; readonly x: number; readonly y: number } | undefined>(undefined);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  const virtual = useVirtualizer({ count: rows.length + (more ? 1 : 0), getScrollElement: () => scroller.current, estimateSize: () => ROW_PX.compact, overscan: 12 });
  const items = virtual.getVirtualItems();
  const last = items[items.length - 1];

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => rows.length > 0 && virtual.scrollToIndex(rows.length - 1, { align: "end" }),
      scrollToStart: () => virtual.scrollToIndex(0),
      scrollToSeq: (seq) => {
        const i = rows.findIndex((r) => r.seq === seq);
        if (i >= 0) virtual.scrollToIndex(i);
      },
      visibleRange: () => {
        const v = virtual.getVirtualItems().filter((it) => it.index < rows.length);
        const a = v[0] && rows[v[0].index];
        const b = v[v.length - 1] && rows[(v[v.length - 1] as { index: number }).index];
        return a && b ? { t0S: a.simTime, t1S: b.simTime } : undefined;
      },
      focus: () => scroller.current?.focus(),
    }),
    [rows, virtual],
  );

  // The next page, when the end of what is read is in view.
  useEffect(() => {
    if (last && last.index >= rows.length && more && rows.length > 0) props.onNeedMore();
  }, [last, rows.length, more]);

  const atEnd = useCallback(() => {
    const el = scroller.current;
    return el === null || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
  }, []);
  const lastAtEnd = useRef<boolean | undefined>(undefined);
  const report = useCallback(() => {
    const now = atEnd();
    if (lastAtEnd.current === now) return;
    lastAtEnd.current = now;
    props.onAtEnd(now);
  }, [atEnd, props]);
  // The rows grow under a list that is at its end: it is still at its end unless the researcher moved.
  useEffect(() => {
    const raf = requestAnimationFrame(report);
    return () => cancelAnimationFrame(raf);
  }, [rows.length, report]);

  const select = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    props.onSelect(r);
    virtual.scrollToIndex(rows.indexOf(r));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (props.onKey?.(e)) {
      e.preventDefault();
      return;
    }
    const at = selectedSeq === undefined ? -1 : rows.findIndex((r) => r.seq === selectedSeq);
    if (e.key === "ArrowDown" || e.key === "j") select(at + 1);
    else if (e.key === "ArrowUp" || e.key === "k") select(at < 0 ? 0 : at - 1);
    else if (e.key === "Home" || e.key === "g") select(0);
    else if (e.key === "End" || e.key === "G") select(rows.length - 1);
    else if (e.key === "Enter" && at >= 0) props.onJump(rows[at] as TraceRecord);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={scroller}
      className="event-scroller"
      role="listbox"
      aria-label={props.label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={report}
      aria-activedescendant={selectedSeq === undefined ? undefined : `log-row-${selectedSeq}`}
      data-testid={props.testId ?? "log-list"}
      data-count={rows.length}
      data-last-seq={rows.length > 0 ? (rows[rows.length - 1] as TraceRecord).seq : -1}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {items.map((it) => {
          const r = rows[it.index];
          if (!r) {
            return (
              <div key={`more-${it.index}`} className="muted" style={{ position: "absolute", top: 0, transform: `translateY(${it.start}px)`, height: it.size }}>
                Loading…
              </div>
            );
          }
          const style = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
          const tag = style?.tag ?? r.kind.slice(0, 3).toUpperCase();
          const result = resultOf(r);
          const open = expanded.has(r.seq);
          const copyOf = copyOfRecord(r.payload);
          const id = r.agentId === undefined ? -1 : entityIds.indexOf(r.agentId);
          return (
            <div
              key={r.seq}
              ref={virtual.measureElement}
              data-index={it.index}
              role="option"
              aria-selected={selectedSeq === r.seq}
              aria-expanded={open}
              id={`log-row-${r.seq}`}
              data-testid={`event-row-${r.seq}`}
              data-seq={r.seq}
              data-kind={r.kind}
              data-agent={r.agentId ?? ""}
              title={r.source}
              className={`event-row selectable${it.index % 2 === 1 ? " zebra" : ""}${result?.failed ? " alm" : ""}${open ? " open" : ""}`}
              onClick={() => props.onSelect(r)}
              onDoubleClick={() => props.onJump(r)}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onSelect(r);
                const box = scroller.current?.getBoundingClientRect();
                setMenu({ r, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) + (scroller.current?.scrollTop ?? 0) });
              }}
              style={{ position: "absolute", top: 0, left: 0, right: 0, ...(open ? { minHeight: it.size } : { height: it.size }), transform: `translateY(${it.start}px)` }}
            >
              <span className="mono muted">{r.simTime.toFixed(2)} s</span>
              {r.agentId ? (
                <span className="mono">
                  <span className={`agent-swatch ${identityOf(Math.max(0, id)).style}`} style={{ ["--swatch" as string]: `var(--agent-${identityOf(Math.max(0, id)).colorIndex})` }} /> {r.agentId}
                </span>
              ) : (
                <span className="mono muted">run</span>
              )}
              <span className="tag mono" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
                [{tag}]
              </span>
              <span className="mono muted">{r.source}</span>
              <span className="mono">
                {copyOf !== undefined && (
                  <span className="muted" data-testid={`row-copy-${r.seq}`} title={`A copy of ${copyOf}: the derived run carries it from its parent`}>
                    ◇{" "}
                  </span>
                )}
                {summary(r)}
              </span>
              <span className={`mono${result?.failed ? " danger" : result ? " ok" : ""}`}>{result?.text ?? ""}</span>
              {open && <pre className="log-payload mono">{JSON.stringify(r, null, 2)}</pre>}
            </div>
          );
        })}
      </div>
      {menu && (
        <div className="log-menu" role="menu" aria-label={`Record #${menu.r.seq}`} style={{ left: menu.x, top: menu.y }} data-testid="log-menu" onPointerDown={(e) => e.stopPropagation()}>
          {props.onOpenGraph && (
            <button type="button" role="menuitem" className="tb" onClick={() => (props.onOpenGraph?.(menu.r), setMenu(undefined))} data-testid="log-menu-graph">
              trace graph <span className="k">T</span>
            </button>
          )}
          <button type="button" role="menuitem" className="tb" onClick={() => (props.onJump(menu.r), setMenu(undefined))} data-testid="log-menu-jump">
            jump to it <span className="k">⏎</span>
          </button>
        </div>
      )}
    </div>
  );
});
