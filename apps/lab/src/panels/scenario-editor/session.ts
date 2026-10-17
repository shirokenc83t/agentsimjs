import type { ScenarioDocument } from "@agentsim/scenarios";
import type { GridViewMode } from "@agentsim/ui";
import type { Brush, ScenarioDraft } from "./model.ts";

export type Tool = "navigate" | "paint" | "zone" | "agent" | "object";

/**
 * The editor session for the page's lifetime: dockview unmounts inactive tabs and workspace switches unmount
 * every panel, so the draft (and its unsaved edits) lives here, not in component state. Not persisted across
 * reloads: unsaved work is lost on reload, saved versions are in storage.
 */
export interface EditorSession {
  draft: ScenarioDraft | undefined;
  /** The stored version the draft was opened from or saved as, with the draft revision at that time. */
  saved: { version: number; revision: number; document: ScenarioDocument } | undefined;
  tool: Tool;
  brush: Brush;
  viewMode: GridViewMode;
}

export const editorSession: EditorSession = {
  draft: undefined,
  saved: undefined,
  tool: "navigate",
  brush: { layer: "occupancy", value: 1, radiusCells: 1 },
  viewMode: "occupancy",
};
