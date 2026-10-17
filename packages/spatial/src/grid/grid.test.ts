import { Rng, StateHasher } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceGrid } from "../testing/reference-grid.ts";
import { ChunkedLayer } from "./chunked-layer.ts";
import { GridSpace, OCCUPANCY_BLOCKED, TERRAIN_NOMINAL } from "./grid-space.ts";
import { ALL_BLOCKED, ANY_BLOCKED } from "./pyramid.ts";

describe("ChunkedLayer", () => {
  it("keeps uniform chunks unmaterialized until a different value is written", () => {
    const l = new ChunkedLayer(4, 4, 8, 10, Uint8Array);
    expect(l.get(5, 5)).toBe(10);
    expect(l.set(5, 5, 10)).toBe(false);
    expect(l.materializedBytes()).toBe(0);
    expect(l.set(5, 5, 3)).toBe(true);
    expect(l.materializedBytes()).toBe(64);
    expect(l.get(5, 5)).toBe(3);
    expect(l.get(6, 5)).toBe(10);
    l.setChunk(0, 0, new Array(64).fill(7));
    expect(l.uniformValue(0, 0)).toBe(7);
    expect(l.materializedBytes()).toBe(0);
  });

  it("caches chunk hashes and invalidates them on change; equal content hashes equally", () => {
    const a = new ChunkedLayer(2, 2, 8, 0, Uint16Array);
    const b = new ChunkedLayer(2, 2, 8, 0, Uint16Array);
    a.set(1, 1, 500);
    b.setChunk(0, 0, Array.from({ length: 64 }, (_, k) => (k === 9 ? 500 : 0)));
    expect(a.chunkHash(0, 0)).toBe(b.chunkHash(0, 0));
    const before = a.chunkHash(0, 0);
    a.set(1, 1, 501);
    expect(a.chunkHash(0, 0)).not.toBe(before);
  });
});

