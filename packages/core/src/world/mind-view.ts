/**
 * What a mind is told about the world besides events and its own state (ADR-0005 addition of 2026-10-11, F2 M2d).
 * Every field is built from the agent's own map, entity beliefs and body: never ground truth, never anything that
 * depends on which mind is asking. Types live in core (the lowest layer); `@agentsim/scenarios` builds them.
 */

/** Plain JSON Schema (as generated from tools-schema). */
export type JsonSchema = Record<string, unknown>;

/** Numbers in a mind's view are rounded deterministically across engines (positions and times 0.01, soc 0.001). */
export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface EntityView {
  readonly id: string;
  readonly kind: string;
  readonly xM: number;
  readonly yM: number;
  readonly zM: number;
  readonly observedAtS: number;
  readonly ageS: number;
  readonly state: "detected" | "lost";
}

/** Compact, never the full history or raw grids (ROADMAP appendix). */
export interface BeliefSummary {
  /** Nearest first (ties by ID), at most `MAX_ENTITY_VIEWS`. */
  readonly entities: readonly EntityView[];
  readonly entitiesOmitted: number;
  /** Whole-map integer percentages from the agent's region counts: known of all cells; free and occupied of the known ones. */
  readonly map: { readonly knownPct: number; readonly freePct: number; readonly occupiedPct: number };
}

export const MAX_ENTITY_VIEWS = 16;

/** Compass octant of a direction, +x east and +y north. */
export type Octant = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export type EdgeClass = "open" | "unexplored";

/** The topological summary of ADR-0039 §2: a bounded, local view of space. */
export interface SpaceSummary {
  readonly abstraction: "grid-sectors-v0";
  readonly region: string;
  /** Agent position relative to its region's south-west corner, metres rounded to 1 m. */
  readonly inRegionM: { readonly x: number; readonly y: number };
  readonly regions: readonly {
    readonly id: string;
    /** Rounded to 1 %. */
    readonly knownPct: number;
    /** Of the known cells, rounded to 1 %. */
    readonly freePct: number;
    readonly zones: readonly string[];
    readonly waypoint: { readonly id: string; readonly xM: number; readonly yM: number } | null;
    /** Edges to other listed regions. */
    readonly edges: readonly { readonly to: string; readonly cls: EdgeClass }[];
  }[];
  readonly frontiers: readonly {
    readonly id: string;
    readonly region: string;
    readonly cells: number;
    readonly boundaryM: number;
    readonly xM: number;
    readonly yM: number;
    readonly distanceM: number;
    readonly octant: Octant;
  }[];
  readonly omitted: { readonly regions: number; readonly frontiers: number; readonly markedFrontiers: number };
}

/** An action the agent may start now: its name and the parameter schema from the capability manifest. */
export interface AllowedAction {
  readonly name: string;
  readonly paramsSchema: JsonSchema;
}

/**
 * An action the agent may not start now, with the stable code the start check itself would answer and, for a
 * precondition, which one. Computed by the same predicate as the start check, so the two cannot disagree.
 */
export interface UnavailableAction {
  readonly name: string;
  readonly code: string;
  readonly requires?: string;
}

/** What the world asks the layer above core for: the parts of a request that need the agent's map and entity beliefs. */
export interface MindView {
  readonly beliefs: BeliefSummary;
  readonly space: SpaceSummary;
}

export interface MindViewPort {
  /** Built at a fixed point of the tick (phase 5), from the agent's own beliefs only. */
  view(agentId: string, simTimeS: number): MindView;
}

export const EMPTY_MIND_VIEW: MindView = {
  beliefs: { entities: [], entitiesOmitted: 0, map: { knownPct: 0, freePct: 0, occupiedPct: 0 } },
  space: { abstraction: "grid-sectors-v0", region: "", inRegionM: { x: 0, y: 0 }, regions: [], frontiers: [], omitted: { regions: 0, frontiers: 0, markedFrontiers: 0 } },
};
