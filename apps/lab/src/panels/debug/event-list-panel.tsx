import "../panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KIND_STYLE, ROW_PX, agentColorIndex } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { resultOf, summary } from "./log-rows.ts";
import { useJump } from "./use-jump.ts";

const PAGE = 200;
/** Pose samples are the bulk of a recording and are not events: the list leaves them out (they are the Scene's, at the cursor). */
const NO_SAMPLES = { exclude: [{ owner: null, component: "body" }] } as const;
const KIND_CHOICES = ["action", "reflex", "injected", "degradation", "compute", "plan", "event", "snapshot", "lifecycle", "observation", "thought", "message"] as const;

/**
 * The event list of the Debug workspace (UI-SPEC §6): the records of the run, read from storage a page at a time as the list is scrolled (agent and kind
 * filters are the store's indexes), virtualized, with the selected record in a detail panel. Clicking a row moves the shared cursor to the record's moment
 * and selects its agent: the Scene, the belief overlay and the Inspector go there with it (ADR-0016 context sync).
 */
export function EventListPanel() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const dt = snap.run?.dtS ?? 0.1;
  const headS = (snap.persistedHeadTick ?? 0) * dt;
  const jump = useJump(snap);
  const [agent, setAgent] = useState("");
  // The kinds shown: all, unless some are switched off (a chip off hides its kind; shift+click shows one kind alone).
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const kinds = off.size === 0 ? undefined : KIND_CHOICES.filter((k) => !off.has(k));
  const kindKey = kinds?.join(",") ?? "";
  const [rows, setRows] = useState<readonly TraceRecord[]>([]);
  const [more, setMore] = useState(true);
  const [selected, setSelected] = useState<TraceRecord | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const generation = useRef(0);
  const runId = snap.runId;

  // The rows read so far live in a ref (a page is added to what is there), the state is a copy for rendering.
  const have = useRef<TraceRecord[]>([]);

  const loadMore = useCallback(async () => {
    if (runId === undefined || loading.current) return;
    loading.current = true;
    const mine = generation.current;
    try {
      const from = have.current;
      const page = await storage.ports.trace.query({
        runId,
        afterSeq: from.length > 0 ? (from[from.length - 1] as TraceRecord).seq : -1,
        limit: PAGE,
        simTime: { to: headS },
        source: NO_SAMPLES,
        ...(agent === "" ? {} : { agentId: agent }),
        ...(kinds === undefined ? {} : { kinds: [...kinds] }),
      });
      if (mine !== generation.current) return;
      have.current = [...from, ...page];
      setRows(have.current);
      setMore(page.length === PAGE);
    } finally {
      loading.current = false;
    }
  }, [storage, runId, headS, agent, kindKey]);

  // A new run or a new filter starts the list again.
  useEffect(() => {
    generation.current++;
    loading.current = false;
    have.current = [];
    setRows([]);
    setMore(true);
    setSelected(undefined);
  }, [runId, agent, kindKey]);
  // The first page, and the next one when the end of the list is in view; a head that grew gives a list that had reached the old head more to read.
  useEffect(() => {
    if (rows.length === 0 && more && runId !== undefined) void loadMore();
  }, [rows, more, loadMore, runId]);
  useEffect(() => {
    if (!more && headS > 0) setMore(true);
  }, [headS]); // only a new head re-opens a list that had reached the old one

  const virtual = useVirtualizer({ count: rows.length + (more ? 1 : 0), getScrollElement: () => scroller.current, estimateSize: () => ROW_PX.compact, overscan: 12 });
  const items = virtual.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (last && last.index >= rows.length && more && rows.length > 0) void loadMore();
  }, [last, rows, more, loadMore]);

  /** Selects row `i` (clamped to the rows read so far): its record in the detail, the cursor and the agent where the row is, and the row in view. */
  const select = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    setSelected(r);
    jump(r.simTime, r.agentId);
    virtual.scrollToIndex(rows.indexOf(r));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = selected ? rows.findIndex((r) => r.seq === selected.seq) : -1;
    if (e.key === "ArrowDown" || e.key === "j") select(at + 1);
    else if (e.key === "ArrowUp" || e.key === "k") select(at < 0 ? 0 : at - 1);
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(rows.length - 1);
    else if (e.key === "Enter" && selected) jump(selected.simTime, selected.agentId);
    else return;
    e.preventDefault();
  };

  const toggleKind = (k: string, solo: boolean) =>
    setOff((cur) => {
      if (solo) return cur.size === KIND_CHOICES.length - 1 && !cur.has(k) ? new Set() : new Set(KIND_CHOICES.filter((x) => x !== k));
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Every chip off is no filter at all, not an empty list.
      return next.size === KIND_CHOICES.length ? new Set() : next;
    });
  const selectedTag = selected ? (KIND_STYLE[selected.kind as keyof typeof KIND_STYLE]?.tag ?? selected.kind.slice(0, 3).toUpperCase()) : undefined;

  return (
    <div className="panel event-list" data-testid="event-list">
      {/* The filter as a prompt (the filter language itself comes later): the run, the agent, the kinds and the time span read as one line. */}
      <div className="prompt mono" role="group" aria-label="Filter">
        <span className="ps">{runId ?? "no run"}</span>
        <span className="pf">$</span>
        <label>
          <span className="pf">agent:</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter" data-testid="event-filter-agent">
            <option value="">all</option>
            {snap.entityIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <span>
          <span className="pf">kind:</span> {kinds === undefined ? "all" : kinds.map((k) => KIND_STYLE[k as keyof typeof KIND_STYLE]?.tag.toLowerCase() ?? k).join(",") || "none"}
        </span>
        <span>
          <span className="pf">t:</span>
          <span className="pr">0..{headS.toFixed(1)}</span>
        </span>
        <span className="cur" aria-hidden="true" />
        <span className="sp" />
        <span className="muted" data-testid="event-count">
          {rows.length}
          {more ? "+" : ""} records
        </span>
      </div>
      <div className="kinds" role="group" aria-label="Kinds">
        {KIND_CHOICES.map((k) => {
          const style = KIND_STYLE[k as keyof typeof KIND_STYLE];
          const on = !off.has(k);
          return (
            <button
              key={k}
              type="button"
              className={`kt${on ? "" : " off"}`}
              aria-pressed={on}
              data-testid={`event-kind-${k}`}
              data-tip={`${k}: click to show or hide it, shift+click to show it alone`}
              onClick={(e) => toggleKind(k, e.shiftKey)}
            >
              <span className="tag" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
                {style?.tag ?? k.slice(0, 3).toUpperCase()}
              </span>{" "}
              {k}
            </button>
          );
        })}
      </div>
      <div ref={scroller} className="event-scroller" role="listbox" aria-label="Events" tabIndex={0} onKeyDown={onKeyDown} aria-activedescendant={selected ? `event-row-${selected.seq}` : undefined}>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return <div key={`more-${it.index}`} className="muted" style={{ position: "absolute", top: 0, transform: `translateY(${it.start}px)`, height: it.size }}>Loading…</div>;
            const style = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
            const tag = style?.tag ?? r.kind.slice(0, 3).toUpperCase();
            const result = resultOf(r);
            return (
              <div
                key={r.seq}
                role="option"
                aria-selected={selected?.seq === r.seq}
                id={`event-row-${r.seq}`}
                data-testid={`event-row-${r.seq}`}
                data-kind={r.kind}
                data-agent={r.agentId ?? ""}
                className={`event-row selectable${it.index % 2 === 1 ? " zebra" : ""}${result?.failed ? " alm" : ""}`}
                onClick={() => {
                  setSelected(r);
                  jump(r.simTime, r.agentId);
                }}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)` }}
              >
                <span className="mono muted">{r.simTime.toFixed(2)} s</span>
                {r.agentId ? (
                  <span className="mono">
                    <span className="agent-swatch" style={{ backgroundColor: `var(--agent-${agentColorIndex(r.agentId)})` }} /> {r.agentId}
                  </span>
                ) : (
                  <span className="mono muted">run</span>
                )}
                <span className="tag mono" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
                  [{tag}]
                </span>
                <span className="mono muted">{r.source}</span>
                <span className="mono">{summary(r)}</span>
                <span className={`mono${result?.failed ? " danger" : result ? " ok" : ""}`}>{result?.text ?? ""}</span>
              </div>
            );
          })}
        </div>
      </div>
      <pre className="event-detail mono" data-testid="event-detail" aria-label="Selected record">
        {selected ? JSON.stringify(selected, null, 2).slice(0, 4000) : "Select an event to see its record."}
      </pre>
      <div className="lfoot mono" data-testid="event-footer">
        <span>{selected ? `sel #${selected.seq} · ${selectedTag}` : "nothing selected"}</span>
        <span className="sp" />
        <span>↑↓ or j/k move · Home End · ⏎ jump · shift+click a kind: only that one</span>
      </div>
    </div>
  );
}
