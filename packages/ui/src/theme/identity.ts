import { COLORS } from "./tokens.ts";

/**
 * An agent's identity on the map and in every list (ADR-0042 §3; UI-SPEC §4): a colour and a marker style, 8 × 3 = 24 distinct ones, given by the agent's place in the
 * run (the same agent has the same identity in the Scene, the Explorer, the log and the Inspector). The ID text always goes with it: colour and style are never the only
 * signal.
 */
export type MarkerStyle = "solid" | "outline" | "dashed";

const STYLES: readonly MarkerStyle[] = ["solid", "outline", "dashed"];
/** Colours in the agent palette (they come from the tokens). */
export const IDENTITY_COLOURS = COLORS.dark.agent.length;
export const IDENTITY_COUNT = IDENTITY_COLOURS * STYLES.length;

export interface Identity {
  /** Index into the agent colours of the theme. */
  readonly colorIndex: number;
  readonly style: MarkerStyle;
}

/** The identity of the agent at `index` in the run's agent list; past 24 agents the identities repeat. */
export function identityOf(index: number): Identity {
  const k = ((Math.trunc(index) % IDENTITY_COUNT) + IDENTITY_COUNT) % IDENTITY_COUNT;
  return { colorIndex: k % IDENTITY_COLOURS, style: STYLES[Math.floor(k / IDENTITY_COLOURS)] as MarkerStyle };
}

/** The grey of every agent that is not the subject (ADR-0043 §3): `fg3` in the stylesheets. */
export const SUBJECT_NEUTRAL = "var(--fg3)";

/** One subject, one hue: the selected agent keeps its identity colour, the others are neutral; with no agent selected every agent keeps its own. */
export function isMuted(selectedId: string | undefined, id: string): boolean {
  return selectedId !== undefined && selectedId !== id;
}

/** The CSS colour of the agent `id` with identity colour `colorIndex`, given the selected agent (if any). */
export function subjectColor(colorIndex: number, selectedId: string | undefined, id: string): string {
  return isMuted(selectedId, id) ? SUBJECT_NEUTRAL : `var(--agent-${colorIndex})`;
}

/**
 * The short label of the map: `g07` for `ugv-007`, `a07` for `uav-007` (g for ground, a for aerial); any other ID is shown whole up to six characters. The full ID is in
 * the tooltip, the Explorer and the Inspector.
 */
export function shortLabel(id: string): string {
  const m = /^(ugv|uav)-0*(\d+)$/.exec(id);
  if (!m) return id.length > 6 ? `${id.slice(0, 5)}…` : id;
  const n = m[2] as string;
  return `${m[1] === "ugv" ? "g" : "a"}${n.padStart(2, "0")}`;
}
