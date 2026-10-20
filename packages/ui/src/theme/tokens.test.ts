import { TRACE_KINDS } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { agentColorIndex, colorAt, COLORS, CONTRAST_MIN, CONTRAST_PAIRS, contrastRatio, KIND_STYLE, kindTable, sceneTokens, THEME_NAMES } from "./tokens.ts";

/** Every token path of a theme, flattened (`kind.violet`, `agent.3`, …). */
function paths(o: unknown, prefix = ""): string[] {
  if (typeof o === "string") return [prefix];
  if (Array.isArray(o)) return o.flatMap((v, i) => paths(v, `${prefix}.${i}`));
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

describe("design tokens (ADR-0032)", () => {
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
      expect(contrastRatio(s.cellBlocked, s.cellFree), `${t}: blocked cells on free cells`).toBeGreaterThanOrEqual(2);
    }
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
});
