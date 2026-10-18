import { StorageBrowser } from "@agentsim/ui";
import { useAppActions, useCurrentRun, useServices, useStorageStatus } from "../services.tsx";

/** Data workspace: Storage browser (F0); SQL console arrives in F3. */
export function StoragePanel() {
  const { storage } = useServices();
  const status = useStorageStatus(storage);
  const { run } = useCurrentRun();
  const { openReplay } = useAppActions();
  if (status.state !== "ready") {
    return (
      <div className="panel muted" data-testid="storage-unavailable">
        {status.state === "waiting-lock"
          ? "⏸ Storage is owned by another tab. It becomes available here when that tab is closed."
          : status.state === "failed"
            ? `✗ Storage failed to open: ${status.error}`
            : "Opening storage…"}
      </div>
    );
  }
  // The run being recorded cannot be deleted from under its recorder.
  return <StorageBrowser client={storage} currentRunId={run?.header.recording === "stored" ? run.header.runId : undefined} onReplay={openReplay} />;
}
