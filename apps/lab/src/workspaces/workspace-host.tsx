import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import type { StorageClient } from "@agentsim/storage";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type SerializedDockview } from "dockview-react";
import { useEffect, useRef } from "react";
import { DOCK_COMPONENTS, PANELS } from "./registry.tsx";
import { markWorkspaceVisible } from "../probe.ts";
import { LAYOUT_NAMESPACE, layoutKey, type WorkspacePreset } from "./presets.ts";

/**
 * Token-mapped dockview theme (ADR-0032 §7): dockview's dark theme supplies structure, and
 * `dockview-theme-agentsim` (theme.css) maps every colour variable to the tokens, so dark and light
 * follow the app theme without re-rendering.
 */
const DOCK_THEME: DockviewTheme = { name: "agentsim", className: "dockview-theme-dark dockview-theme-agentsim" };

function applyPreset(api: DockviewApi, preset: WorkspacePreset): void {
  api.clear();
  for (const p of preset.panels) {
    api.addPanel({
      id: p.id,
      component: p.id,
      title: PANELS[p.id].title,
      ...(p.position ? { position: { referencePanel: p.position.referencePanel, direction: p.position.direction } } : {}),
      ...(p.initialWidth === undefined ? {} : { initialWidth: p.initialWidth }),
    });
  }
}

/**
 * One dockview per workspace preset. Layouts are user data, saved through the storage ports
 * (ADR-0016) when storage is available; otherwise the preset is used.
 */
export function WorkspaceHost(props: { preset: WorkspacePreset; storage: StorageClient; layoutEpoch: number; onApi?: (api: DockviewApi) => void }) {
  const { preset, storage, layoutEpoch, onApi } = props;
  const api = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const storageReady = () => storage.status().state === "ready";

  const onReady = (e: DockviewReadyEvent) => {
    api.current = e.api;
    onApi?.(e.api);
    applyPreset(e.api, preset);
    markWorkspaceVisible();
    if (storageReady()) {
      void storage.ports.userData.get(LAYOUT_NAMESPACE, layoutKey(preset.id)).then((saved) => {
        if (!saved || api.current !== e.api) return;
        try {
          e.api.fromJSON(saved as SerializedDockview);
        } catch {
          applyPreset(e.api, preset); // stale layout (e.g. removed panel): fall back to the preset
        }
      });
    }
    e.api.onDidLayoutChange(() => {
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

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  return (
    <div className="workspace-fill" data-testid={`workspace-${preset.id}`}>
      <DockviewReact theme={DOCK_THEME} components={DOCK_COMPONENTS} onReady={onReady} />
    </div>
  );
}