describe("GridSpace", () => {
  it("validates its spec", () => {
    expect(() => new GridSpace({ sizeX: 0, sizeY: 10, resolutionM: 1 })).toThrow(RangeError);
    expect(() => new GridSpace({ sizeX: 9000, sizeY: 10, resolutionM: 1 })).toThrow(RangeError);
    expect(() => new GridSpace({ sizeX: 10, sizeY: 10, resolutionM: 0 })).toThrow(RangeError);
    expect(() => new GridSpace({ sizeX: 10, sizeY: 10, resolutionM: 1, chunkSize: 48 })).toThrow(RangeError);
  });

  it("tracks changed chunks per version for multiple consumers", () => {
    const g = new GridSpace({ sizeX: 256, sizeY: 128, resolutionM: 0.5, chunkSize: 64 });
    const v0 = g.version;
    g.setCell("occupancy", 70, 3, OCCUPANCY_BLOCKED); // chunk (1, 0)
    const v1 = g.version;
    g.setCell("terrainCost", 200, 100, 30); // chunk (3, 1)
    g.setCell("terrainCost", 200, 100, 30); // no change: no new version
    expect(g.version).toBe(v1 + 1);
    expect(g.chunksChangedSince(v0)).toEqual([1, 7]);
    expect(g.chunksChangedSince(v1)).toEqual([7]);
    expect(g.terrainAt(200, 100)).toBe(30);
    expect(g.terrainAt(0, 0)).toBe(TERRAIN_NOMINAL);
  });

  it("keeps the pyramid in sync with edits and matches brute force", () => {
    const rng = Rng.fromSeed(5).derive("pyramid");
    const g = new GridSpace({ sizeX: 200, sizeY: 136, resolutionM: 1, chunkSize: 64 });
    for (let n = 0; n < 400; n++) g.setCell("occupancy", rng.intRange(0, 199), rng.intRange(0, 135), OCCUPANCY_BLOCKED);
    const check = () => {
      const pyr = g.pyramid();
      for (let q = 0; q < 300; q++) {
        const i0 = rng.intRange(0, 199);
        const j0 = rng.intRange(0, 135);
        const i1 = Math.min(200, i0 + rng.intRange(1, 80));
        const j1 = Math.min(136, j0 + rng.intRange(1, 80));
        let brute = false;
        for (let j = j0; j < j1 && !brute; j++) for (let i = i0; i < i1; i++) if (g.isBlocked(i, j)) brute = true;
        expect(pyr.anyBlockedIn(i0, j0, i1, j1)).toBe(brute);
      }
    };
    check();
    g.fillChunk("occupancy", 1, 1, OCCUPANCY_BLOCKED); // a fully blocked chunk
    expect(g.pyramid().flags(6, 1, 1)).toBe(ANY_BLOCKED | ALL_BLOCKED);
    check();
    g.fillChunk("occupancy", 1, 1, 0);
    check();
  });

  it("hashes ground truth canonically: same content, same hash, regardless of edit history", () => {
    const a = buildReferenceGrid();
    const b = buildReferenceGrid();
    b.setCell("occupancy", 5, 5, OCCUPANCY_BLOCKED);
    b.setCell("occupancy", 5, 5, 0); // edited and reverted: content equal again
    const ha = new StateHasher();
    const hb = new StateHasher();
    a.hashInto(ha);
    b.hashInto(hb);
    expect(ha.hex()).toBe(hb.hex());
    b.setCell("heightDm", 0, 0, 1);
    const hb2 = new StateHasher();
    b.hashInto(hb2);
    expect(hb2.hex()).not.toBe(ha.hex());
  });

  it("treats occupied cells with unknown height as unlimited for aerial vehicles unless a default is set", () => {
    const mk = (defaultObstacleHeightM?: number) => {
      const g = new GridSpace({
        sizeX: 32,
        sizeY: 32,
        resolutionM: 1,
        altitudeLimitsM: { min: 0, max: 100 },
        ...(defaultObstacleHeightM === undefined ? {} : { defaultObstacleHeightM }),
      });
      g.setCell("occupancy", 5, 5, OCCUPANCY_BLOCKED); // unknown height
      g.setCell("occupancy", 10, 10, OCCUPANCY_BLOCKED);
      g.setCell("heightDm", 10, 10, 150); // 15 m building
      return g;
    };
    const unlimited = mk();
    expect(unlimited.hasUnknownObstacleHeight(5, 5)).toBe(true);
    expect(unlimited.hasUnknownObstacleHeight(10, 10)).toBe(false);
    expect(unlimited.obstacleTopM(5, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(unlimited.isFreeForAir(5.5, 5.5, 99)).toBe(false); // no altitude clears it
    expect(unlimited.isFreeForAir(10.5, 10.5, 20)).toBe(true); // recorded 15 m: overflyable
    expect(unlimited.isFreeForAir(10.5, 10.5, 14)).toBe(false);

    const withDefault = mk(30);
    expect(withDefault.obstacleTopM(5, 5)).toBe(30);
    expect(withDefault.isFreeForAir(5.5, 5.5, 29)).toBe(false);
    expect(withDefault.isFreeForAir(5.5, 5.5, 31)).toBe(true);
    expect(withDefault.obstacleTopM(10, 10)).toBe(15); // recorded heights win over the default
    expect(withDefault.isFreeForGround(5.5, 5.5)).toBe(false); // ground vehicles unaffected

    const ha = new StateHasher();
    const hb = new StateHasher();
    unlimited.hashInto(ha);
    withDefault.hashInto(hb);
    expect(ha.hex()).not.toBe(hb.hex()); // the default is part of the world
  });

  it("validates defaultObstacleHeightM", () => {
    const base = { sizeX: 8, sizeY: 8, resolutionM: 1, altitudeLimitsM: { min: 0, max: 50 } };
    for (const bad of [0, -1, 51, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new GridSpace({ ...base, defaultObstacleHeightM: bad })).toThrow(RangeError);
    }
    expect(new GridSpace({ ...base, defaultObstacleHeightM: 50 }).defaultObstacleHeightM).toBe(50);
  });

  it("applies geofences to ground and air checks", () => {
    const g = new GridSpace({
      sizeX: 64,
      sizeY: 64,
      resolutionM: 1,
      zones: [{ id: "fence", kind: "geofence", polygon: [[0, 0], [32, 0], [32, 32], [0, 32]] }],
    });
    expect(g.isFreeForGround(10, 10)).toBe(true);
    expect(g.isFreeForGround(40, 10)).toBe(false);
    expect(g.isFreeForAir(40, 10, 20)).toBe(false);
    g.setCell("terrainCost", 5, 5, 0);
    expect(g.isFreeForGround(5.5, 5.5)).toBe(false); // impassable for ground…
    expect(g.isFreeForAir(5.5, 5.5, 20)).toBe(true); // …ignored by UAVs (ADR-0025)
  });
});
