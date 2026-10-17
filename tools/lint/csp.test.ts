import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR-0032 §10: MUI/emotion need style 'unsafe-inline' only; scripts never get 'unsafe-inline' or
// 'unsafe-eval' (the initial theme is applied from an imported module, not an inline script).
describe("lab CSP (ADR-0018, ADR-0021, ADR-0032 §10)", () => {
  // Comments are stripped: they may name the forbidden sources to explain the rule.
  const config = readFileSync("apps/lab/vite.config.ts", "utf8").replace(/\/\/.*$/gm, "");
  const scriptSrc = /`script-src ([^`]*)`/.exec(config)?.[1] ?? "";

  it("has a script-src directive", () => {
    expect(scriptSrc).toContain("'self'");
  });

  it("never allows 'unsafe-eval' or inline scripts", () => {
    expect(config).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("index.html has no inline script", () => {
    const html = readFileSync("apps/lab/index.html", "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
