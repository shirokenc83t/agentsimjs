import "./panels/panels.css";
import { STATE_GLYPH } from "@agentsim/ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LabRun } from "./sim/run-controller.ts";
import { RecordingControls } from "./recording-controls.tsx";
import type { SimSnapshot } from "./sim/sim-client.ts";

/**
 * The popover's body: a panel anchored under its trigger, with an edge and the `float` shadow (ADR-0042). Escape and a press outside close it, and
 * the focus goes in on opening and back to the trigger on closing. It keeps to the viewport: a panel wider than the room to the right of the
 * trigger is moved left.
 */
function Anchored(props: { anchor: HTMLElement; onClose: () => void; label: string; children: ReactNode }) {
  const { anchor } = props;
  const box = useRef<HTMLDivElement>(null);
  // The parent passes a new `onClose` on every render: the listeners below read the latest through a ref, so they are set once.
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const [left, setLeft] = useState<number | undefined>(undefined);
  const at = anchor.getBoundingClientRect();
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 0;
    setLeft(Math.max(8, Math.min(anchor.getBoundingClientRect().left, window.innerWidth - w - 8)));
  }, [anchor]);
  // Hidden until placed (it is measured first), so the focus goes in once it is shown.
  const placed = left !== undefined;
  useEffect(() => {
    if (!placed) return;
    const first = box.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    (first ?? box.current)?.focus();
  }, [placed]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target) && !anchor.contains(e.target)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);
  return (
    <div
      ref={box}
      className="run-info floating"
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      style={{ position: "fixed", top: at.bottom + 4, left: left ?? 0, visibility: left === undefined ? "hidden" : undefined, maxHeight: `calc(100vh - ${at.bottom + 16}px)`, overflow: "auto" }}
    >
      {props.children}
    </div>
  );
}

export interface RunPopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  run: LabRun | undefined;
  snap: SimSnapshot;
  busy: boolean;
  error: string | null;
  onLoadDemo: () => void;
  /** The 1 km² / 0.5 m reference world (built in the sim worker). */
  onLoadReference: () => void;
  onRerun: () => void;
  /** Stored runs that can be re-simulated (newest first), with their recorded input counts. */
  listRuns: () => Promise<{ runId: string; label: string; inputs: number }[]>;
  onResimulate: (runId: string) => void;
  /** Shows a stored run in the panels, read from storage. */
  onReplay?: ((runId: string) => void) | undefined;
}

/**
 * Reproducibility header of the run (ADR-0028): run ID, scenario version, seed, time mode, both
 * configuration hashes, simulator version and the live state hash; starting runs is here too. Loaded on
 * first open (the toolbar keeps only the label), to keep the initial chunk within its gate.
 */
