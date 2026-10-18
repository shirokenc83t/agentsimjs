import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, type ComponentType, type FunctionComponent } from "react";

// Heavy panels are lazy-loaded per workspace (ADR-0016, ADR-0021). This is the only app module
// allowed to use dynamic import().
const ScenePanel = lazy(() => import("../panels/scene-panel.tsx").then((m) => ({ default: m.ScenePanel })));
const StoragePanel = lazy(() => import("../panels/storage-panel.tsx").then((m) => ({ default: m.StoragePanel })));
const SettingsPanel = lazy(() => import("../panels/settings-panel.tsx").then((m) => ({ default: m.SettingsPanel })));
const ExplorerPanel = lazy(() => import("../panels/explorer-panel.tsx").then((m) => ({ default: m.ExplorerPanel })));
const InspectorPanel = lazy(() => import("../panels/inspector-panel.tsx").then((m) => ({ default: m.InspectorPanel })));
const RunConfigPanel = lazy(() => import("../panels/run-config/run-config-panel.tsx").then((m) => ({ default: m.RunConfigPanel })));
const ScenarioEditorPanel = lazy(() => import("../panels/scenario-editor/scenario-editor-panel.tsx").then((m) => ({ default: m.ScenarioEditorPanel })));

/**
 * The dockview workspace host, loaded after first paint (issue #4): toolbar and status line render
 * first, inside a fixed grid, and the workspace fills its reserved row when its chunk arrives.
 */
export const LazyWorkspaceHost = lazy(() => import("./workspace-host.tsx").then((m) => ({ default: m.WorkspaceHost })));

/**
 * Run starting (scenario presets, validation, run headers) loaded on first use: it pulls the scenarios,
 * spatial and planning packages, which must stay out of the initial chunk (ADR-0032 §3 bundle gate).
 */
export const loadRunController = () => import("../sim/run-controller.ts");

/** Palette commands on the selected agent (ADR-0015 addition of 2026-10-12), loaded when the palette first opens. */
export const loadAgentCommands = () => import("../commands.ts");

/** How the run is recorded, in the status line: loaded when a run exists (ADR-0035 addition of 2026-10-17, item 6). */
export const LazyRecordingStatus = lazy(() => import("../recording-status.tsx").then((m) => ({ default: m.RecordingStatus })));

/** The run header popover, loaded on first open (the toolbar keeps only the run label). */
export const LazyRunPopover = lazy(() => import("../run-info.tsx").then((m) => ({ default: m.RunPopover })));

export type PanelId = "scene" | "explorer" | "inspector" | "runConfig" | "scenarioEditor" | "storage" | "settings";

export const PANELS: Record<PanelId, { readonly title: string; readonly component: ComponentType }> = {
  scene: { title: "Scene 3D", component: ScenePanel },
  explorer: { title: "Explorer", component: ExplorerPanel },
  inspector: { title: "Inspector", component: InspectorPanel },
  runConfig: { title: "Run configuration", component: RunConfigPanel },
  scenarioEditor: { title: "Scenario editor", component: ScenarioEditorPanel },
  storage: { title: "Storage", component: StoragePanel },
  settings: { title: "Settings", component: SettingsPanel },
};

function withSuspense(C: ComponentType): FunctionComponent<IDockviewPanelProps> {
  const Wrapped = () => (
    <Suspense fallback={<div className="panel muted">Loading…</div>}>
      <C />
    </Suspense>
  );
  return Wrapped;
}

/** Component map for dockview. */
export const DOCK_COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps>> = Object.fromEntries(
  (Object.keys(PANELS) as PanelId[]).map((id) => [id, withSuspense(PANELS[id].component)]),
);
