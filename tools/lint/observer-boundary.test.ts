import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Observer data never reaches a mind (ADR-0035 addition, item 4; ADR-0043 section 7: the swarm knowledge band is derived from the recorded belief-vs-truth samples). The samples and the
// observer's metrics are written by the observer and read by panels; the world, the actions, the minds and the planning code do not know them. The dynamic half of the rule (the observer's
// reports change no hash, trace or decision request) is pinned by packages/scenarios/src/assemble/belief-boundary.test.ts and belief-vs-truth.test.ts.

const root = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", "coverage"]);
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return SKIP.has(n) ? [] : sources(p);
    return /\.ts$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe("observer data and the minds (ADR-0043 section 7)", () => {
  it("nothing in the world, the actions, the minds or the planning code reads the observer's samples or its metrics", () => {
    const mindSide = ["packages/core/src", "packages/algorithms/src"].flatMap((d) => sources(join(root, d)));
    expect(mindSide.length).toBeGreaterThan(50);
    const readers = mindSide.filter((f) => /belief-vs-truth|belief\.unknownPct|belief\.falseFreePct|knowledge-band|knowledgeBand/.test(readFileSync(f, "utf8")));
    expect(readers).toEqual([]);
  });

  it("the band's own module imports only the trace types: it cannot reach a mind, the world or the ground truth", () => {
    const text = readFileSync(join(root, "apps", "lab", "src", "shell", "knowledge-band.ts"), "utf8");
    const imports = [...text.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@agentsim/trace"]);
  });
});
