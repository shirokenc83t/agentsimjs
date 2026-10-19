import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The repository is public: the identifiers the two working sessions use to coordinate (task, decision and gate numbers) belong to the coordination files, not to
// code, comments or tests. The ADR references and the phase names are what comments cite. A comment that names a task goes stale and says nothing to a reader.
// The pattern is built from parts so that this file does not match itself.
const KINDS = ["T", "D", "G"].map((k) => `${k}-0[0-9]{2}`);
const PATTERN = new RegExp(`\\b(${KINDS.join("|")}|D-00[0-9]|G-00[0-9])\\b`);
const SKIP = new Set(["node_modules", "dist", "coverage", "test-results", "results", ".vite", ".git", "playwright-report"]);
const TEXT = /\.(ts|tsx|mjs|js|css|sql|md|json)$/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) sources(p, out);
    } else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

describe("coordination identifiers stay out of the public code", () => {
  it("no task, decision or gate number in packages, apps, tools or bench", () => {
    const root = join(import.meta.dirname, "..", "..");
    const files = ["packages", "apps", "tools", "bench"].flatMap((d) => sources(join(root, d)));
    expect(files.length).toBeGreaterThan(200);
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (PATTERN.test(line)) found.push(`${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(found, "name the ADR or the phase, not the task").toEqual([]);
  });
});
