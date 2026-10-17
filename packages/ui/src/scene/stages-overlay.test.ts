import { describe, expect, it } from "vitest";
import { contrastRatio, sceneTokens, THEME_NAMES } from "../theme/tokens.ts";
import { MAX_STAGE_LEGS, StagesOverlay, dashSegments, type StageLine } from "./stages-overlay.ts";

const line = (role: StageLine["role"], pts: number[]): StageLine => ({ role, points: Float32Array.from(pts) });
const tokens = sceneTokens("dark");

describe("dashSegments: the coarse path drawn dashed from plain segments (a dashed line material restarts per segment)", () => {
  it("covers about 60 % of the path length, in dashes along it, never off it", () => {
    const out = new Float32Array(2000);
    const n = dashSegments(Float32Array.from([0, 0, 100, 0]), out);
    expect(n).toBeGreaterThan(10);
    let on = 0;
    for (let k = 0; k < n; k++) {
      const x0 = out[k * 4] ?? 0;
      const x1 = out[k * 4 + 2] ?? 0;
      expect(out[k * 4 + 1]).toBe(0);
      expect(x1).toBeGreaterThan(x0);
      on += x1 - x0;
    }
    expect(on / 100).toBeGreaterThan(0.5);
    expect(on / 100).toBeLessThan(0.7);
  });

  it("follows the bends of a path and stops at the buffer's end instead of overflowing", () => {
    const small = new Float32Array(4 * 5);
    expect(dashSegments(Float32Array.from([0, 0, 50, 0, 50, 50, 0, 50, 0, 0]), small)).toBe(5);
  });

  it("an empty or one-point path draws nothing", () => {
    expect(dashSegments(Float32Array.from([1, 1]), new Float32Array(40))).toBe(0);
    expect(dashSegments(new Float32Array(0), new Float32Array(40))).toBe(0);
  });
});

describe("StagesOverlay: preallocated buffers, tokens only (F2b M4)", () => {
  it("draws the coarse path dashed and each leg as a solid line, with a joint between legs", () => {
    const o = new StagesOverlay(tokens, "run");
    o.setStages([line("coarse", [0, 0, 60, 60]), line("leg", [0, 0, 20, 20, 30, 30]), line("leg", [30, 30, 60, 60])]);
    const c = o.counts();
    expect(c.coarseDashes).toBeGreaterThan(5);
    expect(c.legs).toBe(2);
    expect(c.legSegments).toBe(3);
    expect(c.joints).toBe(1); // between the two legs; the first leg's start and the last leg's end are not joints
    expect(c.labels).toBe(1);
  });

  it("the joint sits where leg k ends and leg k+1 begins, and is numbered", () => {
    const o = new StagesOverlay(tokens, "run");
    o.setStages([line("leg", [0, 0, 10, 0]), line("leg", [10, 0, 10, 10]), line("leg", [10, 10, 0, 10])]);
    expect(o.jointNumbers()).toEqual([1, 2]);
    const p = o.jointPositions();
    expect(p).toEqual([[10, 0], [10, 10]]);
  });

  it("alternates the two leg tones so neighbouring legs differ without relying on colour alone (joints are numbered)", () => {
    const o = new StagesOverlay(tokens, "run");
    o.setStages([line("leg", [0, 0, 1, 0]), line("leg", [1, 0, 2, 0]), line("leg", [2, 0, 3, 0]), line("leg", [3, 0, 4, 0])]);
    expect(o.legTonesInUse()).toEqual({ even: 2, odd: 2 });
  });

  it("never allocates beyond its caps: too many legs, too many points, too many joints are cut, not grown", () => {
    const o = new StagesOverlay(tokens, "run");
    const legs = Array.from({ length: MAX_STAGE_LEGS + 30 }, (_, k) => line("leg", Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? k + i / 100 : i / 50))));
    o.setStages(legs);
    const c = o.counts();
    expect(c.legs).toBeLessThanOrEqual(MAX_STAGE_LEGS);
    expect(c.legSegments).toBeLessThanOrEqual(MAX_STAGE_LEGS * 129);
    expect(c.labels).toBeLessThanOrEqual(24);
    const before = o.bufferBytes();
    o.setStages(legs);
    o.setStages([line("leg", [0, 0, 1, 1])]);
    expect(o.bufferBytes()).toBe(before);
  });

  it("clears with undefined or an empty list, and applies a theme without redrawing", () => {
    const o = new StagesOverlay(tokens, "run");
    o.setStages([line("leg", [0, 0, 5, 5])]);
    o.setStages(undefined);
    expect(o.counts()).toMatchObject({ coarseDashes: 0, legs: 0, legSegments: 0, joints: 0, labels: 0 });
    o.setStages([line("leg", [0, 0, 5, 5])]);
    o.applyTheme(sceneTokens("light"));
    expect(o.counts().legs).toBe(1);
  });

  it("uses the sim frame: x east, y north becomes Three's x, -z, above the ground and the paths", () => {
    const o = new StagesOverlay(tokens, "run");
    o.setStages([line("leg", [3, 4, 5, 6])]);
    const pos = o.legPositions();
    expect(pos.slice(0, 6)).toEqual([3, expect.closeTo(0.07, 5), -4, 5, expect.closeTo(0.07, 5), -6]);
  });

  it("a sandbox overlay is its own instance with a tone of its own and no alternation", () => {
    const o = new StagesOverlay(tokens, "sandbox");
    o.setStages([line("leg", [0, 0, 1, 0]), line("leg", [1, 0, 2, 0])]);
    expect(o.legTonesInUse()).toEqual({ even: 2, odd: 0 });
    expect(o.kind).toBe("sandbox");
  });

  it("disposes its geometry and materials", () => {
    const o = new StagesOverlay(tokens, "run");
    expect(() => o.dispose()).not.toThrow();
  });
});

describe("stage tokens (ADR-0032)", () => {
  it("are four distinct colours in each theme, readable on the ground (3:1, graphical objects)", () => {
    for (const theme of THEME_NAMES) {
      const t = sceneTokens(theme);
      const tones = [t.stageCoarse, t.stageLeg, t.stageLegAlt, t.stageSandbox];
      expect(new Set(tones).size).toBe(4);
      for (const c of tones) expect(contrastRatio(c, t.ground), `${theme} ${c} on ground`).toBeGreaterThanOrEqual(3);
    }
  });
});
