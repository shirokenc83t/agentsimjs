import { createContext } from "react";
import type { WorkspacePreset } from "./presets.ts";

/** The preset of the open workspace, for the parts of the dock that live inside it (the window buttons dock a panel back to where its preset puts it). */
export const PresetContext = createContext<WorkspacePreset | undefined>(undefined);
