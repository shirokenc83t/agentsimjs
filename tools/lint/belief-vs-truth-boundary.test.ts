import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ADR-0005 addition (2026-10-11): beliefVsTruth compares an agent's beliefs with the ground truth and is observer-side
// only. Nothing a mind can see may import it: the allowed list is the module itself, its export and the one place that
// builds it for a run (`createRun`, which keeps it out of the world, the brains and the mind view). The channel table of the
// trace package also names the record's op (`belief-vs-truth`, ADR-0035 addition of 2026-10-17, item 1): a string, not the module. The swarm knowledge band of the player (ADR-0043 section 7)
// reads the recorded samples by that op, in two files of the lab's shell that import nothing of a mind (observer-boundary.test.ts pins what they import and that nothing mind-side names them).
const ALLOWED = new Set(
  [
    ["packages", "scenarios", "src", "assemble", "belief-vs-truth.ts"],
    ["packages", "scenarios", "src", "assemble", "index.ts"],
    ["packages", "scenarios", "src", "assemble", "run.ts"],
    ["packages", "trace", "src", "channels.ts"],
    ["apps", "lab", "src", "shell", "knowledge-band.ts"],
    ["apps", "lab", "src", "shell", "use-knowledge.ts"],
  ].map((p) => p.join(sep)),
);
const SKIP = new Set(["node_modules", "dist", "coverage", "e2e", "bench"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) sources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|bench)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("beliefVsTruth stays on the observer side (ADR-0005 addition of 2026-10-11)", () => {
  it("only its module, its export and createRun refer to it", () => {
    const root = join(import.meta.dirname, "..", "..");
    const files = [...sources(join(root, "packages")), ...sources(join(root, "apps"))];
    expect(files.length).toBeGreaterThan(100); // the scan finds the sources
    const users = files.filter((f) => /belief-vs-truth|BeliefVsTruth/.test(code(readFileSync(f, "utf8")))).map((f) => relative(root, f));
    expect(users.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(users.length).toBe(ALLOWED.size); // and each of them still does (the allow list is not stale)
  });

  it("the decision request and mind view types do not mention the metrics", () => {
    const root = join(import.meta.dirname, "..", "..");
    for (const f of [["packages", "core", "src", "world", "brain.ts"], ["packages", "core", "src", "world", "mind-view.ts"]]) {
      expect(code(readFileSync(join(root, ...f), "utf8"))).not.toMatch(/phantom|falseFree|reachableCells|heightViolations|beliefVsTruth/i);
    }
  });
});
