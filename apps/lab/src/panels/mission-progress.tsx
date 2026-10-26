import { useUiContext } from "@agentsim/ui";
import { useAppActions } from "../services.tsx";
import { STEP_GLYPH, type MissionView } from "./mission-view.ts";

const STATE_WORDS = { done: "done", running: "running", pending: "to do", preempted: "preempted", refused: "refused", failed: "failed", skipped: "not run" } as const;
/** The tone class of a step state (the Inspector's own state colours). */
const TONE = { done: "st-ok", running: "st-run", pending: "muted", preempted: "st-warn", refused: "st-alm", failed: "st-alm", skipped: "muted" } as const;
const argsText = (a: Readonly<Record<string, unknown>> | undefined) =>
  Object.entries(a ?? {})
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ");

/**
 * The Mission section of the agent Inspector (F3c M1): a bar of the steps' durations, one row per step (glyph, action, arguments, state, duration), and a stop in one line of words.
 * A click on a row selects the step's decision record in the trace; `edit ↗` opens the run configuration, where the mission is written.
 */
export function MissionProgress(props: { agentId: string; runId: string; view: MissionView }) {
  const { view } = props;
  const actions = useAppActions();
  const select = (seq: number | undefined) => seq !== undefined && useUiContext.getState().selectRecord({ runId: props.runId, seq });
  const total = view.steps.reduce((n, s) => n + (s.durationS ?? 0), 0);
  return (
    <section className="inspector-section mission-progress" data-testid="inspector-mission" data-status={view.status}>
      <h4>
        Mission <span className="muted mono">· step {view.current} / {view.of}</span>
        <button type="button" className="kt mp-edit" onClick={() => actions.openPanel("runConfig")} data-testid="mp-edit" title="Open the run configuration, where the mission is written">
          edit ↗
        </button>
      </h4>
      {view.stop !== undefined && (
        <p className="mp-stop st-alm" role="status" data-testid="mp-stop">
          ■ {view.stop.line}
        </p>
      )}
      <div className="mp-bar" aria-hidden="true" data-testid="mp-bar">
        {view.steps.map((s) => (
          <span key={s.index} className={`mp-seg mp-${s.state}`} style={{ flexGrow: Math.max(s.durationS ?? 0, total / 20 || 1) }} />
        ))}
      </div>
      <ol className="mp-rows">
        {view.steps.map((s) => (
          <li key={s.index} data-testid={`mp-row-${s.index}`} data-state={s.state}>
            <button type="button" className="mp-row mono" onClick={() => select(s.decisionSeq)} disabled={s.decisionSeq === undefined} aria-label={`Step ${s.index + 1}, ${s.action}, ${STATE_WORDS[s.state]}`}>
              <span className={`mp-glyph ${TONE[s.state]}`} data-testid={`mp-glyph-${s.index}`}>
                {STEP_GLYPH[s.state]}
              </span>
              <span className="mp-n">{s.index + 1}</span>
              <span className="mp-action">{s.action}</span>
              <span className="mp-args muted">{argsText(s.args)}</span>
              <span className="mp-state">
                {STATE_WORDS[s.state]}
                {s.detail !== undefined && s.state !== "done" ? ` · ${s.detail}` : ""}
              </span>
              <span className="mp-dur muted">{s.durationS !== undefined ? `${s.durationS.toFixed(1)} s` : s.startedAtS !== undefined ? `since ${s.startedAtS.toFixed(1)} s` : ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
