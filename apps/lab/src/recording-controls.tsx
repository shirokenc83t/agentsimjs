import { RECORDING_PRESETS, type RecordingPresetName } from "@agentsim/trace";
import { useSyncExternalStore } from "react";
import { getRecordingSelection, isHeavyProfile, profileOfSelection, setRecordingSelection, subscribeRecordingSelection } from "./sim/recording-choice.ts";

/**
 * The recording choice next to the run configuration at launch (ADR-0035 addition of 2026-10-17, items 2 and 6): a preset or a profile as JSON,
 * and "Don't record this run", the researcher's explicit opt-out for the next run only (never a default). Warns before a realtime run with a
 * heavy profile: a slow writer can make a realtime run fall behind, and each such wait is a traced degradation.
 */
export function RecordingControls({ realtime }: { realtime: boolean }) {
  const sel = useSyncExternalStore(subscribeRecordingSelection, getRecordingSelection);
  const parsed = profileOfSelection(sel);
  const heavy = parsed.ok && isHeavyProfile(parsed.profile);
  return (
    <fieldset className="recording-controls" data-testid="recording-controls">
      <legend className="muted">Recording</legend>
      <div className="row">
        <label>
          profile{" "}
          <select
            aria-label="Recording profile"
            data-testid="recording-preset"
            value={sel.preset}
            disabled={sel.optOut}
            onChange={(e) => setRecordingSelection({ preset: e.target.value as RecordingPresetName | "custom" })}
          >
            {(Object.keys(RECORDING_PRESETS) as RecordingPresetName[]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="custom">custom (JSON)</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={sel.optOut} onChange={(e) => setRecordingSelection({ optOut: e.target.checked })} data-testid="recording-opt-out" /> Don't record this run
        </label>
      </div>
      {sel.optOut && (
        <p className="muted" data-testid="recording-opt-out-note">
          ○ This run will not be saved: no replay, no scrubbing beyond the live view, no export. It runs exactly as a recorded one. The next run is recorded again.
        </p>
      )}
      {sel.preset === "custom" && !sel.optOut && (
        <>
          <textarea
            aria-label="Recording profile (JSON)"
            data-testid="recording-custom-json"
            rows={8}
            className="mono"
            value={sel.customJson}
            onChange={(e) => setRecordingSelection({ customJson: e.target.value })}
          />
          {!parsed.ok && (
            <p className="danger" role="alert" data-testid="recording-custom-error">
              ✗ {parsed.message}
            </p>
          )}
        </>
      )}
      {realtime && heavy && !sel.optOut && (
        <p className="warn" data-testid="recording-heavy-warning">
          ⚠ A realtime run with this profile writes a lot: if the writer falls behind, the run waits and each wait is traced as a storage_backpressure degradation.
        </p>
      )}
    </fieldset>
  );
}
