import type { IDockviewPanelProps } from "dockview-react";
import { createContext, useContext } from "react";

/** The dock's own handles of the panel that is drawing (its window api and the dock's), for a panel that sizes its window to what it holds. Undefined outside a dock. */
export const DockPanelContext = createContext<IDockviewPanelProps | undefined>(undefined);
export const useDockPanel = (): IDockviewPanelProps | undefined => useContext(DockPanelContext);
