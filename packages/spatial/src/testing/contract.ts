import { describe, expect, it } from "vitest";
import { newRayHit } from "../raycast.ts";
import type { SpatialModel } from "../spatial-model.ts";

/**
 * Shared contract suite for SpatialModel implementations (CLAUDE.md: contract tests per port).
 * Each implementation builds the same reference world (metres):
 * - 64 m × 64 m, origin at (0, 0);
 * - a wall along x ∈ [30, 31) for y ∈ [0, 40) (ground obstacle without height info → blocks air too);
 * - a 10 m tall building on x ∈ [10, 14), y ∈ [50, 54);
 * - a no-fly volume over x ∈ [40, 50), y ∈ [40, 50) between 0 and 30 m;
 * - altitude limits [0, 60] m; no geofence.
 */
export interface SpatialContractFixture {
  readonly model: SpatialModel;
  /** Adds an obstacle cell at (x, y) through the implementation's edit API. */
  readonly blockAt: (x: number, y: number) => void;
}

const p = (x: number, y: number, z = 0) => ({ x, y, z });

export function describeSpatialModelContract(name: string, create: () => SpatialContractFixture): void {
  describe(`spatial model contract: ${name}`, () => {
    it("reports free and blocked space for ground vehicles", () => {
      const { model } = create();
      expect(model.isFree(p(5, 5), "ground")).toBe(true);
      expect(model.isFree(p(30.5, 10), "ground")).toBe(false);
      expect(model.isFree(p(12, 52), "ground")).toBe(false);
      expect(model.isFree(p(-1, 5), "ground")).toBe(false);
      expect(model.isFree(p(64.5, 5), "ground")).toBe(false);
    });

    it("models 2.5D airspace: heights, no-fly volumes, altitude limits", () => {
      const { model } = create();
      expect(model.isFree(p(12, 52, 5), "air")).toBe(false); // inside the building
      expect(model.isFree(p(12, 52, 11), "air")).toBe(true); // above it
      expect(model.isFree(p(12, 52, 11), "air", 2)).toBe(false); // clearance
      expect(model.isFree(p(30.5, 10, 50), "air")).toBe(false); // wall without height: unlimited
      expect(model.isFree(p(45, 45, 20), "air")).toBe(false); // no-fly band
      expect(model.isFree(p(45, 45, 35), "air")).toBe(true); // above the band
      expect(model.isFree(p(5, 5, 61), "air")).toBe(false); // above the ceiling
    });

    it("raycasts to the first blocked cell", () => {
      const { model } = create();
      const hit = model.raycast(p(20.25, 10.25), p(1, 0, 0), 50, newRayHit());
      expect(hit.hit).toBe(true);
      expect(hit.distanceM).toBeCloseTo(30 - 20.25, 9);
      const miss = model.raycast(p(20.25, 45.25), p(1, 0, 0), 20, newRayHit());
      expect(miss.hit).toBe(false);
      expect(miss.distanceM).toBe(20);
    });

    it("returns neighbors sorted by id regardless of insertion order", () => {
      const { model } = create();
      for (const [id, x, y] of [["uav-003", 5, 5], ["ugv-001", 6, 5], ["uav-001", 5, 6], ["uav-002", 40, 40]] as const) model.setEntityPosition(id, p(x, y));
      expect(model.neighbors(p(5, 5), 2)).toEqual(["uav-001", "uav-003", "ugv-001"]);
      expect(model.neighbors(p(5, 5), 2, "uav-003")).toEqual(["uav-001", "ugv-001"]);
      model.setEntityPosition("uav-001", p(60, 60));
      expect(model.neighbors(p(5, 5), 2)).toEqual(["uav-003", "ugv-001"]);
      model.removeEntity("ugv-001");
      expect(model.neighbors(p(5, 5), 2)).toEqual(["uav-003"]);
    });

    it("bumps its version on every ground-truth edit", () => {
      const f = create();
      const v0 = f.model.version;
      f.blockAt(2.25, 2.25);
      expect(f.model.version).toBeGreaterThan(v0);
      expect(f.model.isFree(p(2.25, 2.25), "ground")).toBe(false);
    });
  });
}
