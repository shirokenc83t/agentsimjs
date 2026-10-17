/** Zone kinds (ADR-0025): base areas, no-fly volumes (2.5D with optional altitude band), geofences. */
export type ZoneKind = "base" | "noFly" | "geofence";

export interface Zone {
  readonly id: string;
  readonly kind: ZoneKind;
  /** Simple polygon in metres (x east, y north), at least 3 vertices, not self-intersecting. */
  readonly polygon: readonly (readonly [number, number])[];
  /** Altitude band of a no-fly volume (metres above datum); absent = from ground to sky. */
  readonly minAltM?: number;
  readonly maxAltM?: number;
}

/** Axis-aligned rectangle as a polygon (the scenario's rectangle shorthand). */
export function rectPolygon(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Even–odd point-in-polygon with IEEE arithmetic only (deterministic). Points exactly on an edge
 * follow the half-open convention of the crossing test (consistent across engines).
 */
export function pointInPolygon(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const pa = poly[a];
    const pb = poly[b];
    if (!pa || !pb) continue;
    const [xa, ya] = pa;
    const [xb, yb] = pb;
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/** Zone lookup with deterministic order (sorted by id). F1 sizes (≤ 4096 zones) need no index yet. */
export class ZoneSet {
  readonly zones: readonly Zone[];
  private readonly bounds: Float64Array;

  constructor(zones: readonly Zone[]) {
    const ids = new Set<string>();
    for (const z of zones) {
      if (ids.has(z.id)) throw new Error(`duplicate zone id ${z.id}`);
      ids.add(z.id);
      if (z.polygon.length < 3) throw new Error(`zone ${z.id} needs at least 3 vertices`);
    }
    this.zones = [...zones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.bounds = new Float64Array(this.zones.length * 4);
    this.zones.forEach((z, k) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of z.polygon) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      this.bounds.set([x0, y0, x1, y1], k * 4);
    });
  }

  private contains(k: number, x: number, y: number): boolean {
    const b = this.bounds;
    if (x < (b[k * 4] ?? 0) || y < (b[k * 4 + 1] ?? 0) || x > (b[k * 4 + 2] ?? 0) || y > (b[k * 4 + 3] ?? 0)) return false;
    const z = this.zones[k];
    return !!z && pointInPolygon(x, y, z.polygon);
  }

  /** Zones of `kind` containing (x, y), in id order. */
  at(x: number, y: number, kind?: ZoneKind): Zone[] {
    const out: Zone[] = [];
    this.zones.forEach((z, k) => {
      if ((kind === undefined || z.kind === kind) && this.contains(k, x, y)) out.push(z);
    });
    return out;
  }

  /** True if (x, y, z) lies inside a no-fly volume (altitude band inclusive). */
  isNoFly(x: number, y: number, z: number): boolean {
    for (let k = 0; k < this.zones.length; k++) {
      const zone = this.zones[k];
      if (!zone || zone.kind !== "noFly") continue;
      if (z < (zone.minAltM ?? -Infinity) || z > (zone.maxAltM ?? Infinity)) continue;
      if (this.contains(k, x, y)) return true;
    }
    return false;
  }

  /** True if there are geofences and (x, y) lies outside all of them; no geofence = unrestricted. */
  outsideGeofence(x: number, y: number): boolean {
    let any = false;
    for (let k = 0; k < this.zones.length; k++) {
      if (this.zones[k]?.kind !== "geofence") continue;
      any = true;
      if (this.contains(k, x, y)) return false;
    }
    return any;
  }
}
