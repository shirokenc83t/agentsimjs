import { TRACE_KINDS } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { agentColorIndex, colorAt, COLORS, CONTRAST_MIN, CONTRAST_PAIRS, contrastRatio, FONT, GLYPH, KIND_STYLE, kindTable, RADIUS_PX, sceneTokens, STATE_GLYPH, THEME_NAMES, TYPE, TYPE_MIN_PX } from "./tokens.ts";

/** Every token path of a theme, flattened (`kind.violet`, `agent.3`, …). */
function paths(o: unknown, prefix = ""): string[] {
  if (typeof o === "string") return [prefix];
  if (Array.isArray(o)) return o.flatMap((v, i) => paths(v, `${prefix}.${i}`));
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

describe("design tokens (ADR-0032)", () => {
  it("the dark theme is the neutral dark of ADR-0043 §1 (no hue in the surfaces and the text); the one value that differs is named", () => {
    const d = COLORS.dark;
    expect({ dock: d.dock, bg0: d.bg0, bg1: d.bg1, bg2: d.bg2, bg3: d.bg3, fg: d.fg, fg2: d.fg2 }).toEqual({ dock: "#19191c", bg0: "#0b0b0d", bg1: "#121214", bg2: "#1c1c20", bg3: "#27272c", fg: "#ececee", fg2: "#a9aaaf" });
    // The ADR's `ln2` (#3e3e45) is the hairline of frames and dividers, which is `ln` here; `ln2` stays the boundary of controls and must meet 3:1 (WCAG 1.4.11, ADR-0032): a neutral grey at that contrast. `fg3` is the ADR's, lifted
    // by 4 lightness steps so it reads at 4.5:1 also on hover (bg3), the rule of every text pair above.
    expect(d.ln).toBe("#3e3e45");
    expect(d.ac).toBe("#5aa4ea"); // the accent hue is unchanged
    for (const t of THEME_NAMES) for (const k of ["dock", "bg0", "bg1", "bg2", "bg3", "ln", "ln2", "fg", "fg2", "fg3", "hatch"] as const) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(COLORS[t][k].slice(i, i + 2), 16)) as [number, number, number];
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${t}.${k} is a neutral grey`).toBeLessThanOrEqual(8);
    }
  });

  it("dark and light define the same token names", () => {
    expect(paths(COLORS.light).sort()).toEqual(paths(COLORS.dark).sort());
  });

  it("every declared (foreground, surface) pair reaches the contrast of its role in both themes", () => {
    const failures: string[] = [];
    for (const t of THEME_NAMES) {
      for (const p of CONTRAST_PAIRS) {
        for (const on of p.on) {
          const r = contrastRatio(colorAt(t, p.fg), colorAt(t, on));
          const min = CONTRAST_MIN[p.role];
          if (r < min) failures.push(`${t}: ${p.fg} on ${on} (${p.role}) = ${r.toFixed(2)} < ${min}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("the scene tells the ground from the background and shows its grid, in both themes", () => {
    // Graphical objects need 3:1 only when they carry meaning alone; the ground and its grid are context for the agents, so the rule is lower, and a floor:
    // a ground that is 1.1:1 against the background (the dark and the light theme before F2c) is not seen at all.
    for (const t of THEME_NAMES) {
      const s = sceneTokens(t);
      expect(contrastRatio(s.ground, s.background), `${t}: ground on background`).toBeGreaterThanOrEqual(1.3);
      expect(contrastRatio(s.cellFree, s.background), `${t}: free cells on background`).toBeGreaterThanOrEqual(1.3);
      expect(contrastRatio(s.gridMinor, s.ground), `${t}: minor grid on ground`).toBeGreaterThanOrEqual(1.25);
      expect(contrastRatio(s.gridMajor, s.ground), `${t}: major grid on ground`).toBeGreaterThanOrEqual(1.5);
      expect(contrastRatio(s.cellBlocked, s.cellFree), `${t}: walls on the ground`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the attention tints (alarm and warning) carry text at 4.5:1 and their role colour at 3:1, over the content well and the panel", () => {
    // The tint is an alpha colour: what is seen is the tint composited over the surface.
    const over = (rgba: string, hex: string): string => {
      const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
      if (!m) throw new Error(rgba);
      const a = Number(m[4]);
      const base = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
      return `#${[1, 2, 3].map((k, i) => hex2(Number(m[k]) * a + (base[i] ?? 0) * (1 - a))).join("")}`;
    };
    for (const t of THEME_NAMES) {
      const c = COLORS[t];
      for (const [tint, role, name] of [[c.almbg, c.alm, "alarm"], [c.warnbg, c.warn, "warning"]] as const) {
        for (const surface of [c.bg0, c.bg1]) {
          const seen = over(tint, surface);
          expect(contrastRatio(c.fg, seen), `${t}: text on the ${name} tint over ${surface}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(role, seen), `${t}: the ${name} glyph and edge on its tint over ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    const s = sceneTokens("dark");
    expect([s.alarm, s.warning]).toEqual([COLORS.dark.alm, COLORS.dark.warn]);
  });

  it("ln2 is declared for control boundaries and ln as decorative (the rule applied is explicit)", () => {
    expect(CONTRAST_PAIRS.find((p) => p.fg === "ln2")?.role).toBe("control");
    expect(CONTRAST_PAIRS.find((p) => p.fg === "ln")?.role).toBe("decorative");
    expect(CONTRAST_MIN).toEqual({ text: 4.5, control: 3, decorative: 0 });
  });

  it("the kind table is generated from the closed trace kind list: every kind has a unique tag and a colour", () => {
    for (const t of THEME_NAMES) {
      const table = kindTable(t);
      expect(table.map((r) => r.kind)).toEqual([...TRACE_KINDS]);
      expect(table.every((r) => /^[A-Z]{3}$/.test(r.tag) && /^#[0-9a-f]{6}$/.test(r.color))).toBe(true);
    }
    const tags = Object.values(KIND_STYLE).map((s) => s.tag);
    expect(new Set(tags).size).toBe(tags.length);
    // No style for a kind that does not exist.
    expect(Object.keys(KIND_STYLE).sort()).toEqual([...TRACE_KINDS].sort());
  });

  it("uses at most seven kind hue families, each with a colour in both themes", () => {
    const families = new Set(Object.values(KIND_STYLE).map((s) => s.family));
    expect(families.size).toBeLessThanOrEqual(7);
    for (const f of families) for (const t of THEME_NAMES) expect(COLORS[t].kind[f]).toMatch(/^#/);
  });

  it("agent colours are stable per ID", () => {
    expect(agentColorIndex("ugv-001")).toBe(agentColorIndex("ugv-001"));
    expect(new Set(["ugv-001", "ugv-002", "ugv-003", "uav-001", "uav-002"].map(agentColorIndex)).size).toBeGreaterThan(1);
  });

  it("the surface levels are told apart in both themes: the dock from the content wells, the wells from the panels, the panels from their bars and from hover", () => {
    for (const t of THEME_NAMES) {
      const c = COLORS[t];
      for (const [a, b] of [[c.dock, c.bg0], [c.bg0, c.bg1], [c.bg1, c.bg2], [c.bg1, c.bg3]] as const) {
        expect(contrastRatio(a, b), `${t}: ${a} on ${b}`).toBeGreaterThanOrEqual(1.04);
      }
    }
    // The dock is darker than the content wells, in both themes (ADR-0042 §3).
    for (const t of THEME_NAMES) expect(contrastRatio(COLORS[t].dock, COLORS[t].bg1)).toBeGreaterThan(contrastRatio(COLORS[t].bg0, COLORS[t].bg1));
  });

  it("the map's unknown area is told from the known one by its hatch (ADR-0043 section 4: a faint material, decorative, never the only signal), in both themes", () => {
    for (const t of THEME_NAMES) {
      const s = sceneTokens(t);
      expect(s.beliefHatch).toBe(COLORS[t].hatch);
      // Faint, but seen: the lines of the hatch tell from the surface they are drawn on.
      expect(contrastRatio(s.beliefHatch, COLORS[t].bg0), `${t}: hatch on the well`).toBeGreaterThanOrEqual(1.15);
      expect(contrastRatio(s.beliefHatch, COLORS[t].bg1), `${t}: hatch on the panel`).toBeGreaterThanOrEqual(1.15);
    }
    expect(CONTRAST_PAIRS.find((p) => p.fg === "hatch")?.role).toBe("decorative");
  });

  it("the shadow of floating windows and the scrim of dialogs exist in both themes", () => {
    for (const t of THEME_NAMES) {
      expect(COLORS[t].float).toMatch(/^0 \d+px \d+px rgba\(/);
      expect(COLORS[t].scrim).toMatch(/^rgba\(/);
    }
  });

  it("typography is the terminal scale of ADR-0042 §2: Mono for the chrome, Plex for prose only, 11 px at the least", () => {
    expect(FONT.mono.startsWith("'JetBrains Mono'")).toBe(true);
    expect(FONT.sans.startsWith("'IBM Plex Sans'")).toBe(true);
    expect(TYPE.title).toEqual({ size: 13, weight: 600, letterSpacingEm: 0.06 });
    expect(TYPE.body).toEqual({ size: 12.5, weight: 400 }); // long-session lists: 12.5 px (ADR-0043 §5); 11 px is for meta only
    expect(TYPE.label).toEqual({ size: 11, weight: 600, letterSpacingEm: 0.1 });
    expect(TYPE.clock).toEqual({ size: 22, weight: 600 });
    expect(TYPE.telemetry).toEqual({ size: 15, weight: 600 });
    expect(TYPE.prose).toEqual({ size: 12.5, weight: 400 });
    for (const [name, v] of Object.entries(TYPE)) expect(v.size, name).toBeGreaterThanOrEqual(TYPE_MIN_PX);
  });

  it("panels, windows and controls are square; only the flow editor's nodes are rounded", () => {
    expect(RADIUS_PX.control).toBe(0);
    expect(RADIUS_PX.node).toBe(8);
  });

  it("one glyph per meaning, from the Mono character set and never an emoji: failure ✕, warning ▲, paused ❚❚, replay ◷ (▶ is the running glyph)", () => {
    expect(GLYPH).toMatchObject({ fail: "✕", warn: "▲", paused: "❚❚", replay: "◷", running: "▶" });
    expect(GLYPH.replay).not.toBe(GLYPH.running);
    expect(STATE_GLYPH.alm).toBe(GLYPH.fail);
    expect(STATE_GLYPH.warn).toBe(GLYPH.warn);
    // Arrows, geometric shapes, dingbats, technical and box-drawing symbols (blocks the JetBrains Mono set covers), no character that presents as an emoji.
    const allowed = /^[←-⇿⌀-⏿─-◿✀-➿●○]+$/u;
    for (const g of [...Object.values(GLYPH), ...Object.values(STATE_GLYPH)]) {
      expect(g, g).toMatch(allowed);
      expect(g, g).not.toMatch(/\p{Emoji_Presentation}/u);
    }
  });
});
