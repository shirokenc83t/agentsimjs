import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Rules of the terminal chrome (ADR-0042) that a stylesheet or a string can break without any test noticing: no text below 11 px, no coloured side bar on a
// row, no emoji (the glyph set is the JetBrains Mono character set).

const root = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", "coverage", "test-results", "results", ".vite", ".git", "playwright-report"]);

function files(dir: string, test: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) files(p, test, out);
    } else if (test.test(name)) out.push(p);
  }
  return out;
}
const lines = (f: string) => readFileSync(f, "utf8").split("\n");
const stylesheets = () => ["apps", "packages"].flatMap((d) => files(join(root, d), /\.css$/));

describe("chrome rules (ADR-0042)", () => {
  it("no text below 11 px in a stylesheet", () => {
    const found: string[] = [];
    for (const f of stylesheets()) {
      lines(f).forEach((l, i) => {
        for (const m of l.matchAll(/font-size:\s*([0-9.]+)px/g)) if (Number(m[1]) < 11) found.push(`${relative(root, f)}:${i + 1}: ${l.trim().slice(0, 90)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("no coloured side bar on a row: selection is an accent tint with a 1 px outline", () => {
    const found: string[] = [];
    for (const f of stylesheets()) {
      lines(f).forEach((l, i) => {
        if (/box-shadow:\s*inset\s+\d+px\s+0\s+0/.test(l)) found.push(`${relative(root, f)}:${i + 1}: ${l.trim().slice(0, 90)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("no emoji in the interface's source (glyphs come from the Mono set: ✕ ▲ ❚❚ ◷ …)", () => {
    const found: string[] = [];
    const sources = ["apps/lab/src", "packages/ui/src"].flatMap((d) => files(join(root, d), /\.(ts|tsx|css)$/)).filter((f) => !/\.test\./.test(f));
    expect(sources.length).toBeGreaterThan(100);
    for (const f of sources) {
      lines(f).forEach((l, i) => {
        if (/\p{Emoji_Presentation}|⚠|ℹ/u.test(l)) found.push(`${relative(root, f)}:${i + 1}: ${l.trim().slice(0, 90)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
