import { useUiContext } from "@agentsim/ui";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { useContext, useEffect, useReducer } from "react";
import { PresetContext } from "./preset-context.ts";
import { closePanel, dockPanel, floatPanel, isCollapsed, isFloating, toggleCollapse, toggleMaximize } from "./dock-actions.ts";

/**
 * What the panel is about, in its title bar (the "context line"): the run and the moment for the panels that follow the cursor, the selection for the
 * Inspector. Nothing for panels that are about no run.
 */
function PanelContext(props: { panelId: string }) {
  const runId = useUiContext((s) => s.runId);
  const simTime = useUiContext((s) => s.simTime);
  const selection = useUiContext((s) => s.selection);
  let text = "";
  switch (props.panelId) {
    case "scene":
    case "explorer":
      text = runId ?? "no run";
      break;
    case "timeline":
    case "eventList":
      text = runId ? `${runId} · cursor ${simTime.toFixed(1)} s` : "no run";
      break;
    case "inspector":
      text = selection ? `${selection.kind} ${selection.id}` : "no selection";
      break;
  }
  return text ? (
    <span className="tmeta mono" data-testid="panel-context">
      {text}
    </span>
  ) : null;
}

/**
 * The window buttons of a group (ADR-0042 §7): float or dock, collapse (a floating window to its title bar), maximize or restore, close. "New view" appears with
 * the panels that can have more than one; none can yet. Each is a button with a name, reachable with Tab, and every one of them is also a palette command.
 */
export function WindowButtons(props: IDockviewHeaderActionsProps) {
  const { containerApi: api, group, activePanel } = props;
  const preset = useContext(PresetContext);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const layout = api.onDidLayoutChange(refresh);
    const max = api.onDidMaximizedGroupChange(refresh);
    return () => {
      layout.dispose();
      max.dispose();
    };
  }, [api]);
  if (!activePanel) return null;
  const id = activePanel.id;
  const title = activePanel.title ?? id;
  const floating = isFloating(activePanel);
  const maximized = activePanel.api.isMaximized();
  const collapsed = isCollapsed(group);
  return (
    <div className="wbtn" data-testid={`window-buttons-${id}`}>
      <PanelContext panelId={id} />
      {floating && (
        <button type="button" className="wb" onClick={() => toggleCollapse(group)} aria-label={`${collapsed ? "Open" : "Collapse"} ${title}`} data-tip={collapsed ? "Open the window" : "Collapse to the title bar"} data-testid={`wb-collapse-${id}`}>
          {collapsed ? "▸" : "▾"}
        </button>
      )}
      {floating ? (
        <button type="button" className="wb" onClick={() => dockPanel(api, activePanel, preset)} aria-label={`Dock ${title}`} data-tip="Dock it back into the grid" data-testid={`wb-dock-${id}`}>
          ↙
        </button>
      ) : (
        <button type="button" className="wb" onClick={() => floatPanel(api, activePanel)} aria-label={`Float ${title}`} data-tip="Float it over the dock" data-testid={`wb-float-${id}`}>
          ↗
        </button>
      )}
      <button type="button" className="wb" onClick={() => toggleMaximize(api, activePanel)} aria-label={`${maximized ? "Restore" : "Maximize"} ${title}`} data-tip={maximized ? "Restore" : "Maximize"} data-testid={`wb-maximize-${id}`}>
        {maximized ? "▣" : "□"}
      </button>
      <button type="button" className="wb" onClick={() => closePanel(activePanel)} aria-label={`Close ${title}`} data-tip="Close (the palette opens it again)" data-testid={`wb-close-${id}`}>
        ×
      </button>
    </div>
  );
}
