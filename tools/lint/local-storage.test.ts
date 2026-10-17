import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOT_SETTINGS } from "../../packages/ui/src/boot-settings.ts";

// ADR-0032 addition (2026-10-04): localStorage holds only a closed list of boot settings, needed before
// storage opens. Only packages/ui/src/boot-settings.ts may touch it (or sessionStorage); its keys are that list.
const ALLOWED = ["packages", "ui", "src", "boot-settings.ts"].join(sep);
const SKIP = new Set(["node_modules", "dist", "coverage", "e2e"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) sources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|bench)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Code without comments, so documentation may name localStorage. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("boot settings: the only localStorage keys (ADR-0032)", () => {
  it("no module except boot-settings.ts reads or writes localStorage or sessionStorage", () => {
    const offenders = [...sources("apps"), ...sources("packages")]
      .filter((f) => relative(process.cwd(), f) !== ALLOWED)
      .filter((f) => /\b(localStorage|sessionStorage)\b/.test(code(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("boot-settings.ts uses only the keys of its closed, documented list", () => {
    const text = code(readFileSync(ALLOWED, "utf8"));
    // Every storage call goes through BOOT_SETTINGS[name].key: no literal key is passed.
    expect(text).not.toMatch(/(getItem|setItem|removeItem)\(\s*["'`]/);
    expect(Object.keys(BOOT_SETTINGS).sort()).toEqual(["storage.quotaThreshold", "ui.theme"]);
    for (const s of Object.values(BOOT_SETTINGS)) {
      expect(s.key).toMatch(/^agentsim\./);
      expect(s.why.length).toBeGreaterThan(20);
    }
  });
});
