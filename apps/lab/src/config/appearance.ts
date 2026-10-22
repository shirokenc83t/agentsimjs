import { readBootSetting, writeBootSetting } from "@agentsim/ui";

/** The two per-viewer appearance preferences besides the theme: no motion at all, and the dot grid of the dock area. */
export interface Appearance {
  readonly reducedMotion: boolean;
  readonly dockGrid: boolean;
}

export function readAppearance(): Appearance {
  return { reducedMotion: readBootSetting("ui.reducedMotion") === "1", dockGrid: readBootSetting("ui.dockGrid") !== "off" };
}

export function writeAppearance(a: Appearance): void {
  writeBootSetting("ui.reducedMotion", a.reducedMotion ? "1" : "0");
  writeBootSetting("ui.dockGrid", a.dockGrid ? "on" : "off");
}

/** Puts the preferences on the document element (`data-motion`, `data-dockgrid`); the stylesheets follow them. */
export function applyAppearance(a: Appearance): void {
  const d = document.documentElement.dataset;
  if (a.reducedMotion) d["motion"] = "reduce";
  else delete d["motion"];
  if (a.dockGrid) delete d["dockgrid"];
  else d["dockgrid"] = "off";
}
