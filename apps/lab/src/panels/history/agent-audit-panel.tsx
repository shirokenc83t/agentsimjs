import "../panels.css";
import { downloadBytes, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useAppActions, usePolled, useServices, useSource } from "../../services.tsx";
import { computeSeriesOf, metricSeriesOf, seriesInWindow, type AnalysisSeries, type SeriesPoint } from "../analysis/analysis-model.ts";
import { AnalysisSeriesView } from "../analysis/analysis-series.tsx";
import { requestLogFilter } from "../debug/log-filter-request.ts";
import { recordBySeq } from "../debug/trace-tree.ts";
import { useJump } from "../debug/use-jump.ts";
import { useDockPanel } from "../../workspaces/panel-context.ts";
import { useSelectedAgentId } from "../selected-agent.ts";
import { auditCsv, auditFindings, auditRows, commandsByInput, rowsInWindow, type AuditRow } from "./audit-model.ts";
import { AgentHistoryPanel } from "./agent-history-panel.tsx";
import { computeProvenance, metricProvenance, type Provenance } from "./provenance.ts";
import { useAgentHistory } from "./use-agent-history.ts";
import type { StorageClient } from "@agentsim/storage";

/**
 * The history and audit of one agent (T-103, ADR-0043, the designer's AuditProvenance): one tab per subject. The left column holds a compact history (the same component as the
 * full history; its brush filters the audit) over the audit table, one row per action in time order with its outcome, the reason in words and what caused it, reflexes, replans
 * and refusals as indented sub-rows, the mission's stop and the idle stretches as rows; the right column holds the agent's charts and, under them, the pinned provenance panel:
 * a click on a point of a chart marks it and says which records the value comes from.
 */

const EMPTY: readonly AnalysisSeries[] = [];

/** The agent's battery, speed and planner series: the metric samples of its source and its plan records (each point keeps the tick and, for the planner, the record it is). */
function useAgentSeries(storage: Pick<StorageClient, "ports">, runId: string | undefined, agentId: string | undefined, headTick: number): readonly AnalysisSeries[] {
  const [series, setSeries] = useState<readonly AnalysisSeries[]>(EMPTY);
  useEffect(() => {
    if (runId === undefined || agentId === undefined) {
      setSeries(EMPTY);
      return;
    }
    let live = true;
    void (async () => {
      const metrics = [];
      for (let after: { source: string; name: string; tick: number } | undefined; ; ) {
        const got = await storage.ports.metrics.query({ runId, filter: `metric:agent.soc,agent.speedMps agent:${agentId}`, limit: 10_000, ...(after === undefined ? {} : { after }) });
        metrics.push(...got);
        const last = got[got.length - 1];
        if (got.length < 10_000 || last === undefined || metrics.length >= 200_000) break;
        after = { source: last.source, name: last.name, tick: last.tick };
      }
      const compute = [];
      for (let after: number | undefined; ; ) {
        const got = await storage.ports.trace.query({ runId, agentId, kinds: ["compute"], op: "plan", limit: 10_000, ...(after === undefined ? {} : { afterSeq: after }) });
        compute.push(...got);
        const last = got[got.length - 1];
        if (got.length < 10_000 || last === undefined || compute.length >= 100_000) break;
        after = last.seq;
      }
      if (live) setSeries([...metricSeriesOf(metrics), ...computeSeriesOf(compute)].filter((s) => s.agentId === agentId));
    })();
    return () => {
      live = false;
    };
  }, [storage, runId, agentId, headTick]);
  return series;
}

