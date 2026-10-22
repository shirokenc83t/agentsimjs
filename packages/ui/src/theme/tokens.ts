import { TRACE_KINDS } from "@agentsim/trace";

/**
 * Design tokens (ADR-0032): the single source of every design value. The MUI theme, the generated
 * `theme.css`, dockview, the Three.js scene and (later) React Flow, CodeMirror and charts are themed
 * from these objects. Initial values are the mockups' (`docs/ui/mockups/Tokens.dc.html`), tuned where they
 * missed the declared WCAG contrast (2026-10-04: dark fg3 and ln2 (#636b73: 3:1 also on bg2 header bars); light fg3, ln2, accent, states and the
 * cyan/amber/orange kind families, each by the smallest same-hue lightness change). Tuning is a normal change. This is the only place where literal colours are allowed (lint, ADR-0032 §1).
 */

export type ThemeName = "dark" | "light";
export const THEME_NAMES: readonly ThemeName[] = ["dark", "light"];

/** Hue families of trace kinds (≤ 7, ADR-0032 §5); kinds in one family are told apart by their tag. */
export type KindFamily = "slate" | "violet" | "cyan" | "amber" | "orange" | "green" | "pink";
/** Categorical port colours of flow editors (style B), separate from states and kinds. */
export type PortCategory = "world" | "agent" | "mind" | "planning" | "coordination" | "run";

export interface ColorTokens {
  /** the area behind the panels (ADR-0042 §3): darker than `bg0` */
  readonly dock: string;
  /** content wells: logs, inputs, the map background */
  readonly bg0: string;
  /** panels */
  readonly bg1: string;
  /** headers, bars */
  readonly bg2: string;
  /** hover, tracks */
  readonly bg3: string;
  /** dividers */
  readonly ln: string;
  /** borders, ports */
  readonly ln2: string;
  readonly fg: string;
  /** labels */
  readonly fg2: string;
  /** meta, timestamps */
  readonly fg3: string;
  /** the lines of the hatch that tells the area unknown to an agent from the known one (map, and wherever a state must not rest on colour alone) */
  readonly hatch: string;
  /** shadow of floating windows, popovers and dialogs (the only shadow in the app, ADR-0042 §1) */
  readonly float: string;
  /** the layer behind a modal dialog: an alpha of `bg0` */
  readonly scrim: string;
  /** the one accent: focus, selection, primary action, time cursor */
  readonly ac: string;
  /** text on an accent fill */
  readonly acfg: string;
  /** accent tint, composited on bg1 */
  readonly acbg: string;
  readonly run: string;
  readonly ok: string;
  readonly warn: string;
  readonly alm: string;
  /** alarm tint, composited on bg1 */
  readonly almbg: string;
  readonly kind: Readonly<Record<KindFamily, string>>;
  readonly port: Readonly<Record<PortCategory, string>>;
  /** Categorical agent colours (always shown next to the agent ID). */
  readonly agent: readonly string[];
}

export const COLORS: Readonly<Record<ThemeName, ColorTokens>> = {
  dark: {
    dock: "#06080a",
    bg0: "#0e1115",
    bg1: "#14181d",
    bg2: "#1a1f26",
    bg3: "#232a32",
    ln: "#262d36",
    ln2: "#68737f",
    hatch: "#7d8a99",
    float: "0 6px 24px rgba(0, 0, 0, 0.6)",
    scrim: "rgba(14, 17, 21, 0.72)",
    fg: "#d5dbe3",
    fg2: "#9ba6b3",
    fg3: "#87919c",
    ac: "#5aa4ea",
    acfg: "#0b1520",
    acbg: "rgba(90, 164, 234, 0.14)",
    run: "#3fbccb",
    ok: "#62bd80",
    warn: "#e6ab3e",
    alm: "#f0625a",
    almbg: "rgba(240, 98, 90, 0.13)",
    kind: { slate: "#8d9db0", violet: "#c6a0f2", cyan: "#4fc6d0", amber: "#e8b95e", orange: "#f39864", green: "#8fcbaa", pink: "#ff86a3" },
    port: { world: "#4cc4b0", agent: "#6ea8fe", mind: "#b48cf2", planning: "#f0956a", coordination: "#e8b95e", run: "#7ccf8a" },
    agent: ["#4fc6d0", "#e8b95e", "#c6a0f2", "#8fcbaa", "#ff86a3", "#f39864", "#86adff", "#a9d483"],
  },
  light: {
    dock: "#d3d9df",
    bg0: "#e8ebee",
    bg1: "#f7f8fa",
    bg2: "#eef1f4",
    bg3: "#e1e5ea",
    ln: "#d3d9df",
    ln2: "#81878e",
    hatch: "#5f6c7b",
    float: "0 6px 20px rgba(25, 32, 42, 0.3)",
    scrim: "rgba(232, 235, 238, 0.72)",
    fg: "#19202a",
    fg2: "#465261",
    fg3: "#5c6775",
    ac: "#1b67b7",
    acfg: "#ffffff",
    acbg: "rgba(28, 105, 187, 0.11)",
    run: "#0a707f",
    ok: "#297442",
    warn: "#8b5d00",
    alm: "#c12d26",
    almbg: "rgba(194, 45, 38, 0.08)",
    kind: { slate: "#536275", violet: "#7438bd", cyan: "#0a707f", amber: "#8b5d00", orange: "#a94816", green: "#2b7350", pink: "#b1265a" },
    port: { world: "#0f7d6c", agent: "#2160c4", mind: "#7438bd", planning: "#ad4a16", coordination: "#8f5f00", run: "#2b7a46" },
    agent: ["#0a7685", "#8f5f00", "#7438bd", "#2b7350", "#b1265a", "#ad4a16", "#2858c4", "#3c7419"],
  },
};

