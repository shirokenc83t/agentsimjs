import { useUiContext } from "@agentsim/ui";

/** The agent that is the subject now: the selected agent, or none when the selection is not an agent (ADR-0043 §3: one subject, one hue). */
export function useSelectedAgentId(): string | undefined {
  return useUiContext((s) => (s.selection?.kind === "agent" ? s.selection.id : undefined));
}
