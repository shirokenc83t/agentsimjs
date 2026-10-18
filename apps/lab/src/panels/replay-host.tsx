import { Banner, useUiContext } from "@agentsim/ui";
import { useEffect, useState } from "react";
import { useServices } from "../services.tsx";
import { openReplaySource, type CursorPort } from "../sim/replay-run-source.ts";

/** The time cursor of the shared UI context, as the replay source reads it (imperatively) and hears it move: only a change of the cursor counts. */
const uiCursor: CursorPort = {
  get: () => useUiContext.getState().simTime,
  subscribe: (l) => {
    let last = useUiContext.getState().simTime;
    return useUiContext.subscribe((s) => {
      if (s.simTime === last) return;
      last = s.simTime;
      l();
    });
  },
};

/**
 * One replay session (ADR-0016): while mounted, the panels read the run `runId` from storage instead of the live run; the Scene shows the replay bar. A run
 * that cannot be replayed (not recorded, no world) is said here, in a banner, and the live run stays in the panels. Unmounting gives the panels the live run
 * back; the live run itself was never touched (no message reaches the sim worker from here).
 */
export function ReplayHost(props: { runId: string }) {
  const { storage, setReplaySource } = useServices();
  const { runId } = props;
  const [failed, setFailed] = useState<string | null>(null);
  const onFailed = setFailed;
  useEffect(() => {
    setFailed(null);
    let cancelled = false;
    let opened: { dispose(): void } | undefined;
    void openReplaySource({ runId, ports: storage.ports, replay: storage.replay, cursor: uiCursor }).then(
      (r) => {
        if (cancelled) {
          if (r.ok) r.value.dispose();
          return;
        }
        if (!r.ok) {
          onFailed(`Cannot replay ${runId}: ${r.error.message}`);
          return;
        }
        opened = r.value;
        setReplaySource(r.value);
      },
      (e: unknown) => {
        if (!cancelled) onFailed(`Cannot replay ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => {
      cancelled = true;
      opened?.dispose();
      setReplaySource(undefined);
    };
  }, [storage, runId, setReplaySource]);
  return failed === null ? null : (
    <Banner kind="warn" testId="replay-error">
      {failed}
    </Banner>
  );
}
