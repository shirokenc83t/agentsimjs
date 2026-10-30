import type { SimMindsMessage } from "@agentsim/core";
import { useEffect, useRef, useState } from "react";
import { allowsWords, kilo, LIMIT_WORDS, pctOf, rateWords, raisePresets, spaced, tileAgent, usedOf, usedWords, validRaise, worstLimit, type AgentMinds, type LimitName } from "./minds-limits.ts";
import { closeWarningNotice, useMinds, WARNING_NOTICE_MS } from "./minds-status.ts";

// The System 2 minds in the shell (F4 T-110, the designer's LimitsPause): the player's tiles, the chips of the status bar, "waiting for S2" under the clock, the 80 % notice, the pause notice and the dialog
// that raises a limit. All of it reads the one store the worker's `minds` messages fill; none of it touches a run: a raise or a stop is an answer sent to the worker.

/** A wall clock that ticks every `ms` while `active` (the figure of a wait). */
function useNow(active: boolean, ms = 200): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

// ---- waiting for S2 ------------------------------------------------------------------------------------------------------------------------------

/** `◷ waiting for S2 (1) · uav-001 · 2.4 s`, or `◷ waiting for S2 (3) · longest 4.1 s`: the sim clock waits (lockstep) and the UI stays free. */
export function waitingWords(m: SimMindsMessage, elapsedMs: number): string {
  const who = m.waiting === 1 && m.agents.length === 1 ? ` · ${m.agents[0]?.agentId}` : "";
  return `◷ waiting for S2 (${m.waiting})${who} · ${m.waiting > 1 ? "longest " : ""}${seconds(elapsedMs)}`;
}

/** The note under the clock. Nothing while no decision waits. */
export function WaitingNote() {
  const { status, waitingSinceMs } = useMinds();
  const now = useNow(waitingSinceMs !== undefined);
  if (status === undefined || status.waiting === 0 || waitingSinceMs === undefined) return null;
  return (
    <span className="s2-wait mono" data-testid="player-s2-wait" title={status.agents.map((a) => `${a.agentId} · ${a.model}`).join("\n")}>
      {waitingWords(status, now - waitingSinceMs)}
    </span>
  );
}

// ---- the player's tiles ---------------------------------------------------------------------------------------------------------------------------

/** The LLM tile and the calls tile of the player: what the minds have used of their limits; warn from 80 %, and the new limit after a raise. */
export function MindsTiles() {
  const { status } = useMinds();
  if (status === undefined) return null;
  const a = tileAgent(status);
  if (a === undefined) return null;
  const w = worstLimit(a);
  const warn = w.pct >= 80 || status.pausedAt !== undefined;
  return (
    <>
      <div className="tile s2-tile" data-testid="player-llm-tile" data-warn={warn ? "true" : "false"}>
        <span className="lbl">LLM · {a.agentId}</span>
        <span className={`v mono${warn ? " warn" : ""}`}>
          {kilo(a.tokens)} <small>/{kilo(a.limits.tokens)} tok</small>
        </span>
      </div>
      <div className="tile s2-tile" data-testid="player-calls-tile">
        <span className="lbl">calls</span>
        <span className={`v mono${pctOf(a, "calls") >= 80 ? " warn" : ""}`}>
          {a.calls} <small>/{a.limits.calls}</small>
        </span>
      </div>
    </>
  );
}

// ---- the status bar --------------------------------------------------------------------------------------------------------------------------------

/** What the status bar says of the minds: the wait, the 80 % chip, the pause, and where the answers come from. */
export function MindsStatusSegments() {
  const { status, waitingSinceMs } = useMinds();
  const now = useNow(waitingSinceMs !== undefined);
  if (status === undefined) return null;
  const a = tileAgent(status);
  const w = a === undefined ? undefined : worstLimit(a);
  const p = status.pausedAt;
  return (
    <>
      {status.waiting > 0 && waitingSinceMs !== undefined && (
        <span className="seg s2-chip run" data-prio="2" data-testid="status-s2-wait">
          {waitingWords(status, now - waitingSinceMs)}
        </span>
      )}
      {p !== undefined ? (
        <span className="seg s2-chip warn" data-prio="1" data-testid="status-s2-limit">
          ■ {LIMIT_WORDS[p.limit].short} {p.limit === "costUsd" ? p.used.toFixed(4) : spaced(p.used)} / {p.limit === "costUsd" ? p.max.toFixed(4) : spaced(p.max)} · {p.agentId}
        </span>
      ) : (
        a !== undefined &&
        w !== undefined &&
        w.pct >= 80 && (
          <span className="seg s2-chip warn" data-prio="2" data-testid="status-s2-warning">
            ▲ {LIMIT_WORDS[w.limit].short} {w.pct} % · {a.agentId}
          </span>
        )
      )}
      {a !== undefined && (
        <span className="seg mono" data-prio="6" data-testid="status-s2-minds" title={`${a.provider} · ${a.model}${a.profile === undefined ? "" : ` · ${a.profile}`}`}>
          {status.mode === "live" ? "live" : status.mode} · {a.provider} · {a.model}
        </span>
      )}
    </>
  );
}

