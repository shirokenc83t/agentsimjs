import type { PanelId } from "./registry.tsx";

/** Workspaces available in F0 (UI-SPEC §3, §11). Others arrive with their phases. */
export type WorkspaceId = "scene" | "debug" | "configurations" | "data" | "settings" | "experiments" | "analysis";

export interface PresetPanel {
  readonly id: PanelId;
  /** Where the panel goes relative to an earlier one (default: a tab next to the previous panel). */
  readonly position?: { readonly referencePanel: PanelId; readonly direction: "left" | "right" | "above" | "below" };
  /** Initial width (px) for side panels. */
  readonly initialWidth?: number;
  /** Initial height (px) for panels below another: the Timeline is as tall as its lanes, not half the window. */
  readonly initialHeight?: number;
  /** The same as a share of the dock (0 to 1), which wins when the dock has a size; `minWidthPx` keeps a column readable (the Log needs 420 px for its summary column). */
  readonly initialWidthPct?: number;
  readonly initialHeightPct?: number;
  readonly minWidthPx?: number;
  /** A tab that does not take the focus of its group when the workspace is laid out: the panel the researcher came for stays in front, this one is a click away. */
  readonly background?: boolean;
  /** Laid out after the other docked panels (its number in the workspace is still its place in the list): a panel below the Scene alone is made once the column beside it exists. */
  readonly late?: boolean;
  /**
   * A panel that starts as a floating window (inside the app, ADR-0042 §1), not in the grid: its open size, whether it starts collapsed to its title bar, and where it
   * sits: at the bottom right of the panel it belongs to (`host`), `stack` windows up from the bottom of it (0 is the lowest), `side: "left"` at the bottom left of it instead
   * (the Overview and the Legend open together without covering each other: one at each side of the map).
   */
  readonly floating?: { readonly width: number; readonly height: number; readonly collapsed: boolean; readonly host?: PanelId | undefined; readonly stack?: number; /** A collapsed window sits in a row along the host's bottom edge: its place in the row, from the corner of its side (0 first). */ readonly slot?: number; readonly side?: "left" };
}

export interface WorkspacePreset {
  readonly id: WorkspaceId;
  readonly title: string;
  /** Default panels; the first one fills the area. */
  readonly panels: readonly PresetPanel[];
}

/**
 * The Performance HUD: a floating window inside the map of the Scene (Scene and Debug), collapsed until opened (ADR-0042 §5). Elsewhere it is closed and is opened from
 * the frame segment of the status bar or from the palette (`openPanel` falls back to this, open, at the bottom right of the dock).
 */
export const PERF_WINDOW: PresetPanel = { id: "perf", floating: { width: 300, height: 400, collapsed: true, host: "scene", stack: 0, slot: 0 } };
/**
 * The trace graph (U-010 §2): a big floating window opened from the Trace panel or the palette, in no workspace's preset. "5c" is the Trace's sub-window: the Trace is panel 5 of
 * the Debug.
 */
export const TRACE_GRAPH_WINDOW: PresetPanel = { id: "traceGraph", floating: { width: 1360, height: 840, collapsed: false } };
/** The SQL results pinned in a window (U-010 section 5): opened from the console, in no preset. */
export const SQL_RESULT_WINDOW: PresetPanel = { id: "sqlResult", floating: { width: 760, height: 420, collapsed: false } };
/** The windows of the Scene (ADR-0042 section 8): all start collapsed, in one row along the bottom edge of the map (the Overview at the left, the Legend and the Performance window at the right) so that they hide none of it; opened, each grows from there. */
const OVERVIEW_WINDOW: PresetPanel = { id: "overview", floating: { width: 200, height: 200, collapsed: true, host: "scene", stack: 1, slot: 0, side: "left" } };
const LEGEND_WINDOW: PresetPanel = { id: "legend", floating: { width: 300, height: 330, collapsed: true, host: "scene", stack: 1, slot: 1 } };

/**
 * The Debug as it opens (U-010 §3, "debug · default"): the Scene 62 % wide and 62 % high with the Timeline under it, and a right column of 38 % holding the Log (46 %), the Trace
 * (24 %) and the Inspector (30 %). The Trace sits under the Log because it explains the record picked there. Panel numbers are the order of this list in every variant.
 */
const DEBUG_DEFAULT_PANELS: readonly PresetPanel[] = [
  { id: "scene" },
  { id: "timeline", position: { referencePanel: "scene", direction: "below" }, initialHeight: 190, initialHeightPct: 0.38, late: true },
  { id: "eventList", position: { referencePanel: "scene", direction: "right" }, initialWidth: 500, initialWidthPct: 0.38 },
  { id: "inspector", position: { referencePanel: "eventList", direction: "below" }, initialHeight: 210, initialHeightPct: 0.38 },
  { id: "traceTree", position: { referencePanel: "inspector", direction: "above" }, initialHeight: 180, initialHeightPct: 0.22 },
];

/**
 * Scene workspace (UI-SPEC §3): The Scene in the middle, Explorer left, Inspector right. Timeline and the log
 * console join in F3.
 */
