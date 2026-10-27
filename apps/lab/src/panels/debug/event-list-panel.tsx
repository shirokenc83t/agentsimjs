import "../panels.css";
import { downloadBytes, KIND_STYLE, useUiContext } from "@agentsim/ui";
import { parseFilter, type FilterError, type TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { loadSavedFilters, storeSavedFilters, withoutSavedFilter, withSavedFilter, type SavedFilter } from "../../config/saved-filters.ts";
import { useAppActions, usePolled, useServices, useSource } from "../../services.tsx";
import { DerivedTag } from "./derived-tag.tsx";
import { resultOf } from "./log-rows.ts";
import { shownChoices, termValues, toggleChoice, withTermValues } from "./filter-text.ts";
import { LogList, type LogListHandle } from "./log-list.tsx";
import { takeLogFilterRequest, useLogFilterRequest } from "./log-filter-request.ts";
import { useJump } from "./use-jump.ts";
import { useLogRows } from "./use-log-rows.ts";

/** Pose samples are the bulk of a recording and are not events: the console leaves them out unless the filter asks for them (they are the Scene's, at the cursor). */
const NO_POSES = "-source:*/body";
const KIND_CHOICES = ["action", "reflex", "injected", "degradation", "compute", "plan", "event", "snapshot", "lifecycle", "observation", "thought", "message"] as const;
const TIER_CHOICES = ["S1", "S2", "external"] as const;
const EXPORT_PAGE = 2000;
const DEBOUNCE_MS = 150;

/** What the researcher typed, as the console reads it: a filter that parses (the one it queries with), or why it does not and where. */
export type FilterState = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string; readonly at: number };

/** A filter for the console: it lists records, so a `metric:` filter (samples) is not one; and a filter that does not parse is never run in part. */
export function readFilter(text: string): FilterState {
  const parsed = parseFilter(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message, at: (parsed.error as FilterError).details === undefined ? 0 : ((parsed.error.details as { at?: number }).at ?? 0) };
  if (parsed.value.target === "metrics") return { ok: false, message: "a metric: filter selects samples; the console lists records (the inspector's series pane shows metrics)", at: text.indexOf("metric:") < 0 ? 0 : text.indexOf("metric:") };
  return { ok: true, text };
}

/** The filter the console queries with: the typed one, and the pose samples left out unless the researcher named a source. */
export const effectiveFilter = (text: string): string => (text.includes("source:") ? text : `${text} ${NO_POSES}`.trim());

/**
 * The log console of the Debug workspace (UI-SPEC section 5, ADR-0035 section 5): a terminal-style prompt for the filter language, with the reason and the place of a
 * mistake, quick toggles for kinds and tiers that write into the text, saved filters, virtualized rows read from storage with the filter (the SQL backend), and for a
 * run that is being recorded a tail pushed by a live subscription (the same filter, the live backend). Selecting a row moves the shared cursor to its moment.
 */
