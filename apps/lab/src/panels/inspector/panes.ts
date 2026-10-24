import { COMPONENTS_BY_OWNER, parseFilter } from "@agentsim/trace";

// The panes of the multi-log inspector (ADR-0035 section 7): up to N, each a subscription (a filter) with a view type. Pure: the model the panel draws and the layout it keeps.

export const MAX_PANES = 4;

export type PaneView = "log" | "table" | "series";

/** The view types that are not there yet and the phase that brings each: shown disabled, naming the phase. */
export const FUTURE_VIEWS = [
  { name: "mind I/O", phase: "F4" },
  { name: "ladder", phase: "F8" },
] as const;

export interface PaneSpec {
  readonly id: string;
  readonly view: PaneView;
  /** A filter of the log console's language: records for a log or a table, samples (`metric:`) for a series. */
  readonly filter: string;
  readonly title: string;
}

/** The owner of a source, written as a filter that selects all of its components, or one of them. */
export const sourceFilter = (owner: string, component?: string): string => `source:${owner}/${component ?? "*"}`;

export function paneFor(id: string, view: PaneView, filter: string, title: string): PaneSpec {
  return { id, view, filter, title };
}

export const filterFitsView = (filter: string, view: PaneView): boolean => {
  const parsed = parseFilter(filter);
  return parsed.ok && parsed.value.target === (view === "series" ? "metrics" : "records");
};

/** Adds a pane; at the limit the oldest goes (the newest is what the researcher asked for). */
export function addPane(panes: readonly PaneSpec[], pane: PaneSpec): PaneSpec[] {
  return [...panes.filter((p) => p.id !== pane.id), pane].slice(-MAX_PANES);
}

export const removePane = (panes: readonly PaneSpec[], id: string): PaneSpec[] => panes.filter((p) => p.id !== id);

export const updatePane = (panes: readonly PaneSpec[], id: string, change: Partial<Omit<PaneSpec, "id">>): PaneSpec[] => panes.map((p) => (p.id === id ? { ...p, ...change } : p));

/** What a pane is given as its filter when its view changes: a filter that does not fit the new view becomes that view's own start. */
export function filterAfterViewChange(filter: string, view: PaneView): string {
  if (filterFitsView(filter, view)) return filter;
  return view === "series" ? "metric:agent.soc" : "-source:*/body";
}

/** The panes a researcher starts with: what is going on in the world, and the tick cost. */
export const DEFAULT_PANES: readonly PaneSpec[] = [
  { id: "p1", view: "log", filter: "kind:action,reflex,degradation", title: "actions and flags" },
  { id: "p2", view: "series", filter: "metric:sim.tickMs", title: "tick cost" },
];

/** A node of the source tree: an owner and the components it has. */
export interface SourceNode {
  readonly owner: string;
  readonly components: readonly string[];
}

/** Every agent with the components its kind of owner has, and the world's `sim` and `storage`. Groups and protocol instances join when a run has them. */
export function sourceTree(agentIds: readonly string[]): SourceNode[] {
  return [...agentIds.map((owner) => ({ owner, components: [...COMPONENTS_BY_OWNER.agent] })), { owner: "world", components: [...COMPONENTS_BY_OWNER.world] }];
}

/** The series a node of the tree offers: the agent's or the world's metrics of the registry. */
export function metricFilterFor(owner: string): string {
  return owner === "world" ? "metric:sim.tickMs,sim.senseMs source:world/sim" : `metric:agent.soc,agent.speedMps source:${owner}/body`;
}
