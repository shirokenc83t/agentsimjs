import "./panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { agentColorIndex, KIND_STYLE, ROW_PX, STATE_GLYPH, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { usePolled, useServices } from "../services.tsx";
import { actionLabel, actionState } from "./agent-views.ts";
import { useAgentViews } from "./use-agent-views.ts";

/**
 * Explorer (UI-SPEC §4): the run's entities, agents only in F1. Virtualized (ADR-0016: long lists are, and
 * the same component serves swarms later). Each row: colour swatch + ID, key, kind tag, action state
 * (glyph + text). Selecting a row selects the agent everywhere through the UI context.
 */
export function ExplorerPanel() {
  const { source } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const views = useAgentViews(source);
  const selection = useUiContext((s) => s.selection);
  const agents = snap.run?.agents ?? [];
  const ideal = new Set(snap.run?.idealAgents ?? []);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: agents.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX.comfortable, overscan: 8 });
  const selectedIndex = selection?.kind === "agent" ? agents.findIndex((a) => a.id === selection.id) : -1;

  // Keep the selected row in view when the selection comes from another panel.
  useEffect(() => {
    if (selectedIndex >= 0) virtual.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtual]);

  const select = (i: number) => {
    const a = agents[i];
    if (a) useUiContext.getState().select({ kind: "agent", id: a.id });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(agents.length - 1, Math.max(0, selectedIndex + (e.key === "ArrowDown" ? 1 : -1)));
    select(next);
  };

  if (!snap.run) return <div className="panel muted">No run loaded. Load one from the run menu in the toolbar.</div>;
  return (
    <div className="panel explorer" data-testid="explorer">
      <div
        ref={scroller}
        className="explorer-list"
        role="listbox"
        aria-label="Agents"
        tabIndex={0}
        onKeyDown={onKey}
        aria-activedescendant={selectedIndex >= 0 ? `explorer-${agents[selectedIndex]?.id ?? ""}` : undefined}
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((row) => {
            const a = agents[row.index];
            if (!a) return null;
            const action = views.get(a.id)?.action;
            const state = actionState(action);
            return (
              <div
                key={a.id}
                id={`explorer-${a.id}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                data-testid={`explorer-row-${a.id}`}
                className="explorer-row"
                onClick={() => select(row.index)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: row.size, transform: `translateY(${row.start}px)` }}
              >
                <span className="agent-swatch" style={{ backgroundColor: `var(--agent-${agentColorIndex(a.id)})` }} />
                <span className="mono">{a.id}</span>
                <span className="muted">{a.key ?? ""}</span>
                <span className="kind-tag mono">{a.kind.toUpperCase()}</span>
                {ideal.has(a.id) && (
                  <span className="kind-tag mono" data-testid={`explorer-ideal-${a.id}`} title="ideal: plans on the ground truth (baseline), not on its own map">
                    ◆ ideal
                  </span>
                )}
                <span className={`mono st-${state}`} data-testid={`explorer-state-${a.id}`}>
                  {STATE_GLYPH[state]} {actionLabel(action)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted legend">
        {agents.length} agents · {KIND_STYLE.action.tag} state from the action trace
      </p>
    </div>
  );
}
