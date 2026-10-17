import { StateHasher } from "@agentsim/core";
import type { GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import { f1DemoRunConfig, f1DemoScenario, f1EmptyDocument, paintF1Obstacles } from "./f1-demo.ts";

const gridHash = (g: GridSpace) => {
  const h = new StateHasher();
  g.hashInto(h);
  return h.hex();
};

describe("F1 demo scenario preset", () => {
  it("is a valid document whose encoded layers reproduce the reference world exactly", () => {
    const demo = loadScenario(f1DemoScenario());
    if (!demo.ok) throw new Error(demo.error.message);
    const ref = loadScenario(f1EmptyDocument("f1-reference", "F1 reference"));
    if (!ref.ok) throw new Error(ref.error.message);
    paintF1Obstacles(ref.value.grid);
    expect(gridHash(demo.value.grid)).toBe(gridHash(ref.value.grid));
    expect(demo.value.agents.map((a) => a.key)).toEqual(["rover", "low", "scout"]);
  });

  it("is stable (same document every time) so the lab stores a new version only when it changes", () => {
    expect(JSON.stringify(f1DemoScenario())).toBe(JSON.stringify(f1DemoScenario()));
  });

  it("its default run configuration resolves against a stored version", () => {
    const demo = loadScenario(f1DemoScenario());
    if (!demo.ok) throw new Error(demo.error.message);
    const r = resolveRunConfig(f1DemoRunConfig(3), { loaded: demo.value, version: 3 });
    expect(r.ok && r.value.timeMode).toBe("lockstep");
  });
});
