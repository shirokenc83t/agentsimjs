import { LATEST_SCHEMA_VERSION, type StorageInfo } from "@agentsim/storage";
import type { RunHeader } from "@agentsim/trace";
import { formatBytes, formatSimTime, GLYPH } from "@agentsim/ui";
import { Suspense } from "react";
import { usePolled } from "../services.tsx";
import type { SimSnapshot } from "../sim/sim-client.ts";
import type { StorageStatus } from "@agentsim/storage";
import { LazyRecordingStatus } from "../workspaces/registry.tsx";
import { getFrameStats } from "./frame-stats.ts";

export interface StatusBarProps {
  readonly snap: SimSnapshot;
  readonly status: StorageStatus;
  readonly info: StorageInfo | null;
  readonly header: RunHeader | undefined;
  /** The panels show a recording: the live run is going on behind it. */
  readonly replaying: boolean;
}

/** `ab12cd34` of a hash, or a dash. */
const short = (h: string | undefined) => (h === undefined ? "—" : h.slice(0, 8));

/**
 * The status bar (UI-SPEC §2): 24 px, the run state, the hashes, the storage, the frame time and what the recording is doing. Mono, 11 px. While a recording is
 * shown it keeps a "live run in background" segment, so the player's replay state cannot be taken for the run's.
 */
export function StatusBar(props: StatusBarProps) {
  const { snap, status, info, header, replaying } = props;
  const frame = usePolled(getFrameStats, 500);
  const persistent = status.state === "ready" && status.mode === "opfs-sahpool";
  return (
    <footer className="bot" aria-label="Status" data-testid="statusline">
      <span className="seg" data-testid="status-state">
        {snap.running ? `${GLYPH.running} running` : `${GLYPH.paused} paused`}
      </span>
      <span className="seg" data-testid="status-simtime">
        sim {formatSimTime(snap.simTimeS)}
      </span>
      <span className="seg" data-testid="status-tick">
        tick {snap.tick}
      </span>
      <span className="seg">{snap.entityIds.length} entities</span>
      {replaying && (
        <span className="seg rpseg" data-testid="status-live-background" title="The player shows a stored run; the live run goes on and is not touched">
          live run in background · tick {snap.tick}
        </span>
      )}
      <span className="seg" data-testid="status-hashes" title="State hash of the live run at its last hash tick · run configuration hash · effective configuration hash">
        <span className="k">hash</span> {short(snap.stateHash)}
        {snap.hashTick !== undefined && <span className="k">@{snap.hashTick}</span>} <span className="k">cfg</span> {short(header?.runConfigHash)} <span className="k">eff</span> {short(header?.effectiveConfigHash)}
      </span>
      <span className={`seg${persistent ? "" : " warn"}`} data-testid="status-storage">
        db: {status.state === "ready" ? status.mode : status.state}
      </span>
      {info && (
        <span className="seg" data-testid="status-storage-size">
          {formatBytes(info.dbFileBytes)} · {formatBytes(info.usageBytes)} / {formatBytes(info.quotaBytes)} · schema v{LATEST_SCHEMA_VERSION}
        </span>
      )}
      {header && (
        <Suspense fallback={null}>
          <LazyRecordingStatus header={header} snap={snap} />
        </Suspense>
      )}
      {snap.preparing && (
        <span className="seg" data-testid="status-preparing" title="Planning views and HPA* graphs are built before tick 0 (ADR-0024)">
          ⧗ preparing planning graphs {snap.preparing.done}/{snap.preparing.total}
        </span>
      )}
      {snap.degradations > 0 && (
        <span className="seg warn" data-testid="status-degradations" title="Realtime tick skips; each one is traced (ADR-0013)">
          {GLYPH.warn} {snap.degradations} degradation{snap.degradations === 1 ? "" : "s"} (last: {snap.lastSkippedTicks} ticks skipped)
        </span>
      )}
      {snap.error && (
        <span className="seg danger">
          {GLYPH.fail} {snap.error}
        </span>
      )}
      <span className="sp" />
      <span className="seg r" data-testid="status-frame" title="Frame work of the Scene (mean) and the rendering rate">
        <span className="k">frame</span> {frame ? `${frame.workMeanMs.toFixed(1)} ms · ${frame.fps.toFixed(0)} fps` : "—"}
      </span>
    </footer>
  );
}
