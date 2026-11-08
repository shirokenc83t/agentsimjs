import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, type ComponentType, type FunctionComponent } from "react";

// Heavy panels are lazy-loaded per workspace (ADR-0016, ADR-0021). This is the only app module
// allowed to use dynamic import().
import { DockPanelContext } from "./panel-context.ts";
const ScenePanel = lazy(() => import("../panels/scene-panel.tsx").then((m) => ({ default: m.ScenePanel })));
const StoragePanel = lazy(() => import("../panels/storage-panel.tsx").then((m) => ({ default: m.StoragePanel })));
const SettingsPanel = lazy(() => import("../panels/settings-panel.tsx").then((m) => ({ default: m.SettingsPanel })));
const ExplorerPanel = lazy(() => import("../panels/explorer-panel.tsx").then((m) => ({ default: m.ExplorerPanel })));
const InspectorPanel = lazy(() => import("../panels/inspector-panel.tsx").then((m) => ({ default: m.InspectorPanel })));
const RunConfigPanel = lazy(() => import("../panels/run-config/run-config-panel.tsx").then((m) => ({ default: m.RunConfigPanel })));
const TimelinePanel = lazy(() => import("../panels/debug/timeline-panel.tsx").then((m) => ({ default: m.TimelinePanel })));
const EventListPanel = lazy(() => import("../panels/debug/event-list-panel.tsx").then((m) => ({ default: m.EventListPanel })));
const LogInspectorPanel = lazy(() => import("../panels/inspector/multi-log-inspector.tsx").then((m) => ({ default: m.MultiLogInspector })));
const SqlResultWindow = lazy(() => import("../panels/sql/sql-result-window.tsx").then((m) => ({ default: m.SqlResultWindow })));
const SqlConsolePanel = lazy(() => import("../panels/sql/sql-console-panel.tsx").then((m) => ({ default: m.SqlConsolePanel })));
const TraceGraphPanel = lazy(() => import("../panels/debug/trace-graph-panel.tsx").then((m) => ({ default: m.TraceGraphPanel })));
/** The CodeMirror template editor of the Library: its chunk loads when a template is opened, never with the initial chunk (ADR-0045 point 5). */
export const LazyTemplateEditor = lazy(() => import("../panels/library/template-editor.tsx").then((m) => ({ default: m.TemplateEditor })));
const LibraryPanel = lazy(() => import("../panels/library/library-panel.tsx").then((m) => ({ default: m.LibraryPanel })));
const LlmInspectorPanel = lazy(() => import("../panels/debug/llm-inspector-panel.tsx").then((m) => ({ default: m.LlmInspectorPanel })));
const ComputeInspectorPanel = lazy(() => import("../panels/debug/compute-inspector-panel.tsx").then((m) => ({ default: m.ComputeInspectorPanel })));
const TraceTreePanel = lazy(() => import("../panels/debug/trace-tree-panel.tsx").then((m) => ({ default: m.TraceTreePanel })));
const AgentAuditPanel = lazy(() => import("../panels/history/agent-audit-panel.tsx").then((m) => ({ default: m.AgentAuditPanel })));
const AgentHistoryPanel = lazy(() => import("../panels/history/agent-history-panel.tsx").then((m) => ({ default: m.AgentHistoryPanel })));
const OverviewPanel = lazy(() => import("../panels/overview-panel.tsx").then((m) => ({ default: m.OverviewPanel })));
const LegendPanel = lazy(() => import("../panels/legend-panel.tsx").then((m) => ({ default: m.LegendPanel })));
const PerfPanel = lazy(() => import("../panels/perf-panel.tsx").then((m) => ({ default: m.PerfPanel })));
const AnalysisPanel = lazy(() => import("../panels/analysis/analysis-panel.tsx").then((m) => ({ default: m.AnalysisPanel })));
const HeadlessMonitorPanel = lazy(() => import("../panels/headless/headless-monitor-panel.tsx").then((m) => ({ default: m.HeadlessMonitorPanel })));
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
export const loadResimController = () => import("../sim/resim-controller.ts");

/** Palette commands on the selected agent (ADR-0015 addition of 2026-10-12), loaded when the palette first opens. */
export const loadAgentCommands = () => import("../commands.ts");

