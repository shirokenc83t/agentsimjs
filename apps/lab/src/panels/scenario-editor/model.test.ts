import { canonicalJson, f1DemoScenario, parseScenarioValue } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { agentIdsOf, ScenarioDraft, type Brush } from "./model.ts";

const blank = () => ScenarioDraft.blank({ id: "test-world", name: "Test world", defaultSeed: 3, sizeX: 64, sizeY: 48, resolutionM: 0.5, chunkSize: 16 });
const wall: Brush = { layer: "occupancy", value: 1, radiusCells: 0 };

describe("scenario editor model (F1 e7)", () => {
  it("a blank draft encodes to a valid, minimal document", () => {
    const d = blank();
    const v = d.validate();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.document.world).toMatchObject({ resolutionM: 0.5, sizeCells: { x: 64, y: 48 }, chunkSize: 16, layers: {} });
    expect(v.document.agents).toEqual([]);
  });

  it("the brush paints a disc of cells around the pointer, clamped to the grid and the layer range", () => {
    const d = blank();
    expect(d.beginStroke(10.2, 10.2, { layer: "terrainCost", value: 999, radiusCells: 2 })).toBe(13); // r=2 disc
    d.endStroke();
    expect(d.grid.terrainAt(20, 20)).toBe(255);
    expect(d.grid.terrainAt(22, 20)).toBe(255);
    expect(d.grid.terrainAt(22, 22)).toBe(10); // outside the disc
    // At the corner only the in-bounds quarter is painted.
    expect(d.beginStroke(0.1, 0.1, { layer: "heightDm", value: 50, radiusCells: 1 })).toBe(3);
    d.endStroke();
  });

  it("a fast drag leaves no gaps: discs are stamped along the segment", () => {
    const d = blank();
    d.beginStroke(1.25, 5.25, wall);
    d.extendStroke(30.25, 5.25, wall); // one move event across 58 cells
    d.endStroke();
    for (let i = 2; i <= 60; i++) expect(d.grid.isBlocked(i, 10), `cell ${i}`).toBe(true);
    expect(d.grid.isBlocked(61, 10)).toBe(false);
  });

  it("undo reverts one whole stroke at a time, restoring the previous values", () => {
    const d = blank();
    d.beginStroke(5, 5, { layer: "terrainCost", value: 40, radiusCells: 1 });
    d.endStroke();
    d.beginStroke(5, 5, { layer: "terrainCost", value: 200, radiusCells: 3 });
    d.extendStroke(8, 5, { layer: "terrainCost", value: 200, radiusCells: 3 });
    d.endStroke();
    expect(d.grid.terrainAt(10, 10)).toBe(200);
    expect(d.undo()).toBe(true);
    expect(d.grid.terrainAt(10, 10)).toBe(40);
    expect(d.grid.terrainAt(14, 10)).toBe(10);
    expect(d.undo()).toBe(true);
    expect(d.grid.terrainAt(10, 10)).toBe(10);
    expect(d.undo()).toBe(false);
    // A stroke that changed nothing is not an undo step.
    d.beginStroke(5, 5, { layer: "terrainCost", value: 10, radiusCells: 1 });
    d.endStroke();
    expect(d.canUndo).toBe(false);
  });

  it("zones and agents get fresh IDs and keys; agent IDs follow the loader's rule", () => {
    const d = blank();
    expect(d.addRectZone("base", 4, 4, 1, 1)).toEqual({ id: "base-1", kind: "base", rect: { x0: 1, y0: 1, x1: 4, y1: 4 } });
    expect(d.addRectZone("noFly", 10, 10, 12, 12).id).toBe("nofly-1");
    const a = d.addAgent("ugv", 8.123, 9.876);
    d.addAgent("uav", 12, 12);
    d.addAgent("ugv", 14, 3);
    expect(d.agents[a]).toEqual({ kind: "ugv", key: "ugv-1", start: { xM: 8.12, yM: 9.88 }, base: { xM: 2.5, yM: 2.5 } });
    expect(d.agents.map((x) => x.key)).toEqual(["ugv-1", "uav-1", "ugv-2"]);
    expect(agentIdsOf(d.agents)).toEqual(["ugv-001", "uav-001", "ugv-002"]);
    expect(d.agentNear(12.3, 12.2, 1)).toBe(1);
    expect(d.agentNear(20, 20, 1)).toBe(-1);
    d.moveAgent(0, 3, 3);
    d.deleteAgent(1);
    expect(d.agents.map((x) => [x.key, x.start])).toEqual([["ugv-1", { xM: 3, yM: 3 }], ["ugv-2", { xM: 14, yM: 3 }]]);
    expect(d.validate().ok).toBe(true);
  });

  it("validation reports the loader's stable codes (an agent placed on a wall)", () => {
    const d = blank();
    d.beginStroke(5.1, 5.1, { ...wall, radiusCells: 2 });
    d.endStroke();
    d.addAgent("ugv", 5.1, 5.1);
    const v = d.validate();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatchObject({ code: "agent_start_blocked", path: "/agents/0/start" });
  });

  it("round trip: a stored document opened in the editor and saved unchanged is the same document", () => {
    const demo = f1DemoScenario();
    const r = ScenarioDraft.fromDocument(demo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value.toDocument();
    expect(canonicalJson(out)).toBe(canonicalJson(demo));
    expect(parseScenarioValue(JSON.parse(JSON.stringify(out))).ok).toBe(true);
  });
});
