import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderThemeCss } from "../../packages/ui/src/theme/css.ts";

const dir = resolve("packages/ui/src/theme");
const generated = () => renderThemeCss(readFileSync(resolve(dir, "base.css"), "utf8"));

describe("generated theme.css (ADR-0032 §1)", () => {
  it.runIf(!!process.env["UPDATE_THEME_CSS"])("regenerates theme.css", () => {
    writeFileSync(resolve(dir, "theme.css"), generated());
  });

  it("theme.css is up to date with tokens.ts and base.css", () => {
    expect(readFileSync(resolve(dir, "theme.css"), "utf8").replace(/\r\n/g, "\n")).toBe(generated().replace(/\r\n/g, "\n"));
  });

  it("defines the same colour variables for dark and light", () => {
    const css = generated();
    const vars = (sel: string) => {
      const block = css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
      return [...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).sort();
    };
    expect(vars(':root[data-theme="light"]')).toEqual(vars(':root, :root[data-theme="dark"]'));
  });

  it("base.css has no literal colours", () => {
    const base = readFileSync(resolve(dir, "base.css"), "utf8");
    expect(base).not.toMatch(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab)\(/);
  });
});