export function EventListPanel() {
  const source = useSource();
  const { storage } = useServices();
  const { resimulateWindow, openPanel } = useAppActions();
  const openGraphFor = (_r: TraceRecord) => openPanel("traceGraph"); // the row is the selected record: the graph is about it
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const dt = snap.run?.dtS ?? 0.1;
  const headS = (snap.persistedHeadTick ?? 0) * dt;
  const jump = useJump(snap);
  const runId = snap.runId;
  const viewId = `log-${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const live = source.mode === "live" && snap.persistedHeadTick !== undefined;

  // The filter text is the one state: the toggles and the agent choice rewrite it.
  const [text, setText] = useState("");
  const state = useMemo(() => readFilter(text), [text]);
  // A filter another panel asked for (the agent history's "Log: this agent, window"), applied once per request; the request that was there when the Log opened is not one.
  const request = useLogFilterRequest();
  const [active, setActive] = useState("");
  useEffect(() => {
    if (!state.ok) return;
    if (state.text === active) return;
    const id = setTimeout(() => setActive(state.text), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [state, active]);
  const query = effectiveFilter(active);
  /** A change that is not typing (a toggle, a choice, a saved filter) applies at once; typing waits a moment so that a filter being typed is not queried at every key. */
  const edit = (next: string) => {
    setText(next);
    const s = readFilter(next);
    if (s.ok) setActive(s.text);
  };
  useEffect(() => {
    const asked = takeLogFilterRequest();
    if (asked !== undefined) edit(asked);
  }, [request.id]);

  const [atEnd, setAtEnd] = useState(true);
  const paused = live && !atEnd;
  const { rows, more, pending, tail, loadMore, flush } = useLogRows({ storage, runId, filter: query, headS, tail: live, paused, viewId });
  const list = useRef<LogListHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<TraceRecord | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [message, setMessage] = useState<string | undefined>(undefined);

  // A new run or a new filter starts the list again. The selected record is the shared one: another filter does not unselect it (the trace tree still shows it), the detail
  // keeps it, and the list marks it when the new result has it.
  useEffect(() => {
    setExpanded(new Set());
    setAtEnd(true);
  }, [runId, query]);
  useEffect(() => setSelected(undefined), [runId]);
  // The tail follows: the list at its end stays at its end as records arrive.
  useEffect(() => {
    if (live && atEnd) list.current?.scrollToEnd();
  }, [rows.length, live, atEnd]);

  const select = (r: TraceRecord) => {
    setSelected(r);
    // The picked row stays in view: the tail stops following (it would scroll the row away as records arrive) and the list shows it.
    setAtEnd(false);
    requestAnimationFrame(() => list.current?.scrollToSeq(r.seq));
    if (runId !== undefined) useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };
  // A record picked elsewhere (the trace tree, a pane of the inspector) is the selected row here too, when the console has read it.
  const picked = useUiContext((s) => s.selectedRecord);
  useEffect(() => {
    if (picked === undefined || picked.runId !== runId || selected?.seq === picked.seq) return;
    const r = rows.find((x) => x.seq === picked.seq);
    if (r) {
      setSelected(r);
      list.current?.scrollToSeq(r.seq);
      return;
    }
    // Not in this filter's result: its detail is read from storage all the same, so the console and the trace tree always speak of the same record.
    if (runId === undefined) return;
    let off = false;
    void storage.ports.trace.query({ runId, afterSeq: picked.seq - 1, limit: 1 }).then(([x]) => {
      if (off || x?.seq !== picked.seq) return;
      setSelected(x);
      setAtEnd(false);
      requestAnimationFrame(() => list.current?.scrollToSeq(x.seq));
    });
    return () => {
      off = true;
    };
  }, [picked, runId, rows, selected?.seq, storage]);
  const goToEnd = () => {
    flush();
    setAtEnd(true);
    requestAnimationFrame(() => list.current?.scrollToEnd());
  };

  const copyJson = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      setMessage(`copied #${selected.seq} as JSON`);
    } catch {
      setMessage("the clipboard is not available here");
    }
  };
  const flagAt = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (resultOf(rows[i] as TraceRecord)?.failed) return i;
    return -1;
  };
  /** The console's own keys (UI-SPEC 5.3): the list handles movement and ⏎. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const at = selected ? rows.findIndex((r) => r.seq === selected.seq) : -1;
    switch (e.key) {
      case "/":
        input.current?.focus();
        return true;
      case "f":
        goToEnd();
        return true;
      case " ":
        if (selected) setExpanded((cur) => (cur.has(selected.seq) ? new Set([...cur].filter((x) => x !== selected.seq)) : new Set([...cur, selected.seq])));
        return selected !== undefined;
      case "y":
        void copyJson();
        return selected !== undefined;
      case "[":
      case "]": {
        const i = flagAt(at, e.key === "[" ? -1 : 1);
        if (i < 0) return true;
        const r = rows[i] as TraceRecord;
        select(r);
        list.current?.scrollToSeq(r.seq);
        return true;
      }
      default:
        return false;
    }
  };

  // The quick toggles and the agent choice write into the text.
  const kindsShown = shownChoices(text, "kind", KIND_CHOICES);
  const tiersShown = shownChoices(text, "tier", TIER_CHOICES);
  const agentTerm = termValues(text, "agent");
  const agent = agentTerm?.length === 1 ? (agentTerm[0] as string) : "";

  // Saved filters.
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [naming, setNaming] = useState(false);
  useEffect(() => {
    let off = false;
    void loadSavedFilters(storage.ports.userData).then((l) => !off && setSaved(l));
    return () => {
      off = true;
    };
  }, [storage]);
  const persist = (next: SavedFilter[]) => {
    setSaved(next);
    void storeSavedFilters(storage.ports.userData, next);
  };

  /** The whole result of the filter as JSON lines (read from storage up to what is saved), downloaded. */
  const exportJsonl = async () => {
    if (runId === undefined || !state.ok) return;
    setMessage("exporting…");
    const lines: string[] = [];
    for (let after = -1; ; ) {
      const page = await storage.ports.trace.query({ runId, afterSeq: after, limit: EXPORT_PAGE, simTime: { to: headS }, ...(query === "" ? {} : { filter: query }) });
      for (const r of page) lines.push(JSON.stringify(r));
      if (page.length < EXPORT_PAGE) break;
      after = (page[page.length - 1] as TraceRecord).seq;
    }
    downloadBytes(new TextEncoder().encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`), `${runId}${active === "" ? "" : "-filtered"}.jsonl`, "application/x-ndjson");
    setMessage(`exported ${lines.length} records`);
  };
  /** The window of a re-simulation here: the Timeline's selection if there is one, else the time range in view. */
  const resimulate = () => {
    if (useUiContext.getState().timeSelection === undefined) {
      const v = list.current?.visibleRange();
      if (v) useUiContext.getState().setTimeSelection({ t0S: Math.floor(v.t0S * 10) / 10, t1S: Math.ceil(v.t1S * 10) / 10 });
    }
    resimulateWindow();
  };

  const selectedTag = selected ? (KIND_STYLE[selected.kind as keyof typeof KIND_STYLE]?.tag ?? selected.kind.slice(0, 3).toUpperCase()) : undefined;
  const counts =
    tail?.sampled === true ? (
      <span className="warn" data-testid="event-count" title="The display samples a tail that is faster than it can show; the recording is not sampled.">
        shown {tail.shown} / recorded {tail.matched}
      </span>
    ) : (
      <span className="muted" data-testid="event-count">
        {text.trim() === "" ? "no filter · " : ""}
        {rows.length}
        {more ? "+" : ""} records
      </span>
    );

  return (
    <div className="panel event-list" data-testid="event-list">
      <div className="prompt mono" role="group" aria-label="Filter">
        <span className="ps">{runId ?? "no run"}</span>
        <DerivedTag derived={snap.replay?.derived} />
        <span className="pf">$</span>
        <input
          ref={input}
          className={`log-filter mono${state.ok ? "" : " err"}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              (e.target as HTMLInputElement).blur();
              list.current?.focus();
            }
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder='e.g. agent:uav-001 kind:action t:>20 text:"battery low" source:*/planner'
          aria-label="Filter"
          aria-invalid={!state.ok}
          data-testid="log-filter"
        />
        <label>
          <span className="pf">agent:</span>
          <select value={agent} onChange={(e) => edit(withTermValues(text, "agent", e.target.value === "" ? undefined : [e.target.value]))} aria-label="Agent filter" data-testid="event-filter-agent">
            <option value="">all</option>
            {snap.entityIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <span className="sp" />
        {counts}
      </div>
      {!state.ok && (
        <div className="log-error mono" role="alert" data-testid="log-filter-error">
          <span className="danger">✕ {state.message}</span> <span className="muted">· at {state.at}</span>
          <pre className="log-caret" aria-hidden="true">
            {text}
            {"\n"}
            {" ".repeat(Math.min(state.at, text.length))}^
          </pre>
        </div>
      )}
      <div className="kinds" role="group" aria-label="Kinds and tiers">
        {KIND_CHOICES.map((k) => {
          const style = KIND_STYLE[k as keyof typeof KIND_STYLE];
          const on = kindsShown.has(k);
          return (
            <button
              key={k}
              type="button"
              className={`kt${on ? "" : " off"}`}
              aria-pressed={on}
              data-testid={`event-kind-${k}`}
              data-tip={`${k}: click to show or hide it, shift+click to show it alone`}
              onClick={(e) => edit(toggleChoice(text, "kind", k, KIND_CHOICES, e.shiftKey))}
            >
              <span className="tag" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
                {style?.tag ?? k.slice(0, 3).toUpperCase()}
              </span>{" "}
              {k}
            </button>
          );
        })}
        <span className="sep" aria-hidden="true" />
        {TIER_CHOICES.map((t) => (
          <button
            key={t}
            type="button"
            className={`kt${tiersShown.has(t) ? "" : " off"}`}
            aria-pressed={tiersShown.has(t)}
            data-testid={`event-tier-${t}`}
            data-tip={`tier ${t}: click to show or hide it, shift+click to show it alone`}
            onClick={(e) => edit(toggleChoice(text, "tier", t, TIER_CHOICES, e.shiftKey))}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="log-actions" role="group" aria-label="Log actions">
        <select
          className="kt"
          value=""
          onChange={(e) => {
            const f = saved.find((x) => x.name === e.target.value);
            if (f) edit(f.text);
          }}
          aria-label="Saved filters"
          data-testid="log-saved"
        >
          <option value="">saved filters ▾</option>
          {saved.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
        {naming ? (
          <input
            className="kt mono"
            autoFocus
            aria-label="Name of the filter"
            placeholder="name, Enter to save"
            maxLength={40}
            data-testid="log-save-name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                persist(withSavedFilter(saved, (e.target as HTMLInputElement).value, text));
                setNaming(false);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setNaming(false);
              }
            }}
            onBlur={() => setNaming(false)}
          />
        ) : (
          <button type="button" className="kt" disabled={!state.ok || text.trim() === ""} onClick={() => setNaming(true)} data-testid="log-save">
            save
          </button>
        )}
        {saved.some((f) => f.text === text) && (
          <button type="button" className="kt" onClick={() => persist(withoutSavedFilter(saved, saved.find((f) => f.text === text)?.name ?? ""))} data-testid="log-unsave">
            unsave
          </button>
        )}
        <button type="button" className="kt" disabled={rows.length === 0 || !state.ok} onClick={() => void exportJsonl()} data-testid="log-export">
          export JSONL
        </button>
        <button type="button" className="kt" disabled={runId === undefined} onClick={resimulate} data-testid="log-resim" data-tip="Re-simulate the selected window (the Timeline's selection, else the time in view) into a derived run">
          re-simulate window
        </button>
      </div>
      {live && (
        <div className="log-tail mono" data-testid="log-tail" data-state={paused ? "paused" : "following"}>
          {paused ? (
            <button type="button" className="kt" onClick={goToEnd} data-testid="log-new">
              ❚❚ paused · {pending} new ↓ (f)
            </button>
          ) : (
            <span className="ok">● tail · following (scroll up to pause)</span>
          )}
        </div>
      )}
      <LogList
        onOpenGraph={(r) => openGraphFor(r)}
        ref={list}
        rows={rows}
        more={more}
        onNeedMore={loadMore}
        entityIds={snap.entityIds}
        selectedSeq={selected?.seq}
        expanded={expanded}
        onSelect={select}
        onJump={(r) => jump(r.simTime, r.agentId)}
        onKey={onKey}
        onAtEnd={setAtEnd}
        label="Events"
        testId="event-scroller"
      />
      <pre className="event-detail mono" data-testid="event-detail" aria-label="Selected record">
        {selected ? JSON.stringify(selected, null, 2).slice(0, 4000) : "Select an event to see its record."}
      </pre>
      <div className="lfoot mono" data-testid="event-footer">
        <span>{selected ? `sel #${selected.seq} · ${selectedTag}` : "nothing selected"}</span>
        {message !== undefined && <span className="muted">{message}</span>}
        <span className="sp" />
        <span>/ filter · j k move · ⏎ jump · space open · f follow · g G ends · [ ] flags · y copy</span>
      </div>
    </div>
  );
}