export type TraceKindName = (typeof TRACE_KINDS)[number];

/** Each trace kind: hue family and 3-letter tag (mandatory: colour is never the only signal). */
export const KIND_STYLE: Readonly<Record<TraceKindName, { readonly family: KindFamily; readonly tag: string }>> = {
  event: { family: "slate", tag: "EVT" },
  observation: { family: "slate", tag: "OBS" },
  snapshot: { family: "slate", tag: "SNP" },
  thought: { family: "violet", tag: "THK" },
  escalation: { family: "violet", tag: "ESC" },
  action: { family: "cyan", tag: "ACT" },
  injected: { family: "cyan", tag: "INJ" },
  lifecycle: { family: "cyan", tag: "LIF" },
  group: { family: "cyan", tag: "GRP" },
  message: { family: "amber", tag: "MSG" },
  protocol: { family: "amber", tag: "PRT" },
  contract: { family: "amber", tag: "CTR" },
  // Shares the amber family with the `warn` state; told apart by tag (DGR) and glyph.
  degradation: { family: "amber", tag: "DGR" },
  plan: { family: "orange", tag: "PLN" },
  "plan-node": { family: "orange", tag: "PND" },
  policy: { family: "orange", tag: "POL" },
  "policy-rule": { family: "orange", tag: "PRL" },
  compute: { family: "green", tag: "CMP" },
  detector: { family: "green", tag: "DET" },
  reflex: { family: "pink", tag: "RFX" },
};

/** The kind → tag → colour table for a theme, generated from the closed kind list (ADR-0004). */
export function kindTable(theme: ThemeName): readonly { readonly kind: TraceKindName; readonly tag: string; readonly color: string }[] {
  return TRACE_KINDS.map((kind) => {
    const s = KIND_STYLE[kind];
    return { kind, tag: s.tag, color: COLORS[theme].kind[s.family] };
  });
}

export type StateName = "run" | "ok" | "warn" | "alm" | "idle";
/** States are always shown with a glyph (ADR-0032 §5). */
export const STATE_GLYPH: Readonly<Record<StateName, string>> = { run: "▶", ok: "✓", warn: "▲", alm: "✕", idle: "○" };

/**
 * One glyph per meaning everywhere (ADR-0042 §4), all from the JetBrains Mono character set, no emoji: failure ✕, warning ▲, paused ❚❚, replay ◷
 * (▶ is the glyph of a running simulation and is never used for replay).
 */
export const GLYPH = { fail: "✕", warn: "▲", paused: "❚❚", replay: "◷", running: "▶", ok: "✓", idle: "○", info: "●" } as const;

export const FONT = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",
} as const;

/**
 * Type scale (px, weight), ADR-0042 §2. JetBrains Mono for the whole chrome; `prose` (IBM Plex Sans) only for running text: help, dialog body, descriptions.
 * 11 px is the minimum. `mono` and `monoState` are the body and label sizes under the names the stylesheets already use.
 */
export const TYPE = {
  /** uppercase */
  title: { size: 13, weight: 600, letterSpacingEm: 0.06 },
  body: { size: 12, weight: 400 },
  /** uppercase */
  label: { size: 11, weight: 600, letterSpacingEm: 0.1 },
  clock: { size: 22, weight: 600 },
  telemetry: { size: 15, weight: 600 },
  prose: { size: 12.5, weight: 400 },
  mono: { size: 12, weight: 400 },
  monoState: { size: 11, weight: 600 },
} as const;
/** The smallest text size of the interface (px). */
export const TYPE_MIN_PX = 11;