/** How the run is recorded, in the status line: loaded when a run exists (ADR-0035 addition of 2026-10-17, item 6). */
export const LazyRecordingStatus = lazy(() => import("../recording-status.tsx").then((m) => ({ default: m.RecordingStatus })));

/** The live run source (the panels' view of the run in the sim worker): loaded right after first paint, so the shell does not carry it. */
export const loadLiveSource = () => import("../sim/live-run-source.ts");

/** A replay session (a recorded run in the panels, read from storage), loaded when one is opened (ADR-0035 addition of 2026-10-17, item 9). */
export const LazyReplayHost = lazy(() => import("../panels/replay-host.tsx").then((m) => ({ default: m.ReplayHost })));

/** The attention tile of the player: the attention rules load with it, when a run is there. */
export const LazyAttentionTile = lazy(() => import("../shell/attention-tile.tsx").then((m) => ({ default: m.AttentionTile })));

/** The mission of the selected agent under the player's clock; its trace reading loads with it, not in the initial chunk. */
export const LazyMissionNote = lazy(() => import("../shell/mission-note.tsx").then((m) => ({ default: m.MissionNote })));

/** The run header popover, loaded on first open (the toolbar keeps only the run label). */
export const LazyRunPopover = lazy(() => import("../run-info.tsx").then((m) => ({ default: m.RunPopover })));

export type PanelId = "overview" | "legend" | "perf" | "scene" | "explorer" | "inspector" | "timeline" | "eventList" | "traceTree" | "traceGraph" | "library" | "llmInspector" | "computeInspector" | "agentHistory" | "agentAudit" | "sqlConsole" | "sqlResult" | "logInspector" | "headlessMonitor" | "analysisView" | "runConfig" | "scenarioEditor" | "storage" | "settings";

export const PANELS: Record<PanelId, { readonly title: string; readonly component: ComponentType }> = {
  perf: { title: "Performance", component: PerfPanel },
  overview: { title: "Overview", component: OverviewPanel },
  legend: { title: "Legend", component: LegendPanel },
  scene: { title: "Scene", component: ScenePanel },
  explorer: { title: "Explorer", component: ExplorerPanel },
  inspector: { title: "Inspector", component: InspectorPanel },
  timeline: { title: "Timeline", component: TimelinePanel },
  eventList: { title: "Log", component: EventListPanel },
  traceTree: { title: "Trace", component: TraceTreePanel },
  traceGraph: { title: "Trace graph", component: TraceGraphPanel },
  library: { title: "Library", component: LibraryPanel },
  llmInspector: { title: "LLM", component: LlmInspectorPanel },
  computeInspector: { title: "Compute", component: ComputeInspectorPanel },
  agentHistory: { title: "History", component: AgentHistoryPanel },
  agentAudit: { title: "History and audit", component: AgentAuditPanel },
  logInspector: { title: "Logs", component: LogInspectorPanel },
  headlessMonitor: { title: "Headless monitor", component: HeadlessMonitorPanel },
  analysisView: { title: "Analysis", component: AnalysisPanel },
  runConfig: { title: "Run configuration", component: RunConfigPanel },
  scenarioEditor: { title: "Scenario editor", component: ScenarioEditorPanel },
  storage: { title: "Storage", component: StoragePanel },
  sqlConsole: { title: "SQL", component: SqlConsolePanel },
  sqlResult: { title: "SQL results", component: SqlResultWindow },
  settings: { title: "Settings", component: SettingsPanel },
};

function withSuspense(C: ComponentType): FunctionComponent<IDockviewPanelProps> {
  const Wrapped = (props: IDockviewPanelProps) => (
    <DockPanelContext.Provider value={props}>
      <Suspense fallback={<div className="panel muted">Loading…</div>}>
        <C />
      </Suspense>
    </DockPanelContext.Provider>
  );
  return Wrapped;
}

/** Component map for dockview. */
export const DOCK_COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps>> = Object.fromEntries(
  (Object.keys(PANELS) as PanelId[]).map((id) => [id, withSuspense(PANELS[id].component)]),
);
