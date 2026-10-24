import { COLORS, DOCK_DOT_PX, FOCUS_RING_PX, FONT, HATCH_PITCH_PX, RADIUS_PX, ROW_PX, SPACE_PX, THEME_NAMES, TYPE, Z, type ColorTokens, type ThemeName } from "./tokens.ts";

/** Custom properties of one theme's colours (`--bg0`, `--kind-violet`, `--agent-3`, …). */
function colorVars(c: ColorTokens): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "string") out.push(`--${k}: ${v};`);
  }
  for (const [k, v] of Object.entries(c.kind)) out.push(`--kind-${k}: ${v};`);
  for (const [k, v] of Object.entries(c.port)) out.push(`--port-${k}: ${v};`);
  c.agent.forEach((v, i) => out.push(`--agent-${i}: ${v};`));
  return out;
}

/** Theme-independent custom properties: fonts, type scale, spacing, radii, rows, z-index. */
function sharedVars(): string[] {
  return [
    `--font-sans: ${FONT.sans};`,
    `--font-mono: ${FONT.mono};`,
    // The prose face is for running text only (help, dialog body, descriptions); everything else is `--font-mono`.
    `--font-prose: ${FONT.sans};`,
    ...Object.entries(TYPE).flatMap(([k, v]) => [`--type-${k}-size: ${v.size}px;`, `--type-${k}-weight: ${v.weight};`, ...("letterSpacingEm" in v ? [`--type-${k}-tracking: ${v.letterSpacingEm}em;`] : [])]),
    ...Object.entries(SPACE_PX).map(([k, v]) => `--space-${k}: ${v}px;`),
    ...Object.entries(RADIUS_PX).map(([k, v]) => `--radius-${k}: ${v}px;`),
    ...Object.entries(ROW_PX).map(([k, v]) => `--row-${k}: ${v}px;`),
    ...Object.entries(Z).map(([k, v]) => `--z-${k}: ${v};`),
    `--focus-ring: ${FOCUS_RING_PX}px;`,
    // Patterns built from the theme's own tokens: the dot grid of the dock (from `ln`) and the hatch of what the map does not know.
    `--dock-pattern: radial-gradient(var(--ln) 1px, transparent 1px) 0 0 / ${DOCK_DOT_PX}px ${DOCK_DOT_PX}px;`,
    `--hatch-pattern: repeating-linear-gradient(135deg, var(--hatch) 0 1px, transparent 1px ${HATCH_PITCH_PX}px);`,
  ];
}

const selector = (t: ThemeName) => (t === "dark" ? `:root, :root[data-theme="dark"]` : `:root[data-theme="${t}"]`);

/**
 * The full generated stylesheet: token variables for every theme, then the structural `base.css`.
 * `theme.css` is this output, never edited by hand (ADR-0032 §1); a test fails when it is stale.
 */
export function renderThemeCss(baseCss: string): string {
  const block = (sel: string, lines: string[]) => `${sel} {\n${lines.map((l) => `  ${l}`).join("\n")}\n}\n`;
  const parts = [
    "/* GENERATED from packages/ui/src/theme/tokens.ts and base.css by css.ts — do not edit (ADR-0032 §1).",
    "   Regenerate: UPDATE_THEME_CSS=1 pnpm exec vitest run --project node tools/theme */",
    block(":root", sharedVars()),
    ...THEME_NAMES.map((t) => block(selector(t), [`color-scheme: ${t};`, ...colorVars(COLORS[t])])),
    baseCss.trimEnd(),
    "",
  ];
  return parts.join("\n");
}
