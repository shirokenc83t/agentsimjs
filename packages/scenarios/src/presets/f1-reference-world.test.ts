import { StateHasher } from "@agentsim/core";
import { buildReferenceWorld, type GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import { parseScenario } from "../validate.ts";
import golden from "./f1-reference-world.golden.json";
import { f1ReferenceWorldRunConfig, f1ReferenceWorldScenario } from "./f1-reference-world.ts";

const gridHash = (g: GridSpace) => {
  const h = new StateHasher();
  g.hashInto(h);
  return h.hex();
};

describe("F1 reference world preset (1 km², 0.5 m)", () => {
  const doc = f1ReferenceWorldScenario();
  const loaded = loadScenario(doc);
  if (!loaded.ok) throw new Error(`${loaded.error.code}: ${loaded.error.message}`);

  it("loads to exactly the grid the benchmarks build with buildReferenceWorld()", () => {
    const bench = gridHash(buildReferenceWorld());
    expect(gridHash(loaded.value.grid)).toBe(bench);
    // The golden is shared with the lab's e2e test (the world loaded from the UI preset). Regenerate it with
    // UPDATE_GOLDEN=1 pnpm exec vitest run tools/golden, and explain the change.
    expect(golden.worldHash).toBe(bench);
  });

  it("is a valid exchange document with a rover and a scout, and a resolvable default run configuration", () => {
    expect(parseScenario(JSON.stringify(doc)).ok).toBe(true);
    expect(loaded.value.agents.map((a) => [a.id, a.key])).toEqual([["ugv-001", "rover"], ["uav-001", "scout"]]);
    expect(resolveRunConfig(f1ReferenceWorldRunConfig(2), { loaded: loaded.value, version: 2 }).ok).toBe(true);
  });

  it("is stable, so the lab stores a new version only when it changes", () => {
    expect(JSON.stringify(f1ReferenceWorldScenario())).toBe(JSON.stringify(doc));
  });
});
