import "../panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KIND_STYLE, ROW_PX, agentColorIndex } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { useJump } from "./use-jump.ts";

const PAGE = 200;
/** Pose samples are the bulk of a recording and are not events: the list leaves them out (they are the Scene's, at the cursor). */
const NO_SAMPLES = { exclude: [{ owner: null, component: "body" }] } as const;
const KIND_CHOICES = ["action", "reflex", "injected", "degradation", "compute", "plan", "event", "snapshot", "lifecycle", "observation", "thought", "message"] as const;

const summary = (r: TraceRecord): string => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
  const op = typeof p["op"] === "string" ? p["op"] : "";
  const name = typeof p["name"] === "string" ? p["name"] : "";
  return [op, name, r.detail ?? ""].filter((x) => x !== "").join(" · ");
};

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
  const [kind, setKind] = useState("");
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
        ...(kind === "" ? {} : { kinds: [kind] }),
      });
      if (mine !== generation.current) return;
      have.current = [...from, ...page];
      setRows(have.current);
      setMore(page.length === PAGE);
    } finally {
      loading.current = false;
    }
  }, [storage, runId, headS, agent, kind]);

  // A new run or a new filter starts the list again.
  useEffect(() => {
    generation.current++;
    loading.current = false;
    have.current = [];
    setRows([]);
    setMore(true);
    setSelected(undefined);
  }, [runId, agent, kind]);
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
    if (e.key === "ArrowDown") select(at + 1);
    else if (e.key === "ArrowUp") select(at < 0 ? 0 : at - 1);
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(rows.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="panel event-list" data-testid="event-list">
      <div className="event-filters">
        <label>
          <span className="muted">agent </span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter" data-testid="event-filter-agent">
            <option value="">all</option>
            {snap.entityIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">kind </span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind filter" data-testid="event-filter-kind">
            <option value="">all (no pose samples)</option>
            {KIND_CHOICES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <span className="muted" data-testid="event-count">
          {rows.length}
          {more ? "+" : ""} records
        </span>
      </div>
      <div ref={scroller} className="event-scroller" role="listbox" aria-label="Events" tabIndex={0} onKeyDown={onKeyDown} aria-activedescendant={selected ? `event-row-${selected.seq}` : undefined}>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return <div key={`more-${it.index}`} className="muted" style={{ position: "absolute", top: 0, transform: `translateY(${it.start}px)`, height: it.size }}>Loading…</div>;
            const tag = KIND_STYLE[r.kind as keyof typeof KIND_STYLE]?.tag ?? r.kind.slice(0, 3).toUpperCase();
            return (
              <div
                key={r.seq}
                role="option"
                aria-selected={selected?.seq === r.seq}
                id={`event-row-${r.seq}`}
                data-testid={`event-row-${r.seq}`}
                data-kind={r.kind}
                data-agent={r.agentId ?? ""}
                className="event-row"
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
                <span className="kind-tag mono">{tag}</span>
                <span className="mono">{summary(r)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <pre className="event-detail mono" data-testid="event-detail" aria-label="Selected record">
        {selected ? JSON.stringify(selected, null, 2).slice(0, 4000) : "Select an event to see its record."}
      </pre>
    </div>
  );
}
