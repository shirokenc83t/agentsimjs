import type { PersistedHead, RunHeader } from "@agentsim/trace";
import { useEffect, useState } from "react";
import { useServices } from "./services.tsx";
import type { SimSnapshot } from "./sim/sim-client.ts";

// The recording in the status line (ADR-0035 addition of 2026-10-17, items 6 and 12): which profile the run is recorded under, with both hashes,
// or that it is not recorded; how far it is saved; and why the run waits (the writer is behind, the storage quota is near). Loaded when a run exists.

export type RecordingState = "ok" | "storage_backpressure" | "storage_quota";

export interface RecordingStatusInput {
  readonly header: RunHeader;
  /** The sim head: the latest tick the worker has produced. */
  readonly tick: number;
  /** The persisted head of this run, once the storage worker has reported one. */
  readonly persisted: Pick<PersistedHead, "tick"> | undefined;
  readonly state: RecordingState;
  readonly backlogRecords: number;
}

export interface RecordingStatusText {
  readonly recorded: boolean;
  /** `● recording default-research · profile 19cfa400 · config ab12cd34`, or `○ not recorded`. */
  readonly label: string;
  /** `saved to tick 120 · head 130`, `saved to tick 130` (no gap) or `not saved yet`; absent for a run that is not recorded. */
  readonly saved: string | undefined;
  /** Why the run waits, when it does. */
  readonly waiting: string | undefined;
}

/** What the status line says of a run's recording (a pure function of the header and what the workers reported). */
export function describeRecording(i: RecordingStatusInput): RecordingStatusText {
  const h = i.header;
  if (h.recording !== "stored") return { recorded: false, label: "○ not recorded", saved: undefined, waiting: undefined };
  const name = (h.recordingProfile as { name?: string } | undefined)?.name ?? "profile";
  const label = `● recording ${name} · profile ${h.recordingProfileHash ?? "?"} · config ${h.runConfigHash ?? "?"}`;
  const saved = i.persisted === undefined ? "not saved yet" : i.tick > i.persisted.tick ? `saved to tick ${i.persisted.tick} · head ${i.tick}` : `saved to tick ${i.persisted.tick}`;
  const waiting =
    i.state === "storage_quota"
      ? "❚❚ paused: the storage quota is near (delete or export runs to free space)"
      : i.state === "storage_backpressure"
        ? `❚❚ waiting for storage (${i.backlogRecords} records not saved yet)`
        : undefined;
  return { recorded: true, label, saved, waiting };
}

/** The recording part of the status line. Subscribes to the persisted head and to the sim worker's recording state while it is shown. */
export function RecordingStatus({ header, snap }: { header: RunHeader; snap: SimSnapshot }) {
  const { storage } = useServices();
  const [persisted, setPersisted] = useState<PersistedHead | undefined>(undefined);
  useEffect(() => {
    setPersisted(undefined);
    const offHead = storage.onRecording((m) => {
      if (m.type === "persisted" && m.head.runId === header.runId) setPersisted(m.head);
    });
    return offHead;
  }, [storage, header.runId]);
  // The worker's state for this run comes with the polled snapshot (the client keeps the latest, so a panel that mounts late still has it).
  const recording = snap.recording?.runId === header.runId ? snap.recording : { state: "ok" as const, backlogRecords: 0 };
  const t = describeRecording({ header, tick: snap.tick, persisted, state: recording.state, backlogRecords: recording.backlogRecords });
  return (
    <>
      <span data-testid="status-recording" data-prio="7" className={`seg${t.recorded ? "" : " warn"}`} title="How this run is recorded (ADR-0035): the recording profile and its hash, next to the run configuration's">
        {t.label}
      </span>
      {t.saved !== undefined && <span className="seg" data-prio="6" data-testid="status-recording-saved">{t.saved}</span>}
      {t.waiting !== undefined && (
        <span className="seg warn" data-prio="2" data-testid="status-recording-state">
          {t.waiting}
        </span>
      )}
    </>
  );
}
