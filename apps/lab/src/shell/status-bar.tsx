import { LATEST_SCHEMA_VERSION, type StorageInfo } from "@agentsim/storage";
import type { RunHeader } from "@agentsim/trace";
import { formatBytes, formatSimTime, GLYPH } from "@agentsim/ui";
import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { usePolled } from "../services.tsx";
import type { SimSnapshot } from "../sim/sim-client.ts";
import type { StorageStatus } from "@agentsim/storage";
import { LazyRecordingStatus } from "../workspaces/registry.tsx";
import { getFrameStats } from "./frame-stats.ts";
import { MindsStatusSegments } from "./minds-ui.tsx";

export interface StatusBarProps {
  readonly snap: SimSnapshot;
  readonly status: StorageStatus;
  readonly info: StorageInfo | null;
  readonly header: RunHeader | undefined;
  /** The panels show a recording: the live run is going on behind it. */
  readonly replaying: boolean;
  /** Opens the Performance window (the frame segment is its button). */
  readonly onOpenPerf?: (() => void) | undefined;
}

/**
 * Which segments go when the bar is too narrow: the highest priority numbers first. A segment goes whole, never cut, and the `…` segment lists what went
 * (in its tooltip). Run state, sim time, tick, entities, recording, what is saved and the frame rate stay longest; the hashes, the storage mode and size go first.
 */
export function segmentsToDrop(widths: readonly { readonly prio: number; readonly width: number }[], available: number, moreWidth: number): number[] {
  const order = widths.map((_, i) => i).sort((a, b) => (widths[b]?.prio ?? 0) - (widths[a]?.prio ?? 0) || b - a);
  let total = widths.reduce((n, w) => n + w.width, 0);
  if (total <= available) return [];
  const dropped: number[] = [];
  for (const i of order) {
    if (total + moreWidth <= available) break;
    total -= widths[i]?.width ?? 0;
    dropped.push(i);
  }
  return dropped;
}

/** Width reserved for the `…` segment. */
const MORE_WIDTH_PX = 34;

/** `ab12cd34` of a hash, or a dash. */
const short = (h: string | undefined) => (h === undefined ? "—" : h.slice(0, 8));

/**
 * The status bar (UI-SPEC §2): 24 px, the run state, the hashes, the storage, the frame time and what the recording is doing. Mono, 11 px. While a recording is
 * shown it keeps a "live run in background" segment, so the player's replay state cannot be taken for the run's.
 */
export function StatusBar(props: StatusBarProps) {
  const { snap, status, info, header, replaying, onOpenPerf } = props;
  const frame = usePolled(getFrameStats, 500);
  const bar = useRef<HTMLElement>(null);
  const [more, setMore] = useState<string[]>([]);
  // Fit: measure every segment at its natural width, then drop whole segments by priority until the rest (and the `…`) fit. Runs after each render and when the bar resizes.
  const fit = () => {
    const el = bar.current;
    if (!el) return;
    const segs = Array.from(el.querySelectorAll<HTMLElement>("[data-prio]"));
    for (const s of segs) s.removeAttribute("data-hid");
    const widths = segs.map((s) => ({ prio: Number(s.dataset["prio"]), width: s.offsetWidth }));
    // The filler and the `…` are not segments: what is left is the bar's width minus nothing else.
    const dropped = segmentsToDrop(widths, el.clientWidth, MORE_WIDTH_PX);
    for (const i of dropped) segs[i]?.setAttribute("data-hid", "");
    const names = dropped.sort((a, b) => a - b).map((i) => (segs[i]?.textContent ?? "").replace(/\s+/g, " ").trim());
    setMore((cur) => (cur.join("\n") === names.join("\n") ? cur : names));
  };
  useLayoutEffect(fit);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const persistent = status.state === "ready" && status.mode === "opfs-sahpool";
  return (
    <footer ref={bar} className="bot" aria-label="Status" data-testid="statusline">
      <span className="seg pri" data-prio="1" data-testid="status-state">
        {snap.running ? `${GLYPH.running} running` : `${GLYPH.paused} paused`}
      </span>
      <span className="seg pri" data-prio="2" data-testid="status-simtime">
        sim {formatSimTime(snap.simTimeS)}
      </span>
      <span className="seg pri" data-prio="3" data-testid="status-tick">
        tick {snap.tick}
      </span>
      <span className="seg pri" data-prio="4">{snap.entityIds.length} entities</span>
      {replaying && (
        <span className="seg rpseg" data-prio="2" data-testid="status-live-background" title="The player shows a stored run; the live run goes on and is not touched">
          live run in background · tick {snap.tick}
        </span>
      )}
      <span className="seg" data-prio="8" data-testid="status-hashes" title="State hash of the live run at its last hash tick · run configuration hash · effective configuration hash">
        <span className="k">hash</span> {short(snap.stateHash)}
        {snap.hashTick !== undefined && <span className="k">@{snap.hashTick}</span>}{" "}
        <span className="k">cfg</span> {short(header?.runConfigHash)} <span className="k">eff</span> {short(header?.effectiveConfigHash)}
      </span>
      <span className={`seg${persistent ? "" : " warn"}`} data-prio="9" data-testid="status-storage">
        db: {status.state === "ready" ? status.mode : status.state}
      </span>
      {info && (
        <span className="seg" data-prio="10" data-testid="status-storage-size">
          {formatBytes(info.dbFileBytes)} · {formatBytes(info.usageBytes)} / {formatBytes(info.quotaBytes)} · schema v{LATEST_SCHEMA_VERSION}
        </span>
      )}
      {header && (
        <Suspense fallback={null}>
          <LazyRecordingStatus header={header} snap={snap} />
        </Suspense>
      )}
      <MindsStatusSegments />
      {snap.preparing && (
        <span className="seg" data-prio="3" data-testid="status-preparing" title="Planning views and HPA* graphs are built before tick 0 (ADR-0024)">
          ⧗ preparing planning graphs {snap.preparing.done}/{snap.preparing.total}
        </span>
      )}
      {snap.degradations > 0 && (
        <span className="seg warn" data-prio="3" data-testid="status-degradations" title="Realtime tick skips; each one is traced (ADR-0013)">
          {GLYPH.warn} {snap.degradations} degradation{snap.degradations === 1 ? "" : "s"} (last: {snap.lastSkippedTicks} ticks skipped)
        </span>
      )}
      {snap.error && (
        <span className="seg danger" data-prio="1">
          {GLYPH.fail} {snap.error}
        </span>
      )}
      <span className="sp" />
      {more.length > 0 && (
        <span className="seg more" data-testid="status-more" title={more.join("\n")} aria-label={`More: ${more.join("; ")}`}>
          …
        </span>
      )}
      <button type="button" className="seg r segbtn" data-prio="5" data-testid="status-frame" onClick={onOpenPerf} title="Frame work of the Scene (mean) and the rendering rate: opens the Performance window">
        <span className="k">frame</span> {frame ? `${frame.workMeanMs.toFixed(1)} ms · ${frame.fps.toFixed(0)} fps` : "—"}
      </button>
    </footer>
  );
}
