import "../panels.css";
import { useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useAppActions, usePolled, useServices, useSource } from "../../services.tsx";
import { useDockPanel } from "../../workspaces/panel-context.ts";
import { requestLogFilter } from "../debug/log-filter-request.ts";
import { useJump } from "../debug/use-jump.ts";
import { useSelectedAgentId } from "../selected-agent.ts";
import {
  breadcrumb,
  childNodes,
  collapseAll,
  explode,
  fold,
  layoutRow,
  navigate,
  rootNodes,
  timeTicks,
  type HistoryNode,
  type OpenPath,
  type Placed,
  type RowView,
} from "./history-model.ts";
import { readChildren, readEffects, useAgentHistory } from "./use-agent-history.ts";

/**
 * The action history of one agent (T-102, ADR-0043, the designer's AgentHistory): the whole run on one time axis, one row per level. The first two rows are the commands (◆) and the
 * actions (bars with their outcome ▶ ✓ ✕ ▲, idle time hatched, reflexes and failures on the action row); a double click or Enter opens a node into the records it came from or caused
 * on the row below (parent and cause links), dashed brackets mark the opened span, and the deepest row is drawn once more stretched so that a short step keeps its words. A click
 * selects (the shared cursor: Log, Timeline and Inspector follow), the overview strip keeps the whole run with a brush, and positions come from time and `seq` only.
 */

const GUTTER = 92;
const LANE_H = 22;
const ROW_PAD = 6;

interface BuiltRow {
  readonly index: number;
  readonly label: string;
  readonly nodes: readonly HistoryNode[];
  readonly placed: readonly Placed[];
  readonly lanes: number;
  /** The node of the row above that this row is made of, as placed there. */
  readonly opener: Placed | undefined;
  readonly reading: boolean;
}

const tickOf = (t: number, dt: number) => Math.round(t / dt);