// ---- the notice ------------------------------------------------------------------------------------------------------------------------------------

export interface LimitNoticeProps {
  /** The step of the run in seconds, for the clock in the notice's header. */
  readonly dtS: number;
  readonly onRaise: (a: { readonly agentId: string; readonly limit: LimitName; readonly value: number }) => void;
  readonly onStop: (a: { readonly agentId: string; readonly limit: LimitName }) => void;
}

/**
 * The notice of a limit: non-modal, at the dock's top left. At 80 % it appears once, without buttons, and closes by itself after 8 s; at a limit it stays, says which limit and for whom, how much was used,
 * the other limits, that the world waits and nothing is lost, and offers "Raise limit…" (a dialog that states the new value and whose consumption it is) and "Stop run".
 */
export function LimitNotice(props: LimitNoticeProps) {
  const { status, warningNotice } = useMinds();
  const [raising, setRaising] = useState(false);
  const now = useNow(warningNotice !== undefined);
  useEffect(() => {
    if (warningNotice === undefined) return;
    const left = WARNING_NOTICE_MS - (performance.now() - warningNotice.shownAtMs);
    const id = setTimeout(closeWarningNotice, Math.max(0, left));
    return () => clearTimeout(id);
  }, [warningNotice]);
  const p = status?.pausedAt;
  useEffect(() => {
    if (p === undefined) setRaising(false);
  }, [p]);
  if (status === undefined) return null;
  if (p !== undefined) {
    const a = status.agents.find((x) => x.agentId === p.agentId);
    if (a === undefined) return null;
    const words = LIMIT_WORDS[p.limit];
    const others = (["calls", "tokens", "costUsd"] as const).filter((l) => l !== p.limit).map((l) => (l === "costUsd" ? (a.pricesKnown ? `cost ${a.costUsd.toFixed(4)} / ${a.limits.costUsd.toFixed(2)}` : `cost — (no prices for ${a.provider})`) : `${LIMIT_WORDS[l].short} ${spaced(usedOf(a, l))} / ${spaced(a.limits[l])}`));
    return (
      <>
        <div className="limit-notice" role="alertdialog" aria-label="Run paused by a limit" data-testid="limit-notice" data-limit={p.limit}>
          <div className="ln-h">
            <span className="warn">■</span>
            <b>Run paused: {words.title.replace(" limit", "")} limit reached</b>
            <span className="sp" />
            <span className="muted mono">
              {(p.tick * props.dtS).toFixed(1)} s · tick {p.tick}
            </span>
          </div>
          <div className="ln-b">
            <span className="muted">limit</span>
            <span>
              <b>{words.short} per run</b> · {a.agentId}
              {a.profile === undefined ? "" : ` · profile ${a.profile}`}
            </span>
            <span className="muted">used</span>
            <span className="mono" data-testid="limit-used">
              <b>{p.limit === "costUsd" ? p.used.toFixed(4) : spaced(p.used)}</b> {usedWords(p.used, p.max, p.limit).replace(/^[^ ]+ /, "")}
              <div className="ln-meter">
                <i style={{ width: `${Math.min(100, (p.used / Math.max(p.max, 1e-9)) * 100)}%` }} />
              </div>
            </span>
            <span className="muted">other limits</span>
            <span className="mono">{others.join(" · ")}</span>
            <span className="muted">what happens</span>
            <span className="prose">
              The world waits at tick {p.tick}. Nothing is lost: the decision in progress finished and was recorded. Raise the limit to continue, or stop the run here.
            </span>
          </div>
          <div className="ln-f">
            <button type="button" className="btn pri" onClick={() => setRaising(true)} data-testid="limit-raise">
              Raise limit…
            </button>
            <button type="button" className="btn dang" onClick={() => props.onStop({ agentId: p.agentId, limit: p.limit })} data-testid="limit-stop">
              ■ Stop run
            </button>
            <span className="sp" />
            <span className="muted">headless: the run ends with "limit reached"</span>
          </div>
        </div>
        {raising && (
          <RaiseDialog
            agent={a}
            limit={p.limit}
            tick={p.tick}
            onCancel={() => setRaising(false)}
            onConfirm={(value) => {
              setRaising(false);
              props.onRaise({ agentId: p.agentId, limit: p.limit, value });
            }}
          />
        )}
      </>
    );
  }
  if (warningNotice === undefined || now - warningNotice.shownAtMs > WARNING_NOTICE_MS) return null;
  const a = status.agents.find((x) => x.agentId === warningNotice.agentId);
  if (a === undefined) return null;
  const used = usedOf(a, warningNotice.limit);
  return (
    <div className="limit-notice warning" role="status" aria-label="Limit warning" data-testid="limit-warning-notice">
      <div className="ln-h">
        <span className="warn">▲</span>
        <b>
          {LIMIT_WORDS[warningNotice.limit].title.replace(" limit", "")} limit at {warningNotice.pct} %
        </b>
        <span className="sp" />
        <span className="muted mono">{a.agentId}</span>
      </div>
      <div className="ln-b one">
        <span className="mono">{usedWords(used, a.limits[warningNotice.limit], warningNotice.limit)}</span>
        <span className="prose">The run pauses at the limit and waits for you.</span>
      </div>
    </div>
  );
}