export function RunPopover(props: RunPopoverProps) {
  const { run, snap, busy, error, listRuns } = props;
  const h = run?.header;
  const [stored, setStored] = useState<{ runId: string; label: string; inputs: number }[] | undefined>(undefined);
  // Refreshed when the popover opens and whenever the current run changes (its inputs are stored as recorded).
  useEffect(() => {
    let alive = true;
    void listRuns().then(
      (r) => alive && setStored(r),
      () => alive && setStored([]),
    );
    return () => {
      alive = false;
    };
  }, [listRuns, run, snap.hashTick]);
  return (
    <>
      <Anchored anchor={props.anchor} onClose={props.onClose} label="Run">
        <h3>Run</h3>
        {h ? (
          <dl className="kv" data-testid="run-header">
            <dt>run</dt>
            <dd data-testid="run-id">{h.runId}</dd>
            <dt>label</dt>
            <dd>{h.label}</dd>
            <dt>scenario</dt>
            <dd data-testid="run-scenario">
              {h.scenarioId} v{h.scenarioVersion}
            </dd>
            <dt>seed</dt>
            <dd>{h.seed}</dd>
            <dt>time mode</dt>
            <dd>{run.loaded.timeMode}</dd>
            <dt>run config</dt>
            <dd data-testid="run-config-hash">{h.runConfigHash}</dd>
            <dt>effective config</dt>
            <dd data-testid="effective-config-hash">{h.effectiveConfigHash}</dd>
            <dt>ideal beliefs</dt>
            <dd data-testid="ideal-agents" title="Agents whose belief map is ground truth (baselines only), as resolved at run start">
              {h.idealAgents === undefined ? "—" : h.idealAgents.length === 0 ? "none" : h.idealAgents.join(", ")}
            </dd>
            <dt>world hash</dt>
            <dd data-testid="world-hash" title="Hash of every grid layer at load">
              {run.loaded.worldHash}
            </dd>
            <dt>simulator</dt>
            <dd data-testid="simulator-version">{h.simulatorVersion}</dd>
            <dt>recording</dt>
            <dd data-testid="run-recording" title="How the run is recorded (ADR-0035): the profile and its hash, or not at all (the researcher's opt-out)">
              {h.recording === "stored" ? `${(h.recordingProfile as { name?: string } | undefined)?.name ?? "profile"} · ${h.recordingProfileHash}` : h.recording === "none" ? "○ not recorded" : "—"}
            </dd>
            {snap.prepared?.runId === h.runId && (
              <>
                <dt>planning prep</dt>
                <dd data-testid="planning-prepare" title="Planning views and HPA* graphs built before tick 0 (wall time; not part of the run)">
                  {snap.prepared.views} view{snap.prepared.views === 1 ? "" : "s"}, {snap.prepared.graphs} HPA* graph{snap.prepared.graphs === 1 ? "" : "s"} · {Math.round(snap.prepared.ms)} ms
                </dd>
              </>
            )}
            <dt>state hash</dt>
            <dd data-testid="state-hash">
              {snap.stateHash ? `${snap.stateHash} @ tick ${snap.hashTick ?? "?"}` : "—"}
            </dd>
          </dl>
        ) : (
          <p className="muted">No scenario loaded: the F0 placeholder world is running.</p>
        )}
        <RecordingControls realtime={snap.mode === "realtime"} />
        <div className="row">
          {/* Busy buttons stay focusable (aria-disabled, clicks ignored): disabling them would drop focus out of
              the popover, and Escape would no longer close it. */}
          <button type="button" className="btn" onClick={() => !busy && props.onLoadDemo()} aria-disabled={busy} data-testid="load-demo">
            Load F1 demo
          </button>
          <button type="button" className="btn" onClick={() => !busy && props.onLoadReference()} aria-disabled={busy} data-testid="load-reference">
            Load 1 km² reference world
          </button>
          <button type="button" className="btn pri" onClick={() => !busy && run && props.onRerun()} aria-disabled={busy || !run} disabled={!run} data-testid="rerun">
            Re-run
          </button>
        </div>
        <h4 className="muted">Stored runs</h4>
        {stored === undefined ? (
          <p className="muted">…</p>
        ) : stored.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="stored-runs" data-testid="stored-runs">
            {stored.map((r) => (
              <li key={r.runId} data-testid={`stored-run-${r.runId}`}>
                <span className="mono">{r.runId}</span> <span className="muted">{r.label}</span>{" "}
                <span className="mono" data-testid={`stored-run-inputs-${r.runId}`}>
                  {r.inputs} input{r.inputs === 1 ? "" : "s"}
                </span>{" "}
                {props.onReplay && (
                  <button type="button" className="btn" onClick={() => props.onReplay?.(r.runId)} data-testid={`replay-stored-${r.runId}`} aria-label={`Replay ${r.runId}`} title="Show this run from storage: the live run is not touched">
                    ◷ replay
                  </button>
                )}{" "}
                <button type="button" className="btn" onClick={() => !busy && props.onResimulate(r.runId)} aria-disabled={busy} data-testid={`resimulate-${r.runId}`} title="Run it again from its scenario version, run configuration and inputs: a new run (to look at a recording, open it from the Storage browser)">
                  Re-simulate
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="danger" role="alert" data-testid="run-error">
            {STATE_GLYPH.alm} {error}
          </p>
        )}
      </Anchored>
    </>
  );
}
