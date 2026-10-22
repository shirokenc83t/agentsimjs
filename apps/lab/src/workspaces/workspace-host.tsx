import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import type { StorageClient } from "@agentsim/storage";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type SerializedDockview } from "dockview-react";
import { useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useRef } from "react";
import { usePolled, useServices } from "../services.tsx";
import { syncRunContext } from "../sim/run-context.ts";
import { applyPreset, COLLAPSED_HEIGHT_PX, syncCollapsed } from "./dock-actions.ts";
import { DOCK_COMPONENTS } from "./registry.tsx";
import { PresetContext } from "./preset-context.ts";
import { WindowButtons } from "./window-buttons.tsx";
import { attachDockProbe, markWorkspaceVisible } from "../probe.ts";
import { LAYOUT_NAMESPACE, layoutKey, type WorkspacePreset } from "./presets.ts";

/**
 * Token-mapped dockview theme (ADR-0032 §7): dockview's dark theme supplies structure, and
 * `dockview-theme-agentsim` (theme.css) maps every colour variable to the tokens, so dark and light
 * follow the app theme without re-rendering.
 */
const DOCK_THEME: DockviewTheme = { name: "agentsim", className: "dockview-theme-dark dockview-theme-agentsim", gap: 10 };

/**
 * One dockview per workspace preset. Layouts are user data, saved through the storage ports
 * (ADR-0016) when storage is available; otherwise the preset is used.
 */
export function WorkspaceHost(props: { preset: WorkspacePreset; storage: StorageClient; layoutEpoch: number; onApi?: (api: DockviewApi) => void }) {
  const { preset, storage, layoutEpoch, onApi } = props;
  const api = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopWaiting = useRef<(() => void) | undefined>(undefined);

  const storageReady = () => storage.status().state === "ready";

  const onReady = (e: DockviewReadyEvent) => {
    api.current = e.api;
    onApi?.(e.api);
    attachDockProbe(e.api, (h, floating) => floating && h <= COLLAPSED_HEIGHT_PX + 2);
    applyPreset(e.api, preset);
    markWorkspaceVisible();
    // The saved layout replaces the preset once storage can be read: at once, or when it opens (a reload finds storage still opening).
    const loadSaved = () =>
      void storage.ports.userData.get(LAYOUT_NAMESPACE, layoutKey(preset.id)).then((saved) => {
        if (!saved || api.current !== e.api) return;
        try {
          e.api.fromJSON(saved as SerializedDockview);
          syncCollapsed(e.api);
        } catch {
          applyPreset(e.api, preset); // stale layout (e.g. removed panel): fall back to the preset
        }
      });
    if (storageReady()) loadSaved();
    else {
      const off = storage.onStatus((st) => {
        if (st.state !== "ready") return;
        off();
        loadSaved();
      });
      stopWaiting.current = off;
    }
    e.api.onDidLayoutChange(() => {
      syncCollapsed(e.api);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (storageReady() && api.current === e.api) void storage.ports.userData.set(LAYOUT_NAMESPACE, layoutKey(preset.id), e.api.toJSON());
      }, 500);
    });
  };

  // Reset requested from Settings / command palette.
  useEffect(() => {
    if (layoutEpoch > 0 && api.current) applyPreset(api.current, preset);
  }, [layoutEpoch, preset]);

  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      stopWaiting.current?.();
      attachDockProbe(undefined, () => false);
    },
    [],
  );

  // The shared UI context follows the run source: run start, mode, and (live) the cursor (ADR-0016). The panels mount once the source is there.
  const { source } = useServices();
  const view = usePolled(useCallback(() => source?.snapshot(), [source]), 100);
  useEffect(() => {
    if (view) syncRunContext(useUiContext, view);
  }, [view]);

  return (
    <div className="workspace-fill" data-testid={`workspace-${preset.id}`}>
      {source ? (
        <PresetContext.Provider value={preset}>
          <DockviewReact theme={DOCK_THEME} components={DOCK_COMPONENTS} rightHeaderActionsComponent={WindowButtons} floatingGroupDragHandle="tabbar" onReady={onReady} />
        </PresetContext.Provider>
      ) : null}
    </div>
  );
}
