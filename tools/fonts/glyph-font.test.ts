import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARK_LEGEND } from "../../apps/lab/src/panels/debug/marks.ts";
import { GLYPH } from "../../packages/ui/src/theme/tokens.ts";
// @ts-expect-error the generator is plain JavaScript
import { buildGlyphFont, GLYPH_CODEPOINTS } from "./make-glyph-font.mjs";

const committed = new Uint8Array(readFileSync(resolve("apps/lab/public/fonts/agentsim-glyphs.ttf")));
const be16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const be32 = (b: Uint8Array, o: number) => (be16(b, o) * 65536 + be16(b, o + 2)) >>> 0;

function tables(b: Uint8Array): Map<string, { offset: number; length: number; sum: number }> {
  const out = new Map<string, { offset: number; length: number; sum: number }>();
  const n = be16(b, 4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    out.set(String.fromCharCode(...b.slice(at, at + 4)), { sum: be32(b, at + 4), offset: be32(b, at + 8), length: be32(b, at + 12) });
  }
  return out;
}

/** The code points the font's cmap (format 4) maps to a glyph. */
function mapped(b: Uint8Array): number[] {
  const t = tables(b).get("cmap");
  if (!t) throw new Error("no cmap");
  const sub = t.offset + be32(b, t.offset + 8);
  const segX2 = be16(b, sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const out: number[] = [];
  for (let s = 0; s < segX2 / 2; s++) {
    const end = be16(b, ends + s * 2);
    const start = be16(b, starts + s * 2);
    if (end === 0xffff) continue;
    for (let c = start; c <= end; c++) out.push(c);
  }
  return out;
}

describe("the AgentSim Glyphs font (ADR-0042 §4: no symbol falls back to a system font)", () => {
  it("the committed file is what the generator makes", () => {
    expect(committed).toEqual(buildGlyphFont());
  });

  it("is a well-formed TrueType file: the tables, their checksums, the head magic", () => {
    const t = tables(committed);
    expect([...t.keys()].sort()).toEqual(["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]);
    const head = t.get("head");
    expect(be32(committed, (head?.offset ?? 0) + 12)).toBe(0x5f0f3cf5);
    for (const [tag, e] of t) {
      if (tag === "head") continue;
      let sum = 0;
      const bytes = committed.slice(e.offset, e.offset + Math.ceil(e.length / 4) * 4);
      for (let i = 0; i < bytes.length; i += 4) sum = (sum + be32(bytes, i)) >>> 0;
      expect(sum, tag).toBe(e.sum);
    }
    // The whole file sums to the magic number once the head's adjustment is in.
    let total = 0;
    for (let i = 0; i < committed.length; i += 4) total = (total + be32(committed, i)) >>> 0;
    expect(total).toBe(0xb1b0afba);
  });

  it("maps every symbol of the glyph table, of the timeline's marks and of the window chrome", () => {
    const have = new Set(mapped(committed));
    expect([...have].sort()).toEqual([...GLYPH_CODEPOINTS].sort());
    const wanted = new Set<number>();
    for (const g of Object.values(GLYPH)) for (const ch of g) wanted.add(ch.codePointAt(0) as number);
    for (const m of MARK_LEGEND) wanted.add(m.glyph.codePointAt(0) as number);
    for (const code of wanted) expect(have.has(code), `U+${code.toString(16).toUpperCase()}`).toBe(true);
  });

  it("every glyph is 600 units wide, like JetBrains Mono, and none is empty", () => {
    const t = tables(committed);
    const hmtx = t.get("hmtx");
    const maxp = t.get("maxp");
    const n = be16(committed, (maxp?.offset ?? 0) + 4);
    expect(n).toBe(GLYPH_CODEPOINTS.length + 1);
    for (let g = 0; g < n; g++) expect(be16(committed, (hmtx?.offset ?? 0) + g * 4)).toBe(600);
    const loca = t.get("loca");
    for (let g = 1; g < n; g++) expect(be32(committed, (loca?.offset ?? 0) + (g + 1) * 4) - be32(committed, (loca?.offset ?? 0) + g * 4), `glyph ${g}`).toBeGreaterThan(0);
  });
});