export function AgentHistoryPanel() {
  const source = useSource();
  const { storage } = useServices();
  const { openPanel, openWorkspace } = useAppActions();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const jump = useJump(snap);
  const dock = useDockPanel();
  const agentId = useSelectedAgentId();
  const runId = snap.runId;
  const dt = snap.run?.dtS ?? 0.1;
  const head = snap.persistedHeadTick ?? 0;
  const sharedRecord = useUiContext((s) => s.selectedRecord);
  const sharedSeq = sharedRecord !== undefined && sharedRecord.runId === runId ? sharedRecord.seq : undefined;

  const data = useAgentHistory(storage.ports, runId, agentId, head);
  const lastRecordS = data.records.reduce((m, r) => Math.max(m, r.simTime), 0);
  const endS = Math.max(snap.replay?.headS ?? snap.simTimeS, lastRecordS, 1);

  const [path, setPath] = useState<OpenPath>([]);
  const [children, setChildren] = useState<ReadonlyMap<string, readonly TraceRecord[]>>(new Map());
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [selKey, setSelKey] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<{ row: number; key: string } | undefined>(undefined);
  const [view, setView] = useState<{ t0: number; t1: number } | undefined>(undefined);
  const [effects, setEffects] = useState<{ seq: number; records: readonly TraceRecord[] } | undefined>(undefined);

  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(Math.max(240, el.clientWidth - GUTTER - 12));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // A new agent or run starts the history again.
  useEffect(() => {
    setPath([]);
    setChildren(new Map());
    setSelKey(undefined);
    setFocus(undefined);
    setView(undefined);
  }, [agentId, runId]);

  // The tab says whose history it is: "ugv-007 history" in Analysis, "[5h] History · ugv-007" in the Debug window.
  useEffect(() => {
    const api = dock?.api;
    if (!api || agentId === undefined) return;
    const title = api.title ?? "";
    const prefix = /^\[5h\]/.test(title) ? "[5h] " : "";
    api.setTitle(prefix === "" ? `${agentId} history` : `${prefix}History · ${agentId}`);
  }, [dock, agentId]);

  const axis = useMemo(() => view ?? { t0: 0, t1: endS }, [view, endS]);

  const rows = useMemo<BuiltRow[]>(() => {
    const { commands, actions } = rootNodes(data.records, endS);
    const out: BuiltRow[] = [];
    const lay = (index: number, label: string, nodes: readonly HistoryNode[], opener: Placed | undefined, isReading: boolean): BuiltRow => {
      const { placed, lanes } = layoutRow(nodes, { t0: axis.t0, t1: axis.t1, widthPx: width });
      return { index, label, nodes, placed, lanes, opener, reading: isReading };
    };
    out.push(lay(1, "commands", commands, undefined, false));
    out.push(lay(2, "actions", actions, undefined, false));
    for (let i = 0; i < path.length; i++) {
      const item = path[i] as { row: number; key: string };
      const opener = out.flatMap((r) => r.placed).find((p) => p.node.key === item.key);
      if (opener === undefined) break;
      const n = opener.node;
      const recs = children.get(n.key);
      const nodes = n.members ?? (recs === undefined ? [] : childNodes(recs, endS, n.t1));
      out.push(lay(3 + i, n.label, nodes, opener, n.members === undefined && recs === undefined && reading.has(n.key)));
    }
    return out;
  }, [data.records, endS, axis, width, path, children, reading]);

  const allNodes = useMemo(() => new Map(rows.flatMap((r) => r.placed.map((p) => [p.node.key, { node: p.node, row: r.index }] as const))), [rows]);
  const pathNodes = path.flatMap((p) => {
    const hit = allNodes.get(p.key);
    return hit === undefined ? [] : [hit.node];
  });
  const crumbs = breadcrumb([agentId ?? "", ...pathNodes.map((n) => n.label)]);

  const deepest = rows.length > 2 ? (rows[rows.length - 1] as BuiltRow) : undefined;
  const stretchAxis = useMemo(() => {
    if (!deepest || deepest.nodes.length === 0) return undefined;
    const t0 = Math.min(...deepest.nodes.map((n) => n.t0));
    const t1 = Math.max(...deepest.nodes.map((n) => n.t1));
    const pad = t1 > t0 ? (t1 - t0) * 0.02 : 0.5;
    return { t0: t0 - pad, t1: Math.max(t1, t0 + 0.1) + pad };
  }, [deepest]);
  const stretched = useMemo(() => (deepest && stretchAxis ? layoutRow(deepest.nodes, { ...stretchAxis, widthPx: width }, { minPx: 3 }) : undefined), [deepest, stretchAxis, width]);

  const selected = useMemo(() => {
    const own = selKey === undefined ? undefined : allNodes.get(selKey)?.node;
    if (own !== undefined && (own.record === undefined || own.record.seq === sharedSeq)) return own;
    if (sharedSeq === undefined) return own?.record === undefined ? own : undefined;
    return [...allNodes.values()].find((h) => h.node.record?.seq === sharedSeq)?.node;
  }, [selKey, allNodes, sharedSeq]);

  // What the selected record caused, for the side panel.
  useEffect(() => {
    const seq = selected?.record?.seq;
    if (runId === undefined || seq === undefined) {
      setEffects(undefined);
      return;
    }
    let live = true;
    void readEffects(storage.ports, runId, seq).then((records) => {
      if (live) setEffects({ seq, records });
    });
    return () => {
      live = false;
    };
  }, [storage, runId, selected?.record?.seq]);

  const select = (n: HistoryNode, row: number) => {
    setSelKey(n.key);
    setFocus({ row, key: n.key });
    if (runId === undefined) return;
    if (n.record) {
      useUiContext.getState().selectRecord({ runId, seq: n.record.seq });
      jump(n.t0, agentId);
    } else {
      useUiContext.getState().selectRecord(undefined);
      jump(n.t0, agentId);
    }
  };

  const open = (n: HistoryNode, row: number) => {
    if (!n.canExplode || runId === undefined) return;
    // The root rows both open into the row 3; deeper rows into the next one.
    const level = Math.max(2, row);
    setPath((p) => explode(p, level, n.key));
    if (n.members === undefined && children.get(n.key) === undefined) {
      setReading((s) => new Set([...s, n.key]));
      void readChildren(storage.ports, runId, n).then((recs) => {
        setChildren((m) => new Map([...m, [n.key, recs]]));
        setReading((s) => new Set([...s].filter((k) => k !== n.key)));
      });
    }
  };
  const isOpen = (key: string) => path.some((p) => p.key === key);
  const toggle = (n: HistoryNode, row: number) => {
    const at = path.findIndex((p) => p.key === n.key);
    if (at >= 0) setPath(path.slice(0, at));
    else open(n, row);
  };

  const rowViews: RowView[] = rows.map((r) => ({ index: r.index, placed: r.placed }));
  // The opened nodes of the first rows live in rows 1 and 2 but their children are row 3: `navigate` goes up to the node of the row above, found by key.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const dir = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : undefined;
    if (dir !== undefined) {
      e.preventDefault();
      let to = navigate(rowViews, focus, dir, path);
      if (dir === "up" && focus !== undefined && focus.row >= 3) {
        const opener = rows.find((r) => r.index === focus.row)?.opener;
        if (opener) to = { row: allNodes.get(opener.node.key)?.row ?? 2, key: opener.node.key };
      }
      const hit = to === undefined ? undefined : allNodes.get(to.key);
      if (to && hit) select(hit.node, hit.row);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = focus === undefined ? undefined : allNodes.get(focus.key);
      if (hit) toggle(hit.node, hit.row);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      setPath((p) => fold(p));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSelKey(undefined);
      setFocus(undefined);
      useUiContext.getState().selectRecord(undefined);
    } else if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (selected?.record) openPanel("traceGraph");
    }
  };

  // The brush of the overview strip: drag to take a stretch of the run, a click to take it all again.
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<number | undefined>(undefined);
  const stripT = (e: ReactPointerEvent) => {
    const r = strip.current?.getBoundingClientRect();
    return r === undefined || r.width === 0 ? 0 : Math.min(endS, Math.max(0, ((e.clientX - r.left) / r.width) * endS));
  };
  const onStripDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = stripT(e);
    setView({ t0: drag.current, t1: drag.current });
  };
  const onStripMove = (e: ReactPointerEvent) => {
    if (drag.current === undefined) return;
    const t = stripT(e);
    setView({ t0: Math.min(drag.current, t), t1: Math.max(drag.current, t) });
  };
  const onStripUp = () => {
    drag.current = undefined;
    setView((v) => (v === undefined || v.t1 - v.t0 < endS * 0.01 ? undefined : v));
  };

  const actionsRow = rows[1];
  const overview = useMemo(() => (actionsRow?.nodes ?? []).filter((n) => n.kind === "action" || n.kind === "reflex" || n.kind === "failure"), [actionsRow]);

  if (agentId === undefined) {
    return (
      <div className="panel ah" data-testid="agent-history">
        <p className="muted ah-empty" data-testid="agent-history-empty">
          Select an agent: its history shows what it did from start to end.
        </p>
      </div>
    );
  }

  const ticks = timeTicks(axis.t0, axis.t1, Math.max(2, Math.floor(width / 90)));
  const xOf = (t: number, a = axis) => ((t - a.t0) / Math.max(1e-9, a.t1 - a.t0)) * width;
  const rec = selected?.record;
  const payload = rec !== undefined && rec.payload !== null && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
  const ago = (n: HistoryNode) => `${n.t0.toFixed(1)} s · tick ${tickOf(n.t0, dt)}`;

  const nodeView = (p: Placed, row: number, a = axis, w = width) => {
    const n = p.node;
    const isSel = selected?.key === n.key;
    const isFocus = focus?.key === n.key;
    const point = n.t1 <= n.t0;
    const x = ((n.t0 - a.t0) / Math.max(1e-9, a.t1 - a.t0)) * w;
    const cls = ["ah-node", n.kind, n.status ?? "", point ? "pt" : "bar", isSel ? "sel" : "", isFocus ? "focus" : "", isOpen(n.key) ? "opened" : ""].filter(Boolean).join(" ");
    return (
      <div
        key={n.key}
        className={`${cls}${n.kind === "idle" ? " hatched" : ""}`}
        style={{ left: x, width: point ? undefined : Math.max(p.w, 3), top: ROW_PAD + p.lane * LANE_H, height: LANE_H - 4 }}
        role="button"
        tabIndex={-1}
        data-node={n.key}
        data-kind={n.kind}
        data-status={n.status}
        data-row={row}
        data-t0={n.t0.toFixed(3)}
        data-x={x.toFixed(1)}
        aria-label={`${n.glyph} ${n.label}, ${ago(n)}`}
        onClick={() => select(n, row)}
        onDoubleClick={() => open(n, row)}
      >
        <span className="ah-glyph">{n.glyph}</span>
        {n.kind === "idle" || point ? null : <span className="ah-label">{n.label}</span>}
        {point && n.kind !== "idle" ? <span className="ah-label pt">{n.label}</span> : null}
        {n.kind === "idle" ? <span className="ah-label muted">idle</span> : null}
      </div>
    );
  };

  return (
    <div className="panel ah" data-testid="agent-history" tabIndex={0} onKeyDown={onKey} data-agent={agentId}>
      <div className="ah-bar">
        <span className="ah-title" data-testid="agent-history-title">
          {agentId} · history
        </span>
        <span className="ah-crumbs mono" data-testid="agent-history-crumbs">
          {crumbs}
        </span>
        <span className="ah-spacer" />
        {data.cut ? <span className="muted">the history is cut at its first records</span> : null}
        <button type="button" className="kt" onClick={() => setPath(collapseAll())} disabled={path.length === 0} data-testid="ah-collapse">
          collapse all
        </button>
        <button type="button" className="kt" onClick={() => setView(undefined)} disabled={view === undefined} data-testid="ah-reset-view">
          whole run
        </button>
      </div>
      <div className="ah-body">
        <div className="ah-main" ref={box}>
          <div className="ah-axis" style={{ paddingLeft: GUTTER }} aria-hidden>
            <div className="ah-axis-track" style={{ width }}>
              {ticks.map((t) => (
                <span key={t} className="ah-tick" style={{ left: xOf(t) }}>
                  {t} s
                </span>
              ))}
            </div>
          </div>
          {data.loading && data.records.length === 0 ? <p className="muted ah-empty">Reading the history…</p> : null}
          {rows.map((r) => (
            <div key={r.index} className="ah-row" data-testid={`ah-row-${r.index}`} data-row={r.index}>
              <div className="ah-gutter" title={r.label}>
                {r.index <= 2 ? r.label : `↳ ${r.label}`}
              </div>
              <div className="ah-track" style={{ width, height: r.lanes * LANE_H + ROW_PAD * 2 }}>
                {r.opener ? <div className="ah-bracket" style={{ left: r.opener.x, width: Math.max(4, r.opener.w) }} data-testid={`ah-bracket-${r.index}`} /> : null}
                {r.placed.map((p) => nodeView(p, r.index))}
                {r.reading ? <span className="ah-note muted">reading…</span> : null}
                {r.index >= 3 && r.nodes.length === 0 && !r.reading ? <span className="ah-note muted">no records below this one</span> : null}
              </div>
            </div>
          ))}
          {stretched && stretchAxis ? (
            <div className="ah-row stretched" data-testid="ah-stretched">
              <div className="ah-gutter" title="the deepest row, stretched">
                stretched
              </div>
              <div className="ah-track" style={{ width, height: stretched.lanes * LANE_H + ROW_PAD * 2 }}>
                <span className="ah-span muted">
                  {stretchAxis.t0.toFixed(1)} – {stretchAxis.t1.toFixed(1)} s
                </span>
                {stretched.placed.map((p) => nodeView(p, rows.length, stretchAxis))}
              </div>
            </div>
          ) : null}
          <div className="ah-row ah-overview">
            <div className="ah-gutter">whole run</div>
            <div
              ref={strip}
              className="ah-strip"
              style={{ width }}
              data-testid="ah-overview"
              onPointerDown={onStripDown}
              onPointerMove={onStripMove}
              onPointerUp={onStripUp}
              onPointerCancel={onStripUp}
            >
              {overview.map((n) => (
                <span key={n.key} className={`ah-ov ${n.kind} ${n.status ?? ""}`} style={{ left: `${(n.t0 / endS) * 100}%`, width: n.t1 > n.t0 ? `${Math.max(0.3, ((n.t1 - n.t0) / endS) * 100)}%` : undefined }} />
              ))}
              {view ? <span className="ah-brush" data-testid="ah-brush" style={{ left: `${(view.t0 / endS) * 100}%`, width: `${((view.t1 - view.t0) / endS) * 100}%` }} /> : null}
            </div>
          </div>
        </div>
        <aside className="ah-side" data-testid="agent-history-side">
          {selected === undefined ? (
            <p className="muted">Click a node: its fields, its cause and its effects are here. Double-click or Enter opens it.</p>
          ) : (
            <>
              <div className="ah-sel-head">
                <span className="ah-glyph">{selected.glyph}</span> <strong data-testid="ah-sel-label">{selected.label}</strong>
              </div>
              <dl className="tg-fields" data-testid="ah-fields">
                <div>
                  <dt className="muted">kind</dt>
                  <dd>
                    {rec ? `${rec.kind}${selected.op ? ` · ${selected.op}` : ""}` : selected.kind}
                    {selected.status ? ` · ${selected.status}` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="muted">time</dt>
                  <dd>
                    {ago(selected)}
                    {selected.t1 > selected.t0 ? ` → ${selected.t1.toFixed(1)} s (${(selected.t1 - selected.t0).toFixed(1)} s)` : ""}
                  </dd>
                </div>
                {rec ? (
                  <>
                    <div>
                      <dt className="muted">record</dt>
                      <dd className="mono">{rec.id}</dd>
                    </div>
                    <div>
                      <dt className="muted">cause</dt>
                      <dd className="mono">{(rec.causeIds ?? []).length === 0 ? "none recorded" : (rec.causeIds ?? []).join(", ")}</dd>
                    </div>
                    <div>
                      <dt className="muted">sits in</dt>
                      <dd className="mono">{rec.parentId ?? "the first row (no parent)"}</dd>
                    </div>
                    <div>
                      <dt className="muted">effect</dt>
                      <dd data-testid="ah-effects">
                        {effects === undefined || effects.seq !== rec.seq ? "…" : effects.records.length === 0 ? "none recorded" : `${effects.records.length}${effects.records.length >= 200 ? "+" : ""} record${effects.records.length === 1 ? "" : "s"}: ${effects.records.slice(0, 3).map((e) => `${e.kind}${typeof (e.payload as { op?: unknown } | null)?.op === "string" ? ` ${(e.payload as { op: string }).op}` : ""}`).join(", ")}${effects.records.length > 3 ? ", …" : ""}`}
                      </dd>
                    </div>
                    {typeof payload["code"] === "string" ? (
                      <div>
                        <dt className="muted">code</dt>
                        <dd className="mono">{payload["code"]}</dd>
                      </div>
                    ) : null}
                  </>
                ) : selected.members ? (
                  <div>
                    <dt className="muted">stands for</dt>
                    <dd>{selected.members.length} nodes, too narrow to read at this width; Enter opens them, the stretched row shows them</dd>
                  </div>
                ) : null}
              </dl>
              <div className="ah-actions">
                {rec ? (
                  <button type="button" className="btn" onClick={() => openPanel("traceGraph")} data-testid="ah-trace-graph">
                    ⧉ trace graph · T
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    jump(selected.t0, agentId);
                    openWorkspace("debug");
                  }}
                  data-testid="ah-debug"
                >
                  → Debug at {selected.t0.toFixed(1)} s
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const a = Math.max(0, Math.floor(selected.t0 - 5));
                    const b = Math.ceil(Math.max(selected.t1, selected.t0) + 5);
                    requestLogFilter(`agent:${agentId} t:${a}..${b}`);
                    openPanel("eventList");
                  }}
                  data-testid="ah-log"
                >
                  ⌕ Log: this agent, {Math.max(0, Math.floor(selected.t0 - 5))}–{Math.ceil(Math.max(selected.t1, selected.t0) + 5)} s
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
      <p className="tg-keys muted" data-testid="ah-keys">
        ← → previous and next · ↑ ↓ change level · ⏎ open or fold · ⌫ fold the last · T trace graph · Esc clears the selection
      </p>
    </div>
  );
}
