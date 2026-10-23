import "../panels.css";
import { useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { loadInspectorLayout, storeInspectorLayout } from "../../config/inspector-layout.ts";
import { useAppActions, usePolled, useServices, useSource } from "../../services.tsx";
import { useJump } from "../debug/use-jump.ts";
import { LogPane, SeriesPane, TablePane, type PaneViewProps } from "./pane-views.tsx";
import { addPane, DEFAULT_PANES, filterAfterViewChange, filterFitsView, FUTURE_VIEWS, MAX_PANES, metricFilterFor, paneFor, removePane, sourceFilter, sourceTree, updatePane, type PaneSpec, type PaneView } from "./panes.ts";

/**
 * The multi-log inspector of the Debug workspace (ADR-0035 section 7): a source tree (the agents and their components, the world's `sim` and `storage`) and up to four panes,
 * each a subscription with a view type: a log, a table or a series. One shared record and one shared cursor (picking a record in any pane picks it everywhere); a Live / Replay
 * switch with the same panes and filters (Live tails the run being recorded, Replay reads what is stored); in Replay, a button that re-simulates the window. The panes are
 * kept per user.
 */
export function MultiLogInspector() {
  const source = useSource();
  const { storage } = useServices();
  const { resimulateWindow } = useAppActions();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const dt = snap.run?.dtS ?? 0.1;
  const headS = (snap.persistedHeadTick ?? 0) * dt;
  const jump = useJump(snap);
  const runId = snap.runId;
  const base = useId().replace(/[^A-Za-z0-9]/g, "");
  const canTail = source.mode === "live" && snap.persistedHeadTick !== undefined;
  const [mode, setMode] = useState<"live" | "replay">(canTail ? "live" : "replay");
  useEffect(() => {
    if (!canTail) setMode("replay");
  }, [canTail]);
  const tail = mode === "live" && canTail;

  const [panes, setPanes] = useState<PaneSpec[]>([...DEFAULT_PANES]);
  const [restored, setRestored] = useState(false);
  const next = useRef(3);
  // The panes as the researcher left them, and kept as they change.
  useEffect(() => {
    let off = false;
    void loadInspectorLayout(storage.ports.userData).then((saved) => {
      if (off) return;
      if (saved !== undefined && saved.length > 0) setPanes(saved);
      setRestored(true);
    });
    return () => {
      off = true;
    };
  }, [storage]);
  useEffect(() => {
    if (restored) void storeInspectorLayout(storage.ports.userData, panes);
  }, [storage, panes, restored]);

  const newId = () => {
    let id = `n${next.current++}`;
    while (panes.some((p) => p.id === id)) id = `n${next.current++}`;
    return id;
  };
  const add = (view: PaneView, filter: string, title: string) => setPanes((cur) => addPane(cur, paneFor(newId(), view, filter, title)));

  const pick = (r: TraceRecord) => {
    if (runId !== undefined) useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };
  const toMoment = (tS: number) => jump(tS);
  const tree = sourceTree(snap.entityIds);

  return (
    <div className="panel log-inspector" data-testid="log-inspector">
      <div className="li-bar mono">
        <span className="ps">{runId ?? "no run"}</span>
        <span role="group" aria-label="Live or Replay" className="segc" data-testid="inspector-mode">
          <label className={tail ? "on" : ""} data-tip={canTail ? "Tail the run as it is recorded" : "This run is not being recorded: there is nothing to tail"}>
            <input type="radio" name={`mode-${base}`} checked={tail} disabled={!canTail} onChange={() => setMode("live")} data-testid="inspector-live" />
            Live
          </label>
          <label className={!tail ? "on" : ""} data-tip="Read what is stored, with the same panes and filters">
            <input type="radio" name={`mode-${base}`} checked={!tail} onChange={() => setMode("replay")} data-testid="inspector-replay" />
            Replay
          </label>
        </span>
        <select
          className="kt"
          value=""
          aria-label="Add a pane"
          data-testid="inspector-add"
          onChange={(e) => {
            const v = e.target.value as PaneView;
            if (v === "log") add("log", "-source:*/body", "log");
            else if (v === "table") add("table", "kind:observation", "table");
            else if (v === "series") add("series", "metric:sim.tickMs", "series");
          }}
        >
          <option value="">add a pane ▾ ({panes.length}/{MAX_PANES})</option>
          <option value="log">log</option>
          <option value="table">table</option>
          <option value="series">series</option>
          {FUTURE_VIEWS.map((f) => (
            <option key={f.name} value="" disabled>
              {f.name} — {f.phase}
            </option>
          ))}
        </select>
        <span className="sp" />
        <button type="button" className="kt" disabled={tail || runId === undefined} onClick={resimulateWindow} data-testid="inspector-resim" data-tip={tail ? "In Replay: re-simulate the Timeline's selection, else the cursor with a few seconds either side" : "Re-simulate the selected window (the Timeline's selection, else the cursor ± a few seconds) into a derived run"}>
          re-simulate window
        </button>
        <button type="button" className="kt" onClick={() => setPanes([...DEFAULT_PANES])} data-testid="inspector-reset">
          reset panes
        </button>
      </div>
      <div className="li-main">
        <nav className="li-tree mono" aria-label="Sources" data-testid="source-tree">
          {tree.map((n) => (
            <div key={n.owner} className="li-owner">
              <div className="li-row">
                <button type="button" className="tt-node li-name" onClick={() => add("log", sourceFilter(n.owner), n.owner)} data-testid={`source-${n.owner}`} data-tip={`A log of everything ${n.owner} writes`}>
                  {n.owner}
                </button>
                <button type="button" className="tt-more li-metrics" onClick={() => add("series", metricFilterFor(n.owner), `${n.owner} metrics`)} data-testid={`source-${n.owner}-metrics`} data-tip={`The metrics of ${n.owner} as a series`}>
                  ~
                </button>
              </div>
              {n.components.map((c) => (
                <button key={c} type="button" className="tt-node li-comp" onClick={() => add("log", sourceFilter(n.owner, c), `${n.owner}/${c}`)} data-testid={`source-${n.owner}-${c}`}>
                  {c}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="li-panes" data-testid="inspector-panes" data-mode={tail ? "live" : "replay"}>
          {panes.length === 0 && <p className="muted li-empty">No panes: pick a source in the tree, or add one.</p>}
          {panes.map((pane) => (
            <Pane
              key={pane.id}
              pane={pane}
              view={{ storage, runId, filter: pane.filter, headS, tail, viewId: `li-${base}-${pane.id}`, entityIds: snap.entityIds, onPick: pick, onMoment: toMoment }}
              onChange={(change) => setPanes((cur) => updatePane(cur, pane.id, change))}
              onClose={() => setPanes((cur) => removePane(cur, pane.id))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Pane(props: { pane: PaneSpec; view: PaneViewProps; onChange: (change: Partial<Omit<PaneSpec, "id">>) => void; onClose: () => void }) {
  const { pane, view } = props;
  // The filter is typed freely; the pane runs with the last one that fits its view.
  const [draft, setDraft] = useState(pane.filter);
  useEffect(() => setDraft(pane.filter), [pane.filter]);
  const fits = filterFitsView(draft, pane.view);
  useEffect(() => {
    if (draft === pane.filter || !fits) return;
    const id = setTimeout(() => props.onChange({ filter: draft }), 200);
    return () => clearTimeout(id);
  }, [draft, fits]);
  return (
    <section className="li-pane" data-testid={`pane-${pane.id}`} data-view={pane.view} aria-label={pane.title}>
      <header className="li-pane-head mono">
        <span className="li-title" title={pane.title}>
          {pane.title}
        </span>
        <select
          className="kt"
          value={pane.view}
          aria-label="View"
          data-testid={`pane-view-${pane.id}`}
          onChange={(e) => {
            const v = e.target.value as PaneView;
            props.onChange({ view: v, filter: filterAfterViewChange(pane.filter, v) });
          }}
        >
          <option value="log">log</option>
          <option value="table">table</option>
          <option value="series">series</option>
        </select>
        <input
          className={`log-filter mono${fits ? "" : " err"}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label="Pane filter"
          aria-invalid={!fits}
          data-testid={`pane-filter-${pane.id}`}
          placeholder={pane.view === "series" ? "metric:agent.soc source:uav-001/body" : "kind:action agent:uav-001"}
        />
        <button type="button" className="kt" onClick={props.onClose} aria-label={`Close ${pane.title}`} data-testid={`pane-close-${pane.id}`}>
          ✕
        </button>
      </header>
      {!fits && (
        <div className="li-bad mono" role="alert">
          {pane.view === "series" ? "a series needs a metric: filter" : "this filter does not parse, or selects metrics (use a series)"}
        </div>
      )}
      {pane.view === "log" ? <LogPane {...view} /> : pane.view === "table" ? <TablePane {...view} /> : <SeriesPane {...view} />}
    </section>
  );
}
