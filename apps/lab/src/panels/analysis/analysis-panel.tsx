import "../panels.css";
import { downloadBytes, identityOf, useUiContext } from "@agentsim/ui";
import { parseFilter, type FilterAst, type TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { shownChoices, toggleChoice, withTermValues } from "../debug/filter-text.ts";
import { markOf } from "../debug/marks.ts";
import { useJump } from "../debug/use-jump.ts";
import { agentsShown, buildMapSvg, computeSeriesOf, csvOfSeries, filterRecords, jsonlOfRecords, markersOf, metricSeriesOf, pointsInWindow, positionAt, seriesInWindow, windowOfFilter, type MapModel } from "./analysis-model.ts";
import { AnalysisSeriesView } from "./analysis-series.tsx";
import { AnalysisTimeline } from "./analysis-timeline.tsx";
import { TopDownMap, type MapPick, type TopDownMapHandle } from "./top-down-map.tsx";
import { useBlockedGrid } from "./use-blocked-grid.ts";
import { useRunData } from "./use-analysis-data.ts";

const EVENT_KINDS = ["action", "reflex", "injected", "degradation"] as const;
/** Points a trajectory draws at most (a run of hours has more samples than the map has pixels). */
const DRAW_POINTS = 3000;
const EXPORT_PAGE = 5000;
const EMPTY_AST: FilterAst = { target: "records", terms: [] };

const thin = <T,>(list: readonly T[], max: number): T[] => {
  if (list.length <= max) return [...list];
  const step = Math.ceil(list.length / max);
  return list.filter((_, i) => i % step === 0 || i === list.length - 1);
};

const close = (a: number, b: number) => Math.abs(a - b) < 0.051;

/**
 * The Analysis workspace (ADR-0029, UI-SPEC sections 3 and 4): a recorded run read from storage, with no simulation. A top-down map of the trajectories and the events on them,
 * an event timeline with a time-window brush, per-agent series, and the filters (agent, kind, time window, group) written in the log console's language: the filter text is the
 * one state, so the chips, the brush and the prompt are three ways of writing it. The shared cursor and the window follow the Debug workspace and the Scene both ways, and
 * the view can be exported (PNG, SVG, the series as CSV, the filtered trace as JSON lines).
 */
export function AnalysisPanel() {
  const { storage } = useServices();
  const source = useSource();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 200);
  const runId = snap.runId;
  const data = useRunData(storage, runId);
  const jump = useJump(snap);
  const cursor = useUiContext((s) => s.simTime);
  const timeSel = useUiContext((s) => s.timeSelection);
  const picked = useUiContext((s) => s.selectedRecord);
  const selected = useUiContext((s) => s.selection);
  const [text, setText] = useState("");
  const map = useRef<TopDownMapHandle>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [showMarkers, setShowMarkers] = useState(true);

  const parsed = useMemo(() => parseFilter(text), [text]);
  const error = !parsed.ok ? parsed.error.message : parsed.value.target === "metrics" ? "a metric: filter selects samples; this view takes record filters (agent, kind, t, group, text…)" : undefined;
  const ast: FilterAst = parsed.ok && parsed.value.target === "records" ? parsed.value : EMPTY_AST;
  const win = windowOfFilter(ast);

  /** One state, three ways to write it: a change of the text moves the shared selection with it. */
  const setFilter = useCallback((next: string) => {
    setText(next);
    const r = parseFilter(next);
    if (!r.ok || r.value.target !== "records") return;
    const w = windowOfFilter(r.value);
    useUiContext.getState().setTimeSelection(w === undefined || !Number.isFinite(w.t0) || !Number.isFinite(w.t1) ? undefined : { t0S: w.t0, t1S: w.t1 });
  }, []);
  // The other way: a window selected elsewhere (the Debug Timeline) is the filter's `t:` term here.
  useEffect(() => {
    if (timeSel === undefined) return;
    setText((cur) => {
      const r = parseFilter(cur);
      const w = r.ok && r.value.target === "records" ? windowOfFilter(r.value) : undefined;
      if (w !== undefined && close(w.t0, timeSel.t0S) && close(w.t1, timeSel.t1S)) return cur;
      return withTermValues(cur, "t", [`${timeSel.t0S.toFixed(1)}..${timeSel.t1S.toFixed(1)}`]);
    });
  }, [timeSel]);

  const allAgents = useMemo(() => {
    const ids = new Set<string>(data.trajectories.keys());
    for (const r of data.events) if (r.agentId !== undefined) ids.add(r.agentId);
    return [...ids].sort();
  }, [data.trajectories, data.events]);
  const shown = useMemo(() => agentsShown(ast, allAgents), [ast, allAgents]);
  const indexOf = useCallback((id: string) => Math.max(0, allAgents.indexOf(id)), [allAgents]);
  const events = useMemo(() => filterRecords(data.events, ast), [data.events, ast]);
  const spanS = useMemo(() => {
    let t = 0;
    for (const tr of data.trajectories.values()) t = Math.max(t, tr.samples[tr.samples.length - 1]?.t ?? 0);
    for (const r of data.events) t = Math.max(t, r.simTime);
    return Math.max(t, snap.run === undefined ? 0 : (snap.persistedHeadTick ?? 0) * (snap.run.dtS ?? 0.1), 1);
  }, [data.trajectories, data.events, snap.run, snap.persistedHeadTick]);
  const dims = snap.grid?.dims;
  const blocked = useBlockedGrid(source, dims, runId);
  const widthM = dims ? dims.sizeX * dims.resolutionM : Math.max(10, ...[...data.trajectories.values()].flatMap((t) => t.samples.map((s) => s.x)));
  const heightM = dims ? dims.sizeY * dims.resolutionM : Math.max(10, ...[...data.trajectories.values()].flatMap((t) => t.samples.map((s) => s.y)));

  const model: MapModel = useMemo(() => {
    const shownSet = new Set(shown);
    const lo = win?.t0 ?? 0;
    const hi = win?.t1 ?? Number.POSITIVE_INFINITY;
    return {
      widthM,
      heightM,
      blocked,
      trajectories: shown.flatMap((id) => {
        const tr = data.trajectories.get(id);
        if (!tr) return [];
        const pts = win ? pointsInWindow(tr, lo, hi) : tr.samples.map((s) => ({ x: s.x, y: s.y, t: s.t }));
        return [{ agentId: id, colorIndex: indexOf(id), points: thin(pts, DRAW_POINTS) }];
      }),
      positions: shown.flatMap((id) => {
        const tr = data.trajectories.get(id);
        const p = tr ? positionAt(tr, Math.min(Math.max(cursor, lo), Number.isFinite(hi) ? hi : cursor)) : undefined;
        return p ? [{ agentId: id, colorIndex: indexOf(id), x: p.x, y: p.y }] : [];
      }),
      markers: markersOf(events, data.trajectories).filter((m) => shownSet.has(m.agentId)),
    };
  }, [shown, win, widthM, heightM, blocked, data.trajectories, events, cursor, indexOf]);

  const marks = useMemo(() => events.map((r) => markOf(r)), [events]);
  const lanes = useMemo(() => ["run", ...shown], [shown]);
  const allSeries = useMemo(() => [...metricSeriesOf(data.metrics), ...computeSeriesOf(data.compute)], [data.metrics, data.compute]);
  const series = useMemo(() => seriesInWindow(allSeries, new Set(shown), win && Number.isFinite(win.t0) && Number.isFinite(win.t1) ? win : undefined), [allSeries, shown, win]);
  const span = win && Number.isFinite(win.t0) && Number.isFinite(win.t1) ? { t0: win.t0, t1: win.t1 } : { t0: 0, t1: spanS };

  const onPick = (p: MapPick) => {
    if (p.seq !== undefined && runId !== undefined) useUiContext.getState().selectRecord({ runId, seq: p.seq });
    if (p.t !== undefined) jump(p.t, p.agentId);
    else if (p.agentId !== undefined) useUiContext.getState().select({ kind: "agent", id: p.agentId });
  };

  // ---- exports ---------------------------------------------------------------------------------------------------------------------------------------------
  const save = (bytes: Uint8Array, name: string, type: string) => {
    downloadBytes(bytes, name, type);
    setNote(`exported ${name}`);
  };
  const exportPng = async () => {
    const b = await map.current?.toPng();
    if (!b) return setNote("the map could not be drawn to an image");
    save(new Uint8Array(await b.arrayBuffer()), `${runId ?? "run"}-map.png`, "image/png");
  };
  const exportSvg = () => {
    const palette = map.current?.palette();
    if (palette) save(new TextEncoder().encode(buildMapSvg(model, palette)), `${runId ?? "run"}-map.svg`, "image/svg+xml");
  };
  const exportCsv = () => save(new TextEncoder().encode(csvOfSeries(series)), `${runId ?? "run"}-series.csv`, "text/csv");
  const exportJsonl = async () => {
    if (runId === undefined || error !== undefined) return;
    setNote("exporting…");
    const filter = text.includes("source:") ? text : `${text} -source:*/body`.trim();
    const all: TraceRecord[] = [];
    for (let after: number | undefined; ; ) {
      const page = await storage.ports.trace.query({ runId, limit: EXPORT_PAGE, ...(filter === "" ? {} : { filter }), ...(after === undefined ? {} : { afterSeq: after }) });
      all.push(...page);
      if (page.length < EXPORT_PAGE) break;
      after = (page[page.length - 1] as TraceRecord).seq;
    }
    save(new TextEncoder().encode(jsonlOfRecords(all)), `${runId}${text === "" ? "" : "-filtered"}.jsonl`, "application/x-ndjson");
  };

  if (runId === undefined || data.status === "idle") {
    return (
      <div className="panel an" data-testid="analysis">
        <p className="muted an-empty" data-testid="analysis-empty">
          No run. The Analysis workspace reads a recorded run from storage: replay one from the Data workspace or from a finished headless run.
        </p>
      </div>
    );
  }
  const kindsShown = shownChoices(text, "kind", EVENT_KINDS);
  const agentsOn = shownChoices(text, "agent", allAgents);
  return (
    <div className="panel an" data-testid="analysis" data-status={data.status}>
      <div className="an-bar mono">
        <span className="ps">{runId}</span>
        <span className="pf">$</span>
        <input
          className={`log-filter mono${error ? " err" : ""}`}
          value={text}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          aria-label="Analysis filter"
          aria-invalid={error !== undefined}
          data-testid="an-filter"
          placeholder="e.g. agent:ugv-001 kind:action,reflex t:9..18"
        />
        <span className="muted" data-testid="an-count">
          {data.status === "loading" ? `reading… ${data.counts.poses}` : `${text.trim() === "" ? "no filter · " : ""}${shown.length}/${allAgents.length} agents · ${events.length} events`}
        </span>
        <button type="button" className="kt tip-right" onClick={data.reload} data-testid="an-reload" data-tip="Read the run again (it may have grown)">
          ⟳
        </button>
      </div>
      {error && (
        <div className="log-error mono" role="alert" data-testid="an-error">
          <span className="danger">✕ {error}</span>
        </div>
      )}
      <div className="an-chips" role="group" aria-label="Agents and kinds">
        {allAgents.map((id) => (
          <button
            key={id}
            type="button"
            className={`kt${agentsOn.has(id) ? "" : " off"}`}
            aria-pressed={agentsOn.has(id)}
            data-testid={`an-agent-${id}`}
            data-tip="click to show or hide this agent, shift+click to show it alone"
            onClick={(e) => setFilter(toggleChoice(text, "agent", id, allAgents, e.shiftKey))}
          >
            <span className="agent-swatch" style={{ ["--swatch" as string]: `var(--agent-${identityOf(indexOf(id)).colorIndex})` }} /> {id}
          </button>
        ))}
        <span className="sep" aria-hidden="true" />
        {EVENT_KINDS.map((k) => (
          <button key={k} type="button" className={`kt${kindsShown.has(k) ? "" : " off"}`} aria-pressed={kindsShown.has(k)} data-testid={`an-kind-${k}`} onClick={(e) => setFilter(toggleChoice(text, "kind", k, EVENT_KINDS, e.shiftKey))}>
            {k}
          </button>
        ))}
        <span className="sep" aria-hidden="true" />
        <button type="button" className={`kt${showMarkers ? "" : " off"}`} aria-pressed={showMarkers} data-testid="an-markers" data-tip="The events drawn on the paths: dots by kind, flags for failures and reflexes" onClick={() => setShowMarkers((v) => !v)}>
          markers
        </button>
        {win && (
          <button type="button" className="kt" onClick={() => setFilter(withTermValues(text, "t", undefined))} data-testid="an-clear-window" data-tip="Show the whole run again">
            window {Number.isFinite(win.t0) ? win.t0.toFixed(1) : "…"}–{Number.isFinite(win.t1) ? win.t1.toFixed(1) : "…"} s ✕
          </button>
        )}
        <span className="sp" />
        <span className="an-export" role="group" aria-label="Export">
          <button type="button" className="kt" onClick={() => void exportPng()} data-testid="an-export-png">
            map PNG
          </button>
          <button type="button" className="kt" onClick={exportSvg} data-testid="an-export-svg">
            map SVG
          </button>
          <button type="button" className="kt" onClick={exportCsv} disabled={series.length === 0} data-testid="an-export-csv">
            series CSV
          </button>
          <button type="button" className="kt tip-right" onClick={() => void exportJsonl()} disabled={error !== undefined} data-testid="an-export-jsonl" data-tip="The trace records the filter selects (pose samples left out unless the filter names a source)">
            trace JSONL
          </button>
        </span>
      </div>
      {data.capped.length > 0 && (
        <p className="warn an-note" data-testid="an-capped">
          ▲ This run has more {data.capped.join(", ")} than the view holds: what is drawn is the first part. The exports read the whole run.
        </p>
      )}
      <div className="an-main">
        <div className="an-map">
          <TopDownMap ref={map} model={model} markers={showMarkers} selectedAgent={selected?.kind === "agent" ? selected.id : undefined} selectedSeq={picked?.runId === runId ? picked.seq : undefined} onPick={onPick} label={`Top-down map of ${runId}: trajectories and events`} />
        </div>
        <div className="an-side">
          <AnalysisTimeline
            lanes={lanes}
            marks={marks}
            scaleS={spanS}
            window={win && Number.isFinite(win.t0) && Number.isFinite(win.t1) ? win : undefined}
            cursorS={cursor}
            onBrush={(w) => setFilter(withTermValues(text, "t", w === undefined ? undefined : [`${w.t0.toFixed(1)}..${w.t1.toFixed(1)}`]))}
            onSeek={(t, agentId, mark) => {
              if (mark && runId !== undefined) useUiContext.getState().selectRecord({ runId, seq: mark.seq });
              jump(t, agentId);
            }}
          />
          <AnalysisSeriesView series={series} indexOf={indexOf} span={span} cursorS={cursor} selectedAgent={selected?.kind === "agent" ? selected.id : undefined} onSeek={(t, agentId) => jump(t, agentId)} />
        </div>
      </div>
      <div className="an-foot mono muted" data-testid="an-foot">
        {note ?? `${data.counts.poses.toLocaleString("en")} pose samples · a pose is a sample of the recording, not a continuous track: the line between two samples is straight`}
      </div>
    </div>
  );
}
