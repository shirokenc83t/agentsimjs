import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { lineOfSight, newRayHit, raycast2d } from "./raycast.ts";
import { SpatialHash } from "./spatial-hash.ts";
import { pointInPolygon, ZoneSet } from "./zones.ts";

describe("raycast2d (DDA)", () => {
  it("matches dense ray marching on random grids", () => {
    const rng = Rng.fromSeed(11).derive("raycast");
    const size = 40;
    const cells = new Uint8Array(size * size);
    for (let k = 0; k < 200; k++) cells[rng.intRange(0, size * size - 1)] = 1;
    const blocked = (i: number, j: number) => i < 0 || j < 0 || i >= size || j >= size || cells[j * size + i] === 1;
    const out = newRayHit();
    for (let q = 0; q < 500; q++) {
      const x0 = 1 + rng.nextFloat01() * (size - 2);
      const y0 = 1 + rng.nextFloat01() * (size - 2);
      if (blocked(Math.floor(x0), Math.floor(y0))) continue;
      const a = rng.nextFloat01() * 2 * Math.PI;
      const dx = Math.cos(a); // test code may use native Math
      const dy = Math.sin(a);
      raycast2d(blocked, 1, x0, y0, dx, dy, 30, out);
      // brute force: march in tiny steps until the first blocked cell
      let t = 0;
      let hitT = Infinity;
      while (t <= 30) {
        if (blocked(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t))) {
          hitT = t;
          break;
        }
        t += 0.0005;
      }
      if (hitT === Infinity) expect(out.hit).toBe(false);
      else {
        expect(out.hit).toBe(true);
        expect(Math.abs(out.distanceM - hitT)).toBeLessThan(0.002);
      }
    }
  });

  it("checks line of sight between two points", () => {
    const blocked = (i: number, j: number) => i === 5 && j >= 0 && j < 10;
    const s = newRayHit();
    expect(lineOfSight(blocked, 1, 1.5, 1.5, 8.5, 1.5, s)).toBe(false);
    expect(lineOfSight(blocked, 1, 1.5, 1.5, 4.5, 8.5, s)).toBe(true);
    expect(lineOfSight(blocked, 1, 1.5, 11.5, 8.5, 11.5, s)).toBe(true);
  });
});

describe("zones", () => {
  it("tests points in polygons (concave)", () => {
    const L: [number, number][] = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
    expect(pointInPolygon(1, 1, L)).toBe(true);
    expect(pointInPolygon(1, 9, L)).toBe(true);
    expect(pointInPolygon(5, 5, L)).toBe(false);
    expect(pointInPolygon(11, 1, L)).toBe(false);
  });

  it("orders zones by id and rejects duplicates and degenerate polygons", () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const set = new ZoneSet([
      { id: "z2", kind: "base", polygon: sq },
      { id: "z1", kind: "base", polygon: sq },
    ]);
    expect(set.at(5, 5).map((z) => z.id)).toEqual(["z1", "z2"]);
    expect(() => new ZoneSet([{ id: "a", kind: "base", polygon: sq }, { id: "a", kind: "base", polygon: sq }])).toThrow(/duplicate/);
    expect(() => new ZoneSet([{ id: "a", kind: "base", polygon: [[0, 0], [1, 1]] }])).toThrow(/3 vertices/);
  });
});

describe("SpatialHash", () => {
  it("matches brute force and is deterministic", () => {
    const rng = Rng.fromSeed(2).derive("hash");
    const h = new SpatialHash(32, 10);
    const pts = new Map<string, [number, number]>();
    for (let k = 0; k < 300; k++) {
      const id = `a-${String(rng.intRange(0, 999)).padStart(3, "0")}`;
      const pt: [number, number] = [rng.nextFloat01() * 320, rng.nextFloat01() * 320];
      pts.set(id, pt);
      h.set(id, pt[0], pt[1]);
    }
    for (let q = 0; q < 100; q++) {
      const x = rng.nextFloat01() * 320;
      const y = rng.nextFloat01() * 320;
      const r = rng.nextFloat01() * 60;
      const brute = [...pts].filter(([, [px, py]]) => (px - x) ** 2 + (py - y) ** 2 <= r * r).map(([id]) => id).sort();
      expect(h.queryRadius(x, y, r)).toEqual(brute);
    }
  });
});