export function AgentAuditPanel() {
  const source = useSource();
  const { storage } = useServices();
  const { openPanel } = useAppActions();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const jump = useJump(snap);
  const agentId = useSelectedAgentId();
  const runId = snap.runId;
  const dt = snap.run?.dtS ?? 0.1;
  const head = snap.persistedHeadTick ?? 0;
  const cursor = useUiContext((s) => s.simTime);
  const sharedRecord = useUiContext((s) => s.selectedRecord);
  const sharedSeq = sharedRecord !== undefined && sharedRecord.runId === runId ? sharedRecord.seq : undefined;

  const data = useAgentHistory(storage.ports, runId, agentId, head);
  const allSeries = useAgentSeries(storage, runId, agentId, head);
  const lastS = data.records.reduce((m, r) => Math.max(m, r.simTime), 0);
  const endS = Math.max(snap.replay?.headS ?? snap.simTimeS, lastS, 1);

  const [view, setView] = useState<{ t0: number; t1: number } | undefined>(undefined);
  const [dim, setDim] = useState(false);
  const [mark, setMark] = useState<{ key: string; point: SeriesPoint; series: AnalysisSeries } | undefined>(undefined);
  const [prov, setProv] = useState<Provenance | undefined>(undefined);
  const [rowKey, setRowKey] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    setView(undefined);
    setMark(undefined);
    setProv(undefined);
    setRowKey(undefined);
  }, [agentId, runId]);

  // The tab says whose audit this is.
  const dock = useDockPanel();
  useEffect(() => {
    if (agentId !== undefined) dock?.api.setTitle(`${agentId} · history and audit`);
  }, [dock, agentId]);

  const rows = useMemo(() => auditRows(data.records, endS), [data.records, endS]);
  const shownRows = useMemo(() => (dim ? rows : rowsInWindow(rows, view)), [rows, view, dim]);
  const findings = useMemo(() => (agentId === undefined ? "" : auditFindings(agentId, rows, data.records)), [agentId, rows, data.records]);
  const inView = useMemo(() => new Set(rowsInWindow(rows, view).map((r) => r.key)), [rows, view]);
  const series = useMemo(() => seriesInWindow(allSeries, new Set(agentId === undefined ? [] : [agentId]), view), [allSeries, agentId, view]);

  const lookup = useCallback(async (seq: number) => (runId === undefined ? undefined : recordBySeq(storage.ports, runId, seq)), [storage, runId]);
  const onMark = (s: AnalysisSeries, p: SeriesPoint) => {
    setMark({ key: s.key, point: p, series: s });
    if (s.source === "metric") setProv(metricProvenance(s, p, dt));
    else void computeProvenance(s, p, lookup, 4, (input) => commandsByInput(data.records).get(input)).then(setProv);
  };

  const selectRow = (r: AuditRow) => {
    setRowKey(r.key);
    if (runId === undefined) return;
    useUiContext.getState().selectRecord(r.seq === undefined ? undefined : { runId, seq: r.seq });
    jump(r.t0, agentId);
  };
  const selectedRow = rows.find((r) => r.key === rowKey && (r.seq === undefined || r.seq === sharedSeq)) ?? (sharedSeq === undefined ? undefined : rows.find((r) => r.seq === sharedSeq));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Escape") {
      setMark(undefined);
      setProv(undefined);
      setRowKey(undefined);
      useUiContext.getState().selectRecord(undefined);
    } else if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && selectedRow?.seq !== undefined) {
      e.preventDefault();
      openPanel("traceGraph");
    }
  };

  const exportCsv = () => {
    downloadBytes(new TextEncoder().encode(auditCsv(shownRows)), `${runId ?? "run"}-${agentId ?? "agent"}-audit.csv`, "text/csv");
    setNote(`exported the audit (${shownRows.length} rows)`);
  };

  if (agentId === undefined) {
    return (
      <div className="panel aa" data-testid="agent-audit">
        <p className="muted ah-empty" data-testid="agent-audit-empty">
          Select an agent: its history and its audit show what it did, why, and what caused it.
        </p>
      </div>
    );
  }

  const win = view === undefined ? "whole run" : `${view.t0.toFixed(1)}–${view.t1.toFixed(1)} s`;
  const span = view ?? { t0: 0, t1: endS };
  const jumpAudit = () => {
    const r = prov?.seq === undefined ? undefined : rows.find((x) => x.seq === prov.seq);
    if (r === undefined) return setNote("that record is not a row of the audit (it is a value of the planner, not an action)");
    selectRow(r);
    document.querySelector(`[data-audit-row="${r.key}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div className="panel aa" data-testid="agent-audit" data-agent={agentId} tabIndex={0} onKeyDown={onKey}>
      <p className="an-findings" data-testid="aa-findings">
        {data.loading && data.records.length === 0 ? "Reading the history…" : findings}
      </p>
      <div className="aa-body">
        <div className="aa-left">
          <div className="aa-hist">
            <AgentHistoryPanel compact data={data} view={view} onView={setView} />
          </div>
          <div className="aa-audit-bar">
            <b>Audit</b>
            <span className="muted" data-testid="aa-count">
              {win} · {shownRows.filter((r) => inView.has(r.key)).length} of {rows.length} rows
            </span>
            <span className="ah-spacer" />
            <button type="button" className={`kt${dim ? " on" : ""}`} aria-pressed={dim} onClick={() => setDim((d) => !d)} data-testid="aa-dim" data-tip="Dim the rows outside the brush instead of hiding them">
              dim, not hide
            </button>
            <button type="button" className="kt" onClick={exportCsv} disabled={shownRows.length === 0} data-testid="aa-csv">
              CSV
            </button>
          </div>
          <div className="aa-scroll">
            <table className="aa-table mono" data-testid="aa-table">
              <thead>
                <tr>
                  <th>time</th>
                  <th>action</th>
                  <th>outcome</th>
                  <th>reason</th>
                  <th>caused by</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => {
                  const outside = !inView.has(r.key);
                  const now = r.kind === "action" ? cursor >= r.t0 && cursor <= r.t1 : false;
                  return (
                    <tr
                      key={r.key}
                      className={`aa-row ${r.kind} L${r.level}${selectedRow?.key === r.key ? " sel" : ""}${outside ? " dim" : ""}${now ? " now" : ""}`}
                      data-testid={`aa-row-${r.key}`}
                      data-audit-row={r.key}
                      data-kind={r.kind}
                      data-seq={r.seq}
                      onClick={() => selectRow(r)}
                    >
                      <td>{r.t0.toFixed(1)}</td>
                      <td className="aa-what">
                        {r.level === 1 ? "└ " : ""}
                        <span className="ah-glyph">{r.glyph}</span> {r.what}
                      </td>
                      <td>{r.outcome}</td>
                      <td>{r.reason}</td>
                      <td className="muted">{r.causedBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="aa-right">
          <AnalysisSeriesView series={series} indexOf={(id) => Math.max(0, snap.entityIds.indexOf(id))} span={span} cursorS={cursor} selectedAgent={agentId} onSeek={(t) => jump(t, agentId)} onMark={onMark} marked={mark === undefined ? undefined : { key: mark.key, t: mark.point.t, v: mark.point.v }} />
          <section className="aa-prov" data-testid="aa-prov" aria-label="Where this value comes from">
            <h4 className="sec">Where this value comes from</h4>
            {prov === undefined ? (
              <p className="muted" data-testid="aa-prov-empty">
                Click a point on a chart: the records it comes from are here. Esc clears it.
              </p>
            ) : (
              <>
                <p data-testid="aa-prov-lead">{prov.lead}</p>
                <ol className="aa-chain mono" data-testid="aa-prov-chain">
                  {prov.chain.map((c, i) => (
                    <li key={`${i}-${c.label}`} data-relation={c.relation}>
                      {c.relation === "value" ? "" : c.relation === "cause" ? "← " : "parent "}
                      {c.label}
                    </li>
                  ))}
                </ol>
                <div className="aa-prov-actions">
                  {prov.kind === "compute" ? (
                    <button type="button" className="btn" onClick={jumpAudit} data-testid="aa-prov-audit">
                      → audit row
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      jump(prov.t, agentId);
                      openPanel("agentHistory");
                    }}
                    data-testid="aa-prov-history"
                  >
                    → history at {prov.t.toFixed(1)} s
                  </button>
                  {prov.seq !== undefined ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (runId !== undefined && prov.seq !== undefined) useUiContext.getState().selectRecord({ runId, seq: prov.seq });
                        openPanel("traceGraph");
                      }}
                      data-testid="aa-prov-graph"
                    >
                      ⧉ trace graph · T
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      requestLogFilter(`agent:${agentId} t:${Math.max(0, prov.t - 1.5).toFixed(1)}..${(prov.t + 1.5).toFixed(1)}`);
                      openPanel("eventList");
                    }}
                    data-testid="aa-prov-log"
                  >
                    ⌕ Log: this agent, ±1.5 s
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
      {note !== undefined ? <div className="an-foot mono muted">{note}</div> : null}
    </div>
  );
}
