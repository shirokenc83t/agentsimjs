import type { SceneRenderer } from "@agentsim/ui";
import { useEffect } from "react";
import { useSandboxView } from "./sandbox-store.ts";
import { sandboxLines } from "./stage-lines.ts";

/** The researcher's Strategy test result in the Scene, in the sandbox tone; cleared with the result. */
export function useSandboxOverlay(renderer: SceneRenderer | undefined, agentId: string | undefined): void {
  const view = useSandboxView();
  const shown = view && view.agentId === agentId ? view : undefined;
  useEffect(() => {
    if (!renderer) return;
    renderer.setSandboxStages(shown ? sandboxLines(shown.result) : undefined);
    return () => renderer.setSandboxStages(undefined);
  }, [renderer, shown]);
}