// ---- the dialog ------------------------------------------------------------------------------------------------------------------------------------

export interface RaiseDialogProps {
  readonly agent: AgentMinds;
  readonly limit: LimitName;
  readonly tick: number;
  readonly onCancel: () => void;
  readonly onConfirm: (value: number) => void;
}

/** The modal that raises a limit: it states the new value and that consumption is the researcher's responsibility, and its button says the value. Escape cancels. */
export function RaiseDialog(props: RaiseDialogProps) {
  const { agent: a, limit, tick } = props;
  const max = a.limits[limit];
  const presets = raisePresets(limit, max);
  const [text, setText] = useState(String(presets[1]?.value ?? max * 2));
  const value = Number(text.replace(/[^0-9.]/g, ""));
  const ok = validRaise(value, max);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const words = LIMIT_WORDS[limit];
  const fmt = (n: number) => (limit === "costUsd" ? n.toFixed(2) : spaced(n));
  return (
    <>
      <div className="scrim s2-scrim" aria-hidden="true" />
      <div
        className="raise-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Raise the ${words.short} limit`}
        data-testid="raise-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          } else if (e.key === "Enter" && ok) {
            e.preventDefault();
            props.onConfirm(value);
          }
        }}
      >
        <div className="rd-h">
          Raise the {words.short === "calls" ? "call" : words.short === "tokens" ? "token" : "cost"} limit for {a.agentId}
          <span className="sp" />
          <span className="muted">Esc cancels</span>
        </div>
        <div className="rd-b">
          <div className="rd-kv">
            <span className="k">limit</span>
            <span>
              {words.short} per run{a.profile === undefined ? "" : ` · profile ${a.profile}`} · this run only
            </span>
            <span className="k">used so far</span>
            <span className="mono">
              {limit === "costUsd" ? `${usedOf(a, limit).toFixed(4)} USD` : `${spaced(usedOf(a, limit))} ${words.unit}`} · {a.calls} calls · {rateWords(a)}
            </span>
            <span className="k">new limit</span>
            <span className="rd-new">
              <input ref={input} className="rd-input mono" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-label={`New ${words.short} limit`} aria-invalid={!ok} data-testid="raise-input" />
              <span className="rd-presets">
                {presets.map((p) => (
                  <button key={p.label} type="button" onClick={() => setText(String(p.value))} data-testid={`raise-preset-${p.label.replace(/[^a-z0-9]/gi, "")}`}>
                    {p.label}
                  </button>
                ))}
              </span>
            </span>
            <span className="k">this allows</span>
            <span className="mono" data-testid="raise-allows">
              {ok ? allowsWords(a, limit, value) : `a value above ${fmt(max)}`}
            </span>
            <span className="k">cost</span>
            <span className="muted">{a.pricesKnown ? `cost so far ${a.costUsd.toFixed(4)} USD (limit ${a.limits.costUsd.toFixed(2)})` : `no prices set for ${a.provider} · Settings → Providers`}</span>
          </div>
          <p className="prose">
            Token counts come from the server and may differ from a provider's bill. <b>Consumption is your responsibility.</b> The raise is recorded as a researcher input at tick {tick} and replayed with the run.
          </p>
        </div>
        <div className="rd-f">
          <span className="muted">the profile's own limit is not changed</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={props.onCancel} data-testid="raise-cancel">
            Cancel
          </button>
          <button type="button" className="btn pri" disabled={!ok} onClick={() => props.onConfirm(value)} data-testid="raise-confirm">
            Raise to {fmt(ok ? value : max)} and resume
          </button>
        </div>
      </div>
    </>
  );
}