export const WORKSPACES: readonly WorkspacePreset[] = [
  // Configurations (UI-SPEC §3): the first workspace, where a run is set up: the scenario editor and the run configuration as tabs (the editor active).
  {
    id: "configurations",
    title: "Configurations",
    panels: [{ id: "runConfig" }, { id: "scenarioEditor", background: true }],
  },
  {
    id: "scene",
    title: "Scene",
    panels: [
      { id: "scene" },
      { id: "explorer", position: { referencePanel: "scene", direction: "left" }, initialWidth: 300 },
      { id: "inspector", position: { referencePanel: "scene", direction: "right" }, initialWidth: 340 },
      PERF_WINDOW,
      OVERVIEW_WINDOW,
      LEGEND_WINDOW,
    ],
  },
  // Debug (UI-SPEC §3, F3a M3): the Scene at the cursor, the Timeline under it, the event list and the Inspector beside it. Everything follows the shared cursor.
  {
    id: "debug",
    title: "Debug",
    panels: [
      ...DEBUG_DEFAULT_PANELS,
      PERF_WINDOW,
    ],
  },
  // Data (U-010 section 5): the Storage a third of the height, the SQL console the rest.
  { id: "data", title: "Data", panels: [{ id: "storage" }, { id: "sqlConsole", position: { referencePanel: "storage", direction: "below" }, initialHeight: 330, initialHeightPct: 0.7 }] },
  { id: "settings", title: "Settings", panels: [{ id: "settings" }] },
  // Experiments (UI-SPEC section 3): ships with only the headless run monitor; the batch runner and the results of F13 join it there.
  { id: "experiments", title: "Experiments", panels: [{ id: "headlessMonitor" }] },
  // Analysis (ADR-0029, UI-SPEC section 3): recorded runs only, read from storage; v1 is one panel: the map, the event timeline with its brush, the series, the filters and the exports.
  { id: "analysis", title: "Analysis", panels: [{ id: "analysisView" }] },
];

/**
 * A named layout that ships with the app (ADR-0042 named layouts: the dock arranged for one job, not a workspace of its own): "debug · logs" is the Debug for reading logs. The
 * multi-log inspector fills the area (its sources, its grid of one to four panes) with the shared Timeline across the bottom; the Scene is out. It is entered from the palette
 * ("Open panel: Logs", `Alt+6` in the Debug) or the layout menu, and left with "Back to debug", which puts the dock back as it was.
 */
export const DEBUG_LOGS_LAYOUT = "debug \u00b7 logs";
export const DEBUG_LOGS_PRESET: WorkspacePreset = {
  id: "debug",
  title: "Debug",
  panels: [{ id: "logInspector" }, { id: "timeline", position: { referencePanel: "logInspector", direction: "below" }, initialHeight: 190, late: true }],
};

/**
 * "debug · two columns" (U-010 §3): the Scene and the Timeline in a column of 46 %, the Log full height in a column of 28 % (at least 420 px), and the Trace (42 %) over the
 * Inspector (58 %) in the last 26 %. A preset like the default: it becomes the working layout, which can be resized, saved under a name and reset.
 */
export const DEBUG_TWO_COLUMNS_PRESET: WorkspacePreset = {
  id: "debug",
  title: "Debug",
  panels: [
    { id: "scene" },
    { id: "timeline", position: { referencePanel: "scene", direction: "below" }, initialHeight: 190, initialHeightPct: 0.38, late: true },
    { id: "eventList", position: { referencePanel: "scene", direction: "right" }, initialWidth: 760, initialWidthPct: 0.54, minWidthPx: 420 },
    { id: "inspector", position: { referencePanel: "eventList", direction: "right" }, initialWidth: 380, initialWidthPct: 0.26 },
    { id: "traceTree", position: { referencePanel: "inspector", direction: "above" }, initialHeight: 320, initialHeightPct: 0.42 },
    PERF_WINDOW,
  ],
};

/** The presets of a workspace that can be put on as its working layout, by name (the first is the workspace's own). */
export const LAYOUT_VARIANTS: Readonly<Partial<Record<WorkspaceId, readonly { readonly name: string; readonly preset: WorkspacePreset }[]>>> = {
  debug: [
    { name: "debug · default", preset: { id: "debug", title: "Debug", panels: [...DEBUG_DEFAULT_PANELS, PERF_WINDOW] } },
    { name: "debug · two columns", preset: DEBUG_TWO_COLUMNS_PRESET },
  ],
};

/** The layouts that ship with a workspace, by name. */
export const BUILTIN_LAYOUTS: Readonly<Partial<Record<WorkspaceId, readonly { readonly name: string; readonly preset: WorkspacePreset }[]>>> = {
  debug: [{ name: DEBUG_LOGS_LAYOUT, preset: DEBUG_LOGS_PRESET }],
};

/** The number of a docked panel in its workspace (1-based, the order of the preset): it is in the tab's name and `Alt+number` focuses it. Floating windows have none. */
export function panelNumber(preset: WorkspacePreset, id: PanelId): number | undefined {
  const docked = preset.panels.filter((p) => !p.floating);
  const i = docked.findIndex((p) => p.id === id);
  return i < 0 ? undefined : i + 1;
}

/** The tab title of a panel: `[2] Explorer`. */
export function tabTitle(preset: WorkspacePreset, id: PanelId, title: string): string {
  if (id === "traceGraph") return `[5c] ${title}`;
  const n = panelNumber(preset, id);
  return n === undefined ? title : `[${n}] ${title}`;
}

export const LAYOUT_NAMESPACE = "layout";
/**
 * Saved layouts are keyed with this version: a preset that gains panels (F1 e4: Explorer, Inspector; F3a: the Debug workspace) starts
 * from the new preset instead of a saved layout that lacks them.
 */
export const LAYOUT_VERSION = 12;
export const layoutKey = (workspace: WorkspaceId) => `${workspace}@${LAYOUT_VERSION}`;
