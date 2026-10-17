import { StorageBrowser } from "@agentsim/ui";
import { useServices, useStorageStatus } from "../services.tsx";

/** Data workspace: Storage browser (F0); SQL console arrives in F3. */
export function StoragePanel() {
  const { storage } = useServices();
  const status = useStorageStatus(storage);
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
  return <StorageBrowser client={storage} />;
}