export const SPACE_PX = { xxs: 2, xs: 4, s: 6, m: 8, l: 12, xl: 16, xxl: 24 } as const;
/** Panels, windows and controls are square (ADR-0042 §1); the flow editor's nodes keep their radius. */
export const RADIUS_PX = { control: 0, node: 8 } as const;
export const ROW_PX = { compact: 20, comfortable: 25 } as const;
export const Z = { dock: 1, hud: 10, popover: 1000, dialog: 1100 } as const;
export const MOTION_MS = { fast: 120, normal: 200 } as const;
export const FOCUS_RING_PX = 2;
/** A tooltip appears after this long over its target (ADR-0042 §6). */
export const TOOLTIP_DELAY_MS = 400;
/** Pitch (px) of the dock's dot grid and of the hatch lines (ADR-0042 §3). */
export const DOCK_DOT_PX = 12;
export const HATCH_PITCH_PX = 5;

export type ColorPath = Exclude<keyof ColorTokens, "kind" | "port" | "agent"> | `kind.${KindFamily}` | `port.${PortCategory}` | `agent.${number}`;

/** Resolves a colour path (`fg2`, `kind.violet`, `agent.3`) in a theme. */
export function colorAt(theme: ThemeName, path: ColorPath): string {
  const c = COLORS[theme];
  const [head, tail] = path.split(".") as [string, string | undefined];
  if (tail === undefined) return c[head as Exclude<keyof ColorTokens, "kind" | "port" | "agent">];
  if (head === "kind") return c.kind[tail as KindFamily];
  if (head === "port") return c.port[tail as PortCategory];
  const a = c.agent[Number(tail)];
  if (a === undefined) throw new RangeError(`no agent colour ${tail}`);
  return a;
}

type Surface = "bg0" | "bg1" | "bg2" | "bg3";
const ALL_SURFACES: readonly Surface[] = ["bg0", "bg1", "bg2", "bg3"];

/**
 * What a colour pair is used for, which fixes the contrast rule applied to it (WCAG):
 * - `text`: 4.5:1 (1.4.3);
 * - `control`: 3:1 (1.4.11): boundaries needed to identify a control (inputs, selects, outlined buttons,
 *   ports, focusable node borders), the focus ring, and graphical objects needed to understand content
 *   (agent marks on the canvas);
 * - `decorative`: no minimum (panel frames, dividers, other decorative lines). Declared anyway, so that
 *   using a decorative token for a control boundary is a visible decision, not an accident.
 */
export type ContrastRole = "text" | "control" | "decorative";
export const CONTRAST_MIN: Readonly<Record<ContrastRole, number>> = { text: 4.5, control: 3, decorative: 0 };

/** Declared (foreground, surfaces, role) pairs checked by the contrast test (ADR-0032 §5). */
export const CONTRAST_PAIRS: readonly { readonly fg: ColorPath; readonly on: readonly ColorPath[]; readonly role: ContrastRole }[] = [
  ...(["fg", "fg2", "fg3", "run", "ok", "warn", "alm"] as const).map((fg) => ({ fg, on: ALL_SURFACES, role: "text" as const })),
  ...(Object.keys(COLORS.dark.kind) as KindFamily[]).map((f) => ({ fg: `kind.${f}` as const, on: ALL_SURFACES, role: "text" as const })),
  { fg: "ac", on: ALL_SURFACES, role: "text" },
  { fg: "acfg", on: ["ac"], role: "text" },
  // Control boundaries: ln2 is for controls only (inputs, selects, outlined buttons, ports, node borders).
  { fg: "ln2", on: ["bg0", "bg1", "bg2"], role: "control" },
  { fg: "hatch", on: ["bg0", "bg1"], role: "control" },
  ...(Object.keys(COLORS.dark.port) as PortCategory[]).map((p) => ({ fg: `port.${p}` as const, on: ["bg0", "bg1"] as const, role: "control" as const })),
  ...COLORS.dark.agent.map((_c, i) => ({ fg: `agent.${i}` as const, on: ["bg0", "bg1"] as const, role: "control" as const })),
  // Decorative: ln for panel frames and dividers.
  { fg: "ln", on: ALL_SURFACES, role: "decorative" },
];

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const ch = (h: string) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(m[1] as string) + 0.7152 * ch(m[2] as string) + 0.0722 * ch(m[3] as string);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Stable agent colour from the ID (computed once per agent, not per frame; ADR-0032 §2). */
export function agentColorIndex(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % COLORS.dark.agent.length;
}

