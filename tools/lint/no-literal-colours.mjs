// No literal colours in CSS outside packages/ui/src/theme (ADR-0032 §1). Part of `pnpm lint`; the .ts/.tsx
// half of the rule is an ESLint no-restricted-syntax selector set (eslint.config.js).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "test-results", "playwright-report"]);
const EXEMPT = (rel) => rel.startsWith(["packages", "ui", "src", "theme", ""].join(sep));
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
    } else if (name.endsWith(".css")) {
      const rel = relative(process.cwd(), p);
      if (EXEMPT(rel)) continue;
      readFileSync(p, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (COLOUR.test(line.replace(/\/\*.*?\*\//g, ""))) problems.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  }
}
for (const r of ROOTS) walk(r);
if (problems.length > 0) {
  console.error("Literal colours in CSS — use token variables from packages/ui/src/theme (ADR-0032 §1):");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
