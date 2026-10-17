import type { PanelId } from "./registry.tsx";

/** Workspaces available in F0 (UI-SPEC §3, §11). Others arrive with their phases. */
export type WorkspaceId = "scene" | "author" | "data" | "settings";

export interface PresetPanel {
  readonly id: PanelId;
  /** Where the panel goes relative to an earlier one (default: a tab next to the previous panel). */
  readonly position?: { readonly referencePanel: PanelId; readonly direction: "left" | "right" | "above" | "below" };
  /** Initial width (px) for side panels. */
  readonly initialWidth?: number;
}

export interface WorkspacePreset {
  readonly id: WorkspaceId;
  readonly title: string;
  /** Default panels; the first one fills the area. */
  readonly panels: readonly PresetPanel[];
}

/**
 * Scene workspace (UI-SPEC §3): Scene 3D in the middle, Explorer left, Inspector right. Timeline and the log
 * console join in F3.
 */
export const WORKSPACES: readonly WorkspacePreset[] = [
  {
    id: "scene",
    title: "Scene",
    panels: [
      { id: "scene" },
      { id: "explorer", position: { referencePanel: "scene", direction: "left" }, initialWidth: 300 },
      { id: "inspector", position: { referencePanel: "scene", direction: "right" }, initialWidth: 340 },
    ],
  },
  // Author (UI-SPEC §3): the scenario editor and the run configuration as tabs (the editor active).
  {
    id: "author",
    title: "Author",
    panels: [{ id: "runConfig" }, { id: "scenarioEditor" }],
  },
  { id: "data", title: "Data", panels: [{ id: "storage" }] },
  { id: "settings", title: "Settings", panels: [{ id: "settings" }] },
];

export const LAYOUT_NAMESPACE = "layout";
/**
 * Saved layouts are keyed with this version: a preset that gains panels (F1 e4: Explorer, Inspector) starts
 * from the new preset instead of a saved layout that lacks them.
 */
export const LAYOUT_VERSION = 3;
export const layoutKey = (workspace: WorkspaceId) => `${workspace}@${LAYOUT_VERSION}`;