/** Colours of the Three.js scene, as a plain snapshot handed to the renderer on theme change (ADR-0032 §2, §7). */
export interface SceneTokens {
  readonly background: string;
  readonly ground: string;
  readonly gridMajor: string;
  readonly gridMinor: string;
  readonly light: string;
  readonly selection: string;
  readonly agent: readonly string[];
  /** Grid atlas (ADR-0027): free and blocked cells, chunks not received yet. */
  readonly cellFree: string;
  readonly cellBlocked: string;
  readonly cellUnloaded: string;
  /** Terrain cost ramp (low → high) and impassable terrain. */
  readonly terrainLo: string;
  readonly terrainHi: string;
  readonly impassable: string;
  /** Height ramp (low → high), and the hatching of occupied cells with unknown height (ADR-0012/0025). */
  readonly heightLo: string;
  readonly heightHi: string;
  readonly unknownHeight: string;
  /** Belief overlay (F2, ADR-0027): what the agent believes (unknown / free / occupied). The unknown area is hatched with `beliefHatch` (ADR-0042 §3). */
  readonly beliefUnknown: string;
  readonly beliefHatch: string;
  readonly beliefFree: string;
  readonly beliefOccupied: string;
  /** Researcher-only difference mode: believed occupied but free (hatched), believed free but blocked (cross-hatched). */
  readonly diffPhantom: string;
  readonly diffFalseFree: string;
  /** Zone outlines (base, geofence, no-fly). */
  readonly zone: string;
  /** Planned and executed path lines are drawn in the agent's colour; this is the dash gap tint. */
  readonly pathPlannedDim: string;
  /**
   * Stages overlay (F2b, ADR-0037): the coarse path of a refine (dashed), its legs in two alternating tones (solid, with numbered
   * joints), and everything the researcher's Strategy test draws (a tone of its own, so a sandbox path is never taken for a run's).
   */
  readonly stageCoarse: string;
  readonly stageLeg: string;
  readonly stageLegAlt: string;
  readonly stageSandbox: string;
}

const SCENE_BASE: Readonly<Record<ThemeName, Omit<SceneTokens, "selection" | "agent" | "beliefHatch">>> = {
  dark: {
    background: "#0e1115",
    ground: "#202a35",
    gridMajor: "#3a4656",
    gridMinor: "#34414f",
    light: "#ffffff",
    cellFree: "#202a35",
    cellBlocked: "#6e7b89",
    cellUnloaded: "#0e1115",
    terrainLo: "#1c2a22",
    terrainHi: "#7a6431",
    impassable: "#4a2226",
    heightLo: "#1a2230",
    heightHi: "#a9c1e0",
    unknownHeight: "#e6ab3e",
    beliefUnknown: "#07090b",
    beliefFree: "#26384a",
    beliefOccupied: "#a9b6c4",
    diffPhantom: "#e0704f",
    diffFalseFree: "#f2c230",
    zone: "#62bd80",
    pathPlannedDim: "#9ba6b3",
    stageCoarse: "#c59cff",
    stageLeg: "#3fd0c0",
    stageLegAlt: "#ff9bd0",
    stageSandbox: "#ffb454",
  },
  light: {
    background: "#e8ebee",
    ground: "#c4ccd5",
    gridMajor: "#8995a3",
    gridMinor: "#a9b3be",
    light: "#ffffff",
    cellFree: "#c4ccd5",
    cellBlocked: "#5f6b78",
    cellUnloaded: "#e8ebee",
    terrainLo: "#d6e6d7",
    terrainHi: "#b48a3c",
    impassable: "#e3aaa5",
    heightLo: "#e3e8ee",
    heightHi: "#3d5f8c",
    unknownHeight: "#8b5d00",
    beliefUnknown: "#aeb6bf",
    beliefFree: "#d4e0ee",
    beliefOccupied: "#4a5866",
    diffPhantom: "#c24a2a",
    diffFalseFree: "#a77900",
    zone: "#297442",
    pathPlannedDim: "#465261",
    stageCoarse: "#6b3fb5",
    stageLeg: "#00796b",
    stageLegAlt: "#b3267a",
    stageSandbox: "#a64b00",
  },
};

export function sceneTokens(theme: ThemeName): SceneTokens {
  return { ...SCENE_BASE[theme], beliefHatch: COLORS[theme].hatch, selection: COLORS[theme].ac, agent: COLORS[theme].agent };
}
