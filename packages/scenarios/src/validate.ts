import { err, ok, validate, type CodedError, type Result } from "@agentsim/core";
import { pointInPolygon } from "@agentsim/spatial";
import { BUILTIN_BODY_DEFAULTS } from "./body-defaults.ts";
import { SCENARIO_LIMITS, SCENARIO_SCHEMA_VERSION, ScenarioDocument, type LayerKey, type ZoneSpec } from "./schema.ts";

/** Stable codes for every way a scenario document can be rejected (ADR-0025). */
export type ScenarioErrorCode =
  | "too_large"
  | "invalid_json"
  | "unsupported_schema_version"
  | "invalid_document"
  | "duplicate_agent_key"
  | "duplicate_zone_id"
  | "zone_shape"
  | "invalid_polygon"
  | "invalid_altitude_band"
  | "invalid_altitude_limits"
  | "invalid_default_obstacle_height"
  | "chunk_out_of_bounds"
  | "duplicate_chunk"
  | "layer_decode_failed"
  | "layer_value_out_of_range"
  | "agent_out_of_bounds"
  | "agent_start_blocked"
  | "base_outside_zone"
  | "invalid_battery"
  // F2 (ADR-0025 addition of 2026-10-09)
  | "low_soc_not_above_critical"
  | "sensor_id_duplicate"
  | "sensor_band_below_clearance"
  | "object_id_duplicate"
  | "object_id_reserved"
  | "object_out_of_bounds"
  | "prior_id_duplicate"
  | "prior_size_mismatch"
  | "prior_too_large";

/** `path` points at the offending part of the document (JSON-pointer style). */
export type ScenarioError = CodedError<ScenarioErrorCode> & { readonly path?: string };

const fail = (code: ScenarioErrorCode, message: string, path?: string): { ok: false; error: ScenarioError } =>
  err(path === undefined ? { code, message } : { code, message, path });

/** UTF-8 byte length without allocating (the 64 MiB limit is on bytes, not UTF-16 units). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Parses an untrusted scenario file (file import, paste, LLM output): size limit, JSON, then
 * `parseScenarioValue`. YAML is not accepted in v0.
 */
export function parseScenario(text: string): Result<ScenarioDocument, ScenarioError> {
  // Cheap bound first: a string longer than the limit in UTF-16 units is over it in bytes too.
  if (text.length > SCENARIO_LIMITS.maxDocumentBytes || utf8Length(text) > SCENARIO_LIMITS.maxDocumentBytes) {
    return fail("too_large", `scenario documents are limited to ${SCENARIO_LIMITS.maxDocumentBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return fail("invalid_json", e instanceof Error ? e.message.slice(0, 200) : "invalid JSON");
  }
  return parseScenarioValue(value);
}

/**
 * Validates an already-parsed value (e.g. a document read back from storage, which may come from an
 * imported database): schema, then the cross-field rules of `validateScenario`.
 */
export function parseScenarioValue(value: unknown): Result<ScenarioDocument, ScenarioError> {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof value === "object" && value !== null && version !== SCENARIO_SCHEMA_VERSION) {
    return fail("unsupported_schema_version", `unsupported scenario schemaVersion ${JSON.stringify(version)?.slice(0, 20)}`, "/schemaVersion");
  }
  const r = validate(ScenarioDocument, value);
  if (!r.ok) {
    const first = r.error.issues[0];
    return fail("invalid_document", first ? `${first.path || "/"}: ${first.message}` : r.error.message, first?.path);
  }
  const v = validateScenario(r.value);
  return v.ok ? ok(r.value) : v;
}

/** Cross-field rules that the schema cannot express. Does not decode layers (see `loadScenario`). */
export function validateScenario(doc: ScenarioDocument): Result<void, ScenarioError> {
  const w = doc.world;
  if (!(w.altitudeLimitsM.min < w.altitudeLimitsM.max)) return fail("invalid_altitude_limits", "altitudeLimitsM.min must be below max", "/world/altitudeLimitsM");
  if (w.defaultObstacleHeightM !== undefined && w.defaultObstacleHeightM > w.altitudeLimitsM.max) {
    return fail("invalid_default_obstacle_height", "defaultObstacleHeightM must not exceed the altitude ceiling", "/world/defaultObstacleHeightM");
  }
  const chunksX = Math.ceil(w.sizeCells.x / w.chunkSize);
  const chunksY = Math.ceil(w.sizeCells.y / w.chunkSize);
  for (const name of ["occupancy", "terrainCost", "heightDm"] as const satisfies readonly LayerKey[]) {
    const seen = new Set<number>();
    const chunks = w.layers[name]?.chunks ?? [];
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      if (!c) continue;
      const path = `/world/layers/${name}/chunks/${k}`;
      if (c.ci >= chunksX || c.cj >= chunksY) return fail("chunk_out_of_bounds", `chunk (${c.ci}, ${c.cj}) is outside the ${chunksX} × ${chunksY} chunk grid`, path);
      const id = c.cj * chunksX + c.ci;
      if (seen.has(id)) return fail("duplicate_chunk", `chunk (${c.ci}, ${c.cj}) appears twice in ${name}`, path);
      seen.add(id);
    }
  }

  const zoneIds = new Set<string>();
  for (let k = 0; k < doc.zones.length; k++) {
    const z = doc.zones[k];
    if (!z) continue;
    const path = `/zones/${k}`;
    if (zoneIds.has(z.id)) return fail("duplicate_zone_id", `zone id "${z.id}" is used twice`, path);
    zoneIds.add(z.id);
    if ((z.rect === undefined) === (z.polygon === undefined)) return fail("zone_shape", "a zone needs exactly one of rect and polygon", path);
    if (z.rect && !(z.rect.x0 < z.rect.x1 && z.rect.y0 < z.rect.y1)) return fail("invalid_polygon", "rect needs x0 < x1 and y0 < y1", `${path}/rect`);
    if (z.polygon && !isSimplePolygon(z.polygon)) return fail("invalid_polygon", "polygon must have non-zero area and no self-intersections", `${path}/polygon`);
    if (z.minAltM !== undefined && z.maxAltM !== undefined && !(z.minAltM < z.maxAltM)) return fail("invalid_altitude_band", "minAltM must be below maxAltM", path);
  }

  const keys = new Set<string>();
  const widthM = w.sizeCells.x * w.resolutionM;
  const heightM = w.sizeCells.y * w.resolutionM;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < widthM && y < heightM;
  for (let k = 0; k < doc.agents.length; k++) {
    const a = doc.agents[k];
    if (!a) continue;
    const path = `/agents/${k}`;
    if (a.key !== undefined) {
      if (keys.has(a.key)) return fail("duplicate_agent_key", `agent key "${a.key}" is used twice`, `${path}/key`);
      keys.add(a.key);
    }
    if (!inMap(a.start.xM, a.start.yM)) return fail("agent_out_of_bounds", "start position is outside the map", `${path}/start`);
    if (a.kind === "ugv" && a.start.zM !== undefined && a.start.zM !== 0) return fail("agent_start_blocked", "ground vehicles start on the ground (omit zM)", `${path}/start/zM`);
    // zM 0 (or absent) = grounded; any other start altitude must be inside the airspace limits.
    if (a.kind === "uav" && a.start.zM !== undefined && a.start.zM > 0 && (a.start.zM < w.altitudeLimitsM.min || a.start.zM > w.altitudeLimitsM.max)) {
      return fail("agent_start_blocked", "start altitude is outside the altitude limits", `${path}/start/zM`);
    }
    if (a.base) {
      if (!inMap(a.base.xM, a.base.yM)) return fail("agent_out_of_bounds", "base is outside the map", `${path}/base`);
      const inBase = doc.zones.some((z) => z.kind === "base" && pointInPolygon(a.base?.xM ?? 0, a.base?.yM ?? 0, zonePolygon(z)));
      if (!inBase) return fail("base_outside_zone", "an agent's base must lie inside a zone of kind base", `${path}/base`);
    }
    const b = a.body?.battery;
    if (b?.criticalSoc !== undefined && b.initialSoc !== undefined && b.criticalSoc >= b.initialSoc) {
      return fail("invalid_battery", "criticalSoc must be below initialSoc", `${path}/body/battery`);
    }
    // On resolved values: an authored criticalSoc must stay below the default lowSoc too.
    const built = BUILTIN_BODY_DEFAULTS[a.kind].battery;
    const low = b?.lowSoc ?? built.lowSoc;
    const critical = b?.criticalSoc ?? built.criticalSoc;
    if (!(low > critical)) return fail("low_soc_not_above_critical", `lowSoc (${low}) must be above criticalSoc (${critical})`, `${path}/body/battery`);
    const sensorIds = new Set<string>();
    for (const [k, s] of (a.body?.sensors ?? []).entries()) {
      if (sensorIds.has(s.id)) return fail("sensor_id_duplicate", `sensor id "${s.id}" is used twice in one body`, `${path}/body/sensors/${k}`);
      sensorIds.add(s.id);
    }
    if (a.kind === "uav") {
      // A UAV's range beams must reach at least its clearance below it (ADR-0012 addition: why a beam height).
      const clearanceM = a.body?.clearanceM ?? BUILTIN_BODY_DEFAULTS.uav.clearanceM;
      for (const [k, s] of (a.body?.sensors ?? []).entries()) {
        if (s.type !== "camera" && s.beamHalfHeightM !== undefined && s.beamHalfHeightM < clearanceM) {
          return fail("sensor_band_below_clearance", `sensor "${s.id}": beamHalfHeightM ${s.beamHalfHeightM} is below the body's clearance ${clearanceM}`, `${path}/body/sensors/${k}`);
        }
      }
    }
  }

  const entityIds = new Set<string>();
  for (const [k, o] of (doc.objects ?? []).entries()) {
    const path = `/objects/${k}`;
    if (/^(uav|ugv|virt)-[0-9]+$/.test(o.id)) return fail("object_id_reserved", `object id "${o.id}" has the agent-ID form`, `${path}/id`);
    if (entityIds.has(o.id)) return fail("object_id_duplicate", `object id "${o.id}" is used twice`, `${path}/id`);
    entityIds.add(o.id);
    if (!inMap(o.position.xM, o.position.yM)) return fail("object_out_of_bounds", "object position is outside the map", `${path}/position`);
  }

  // Priors (ADR-0025 addition of 2026-10-09): the world's size and chunking, at most 4 MiB encoded each.
  const priorIds = new Set<string>();
  for (const [k, p] of (doc.priors ?? []).entries()) {
    const path = `/priors/${k}`;
    if (priorIds.has(p.id)) return fail("prior_id_duplicate", `prior id "${p.id}" is used twice`, `${path}/id`);
    priorIds.add(p.id);
    const bytes = utf8Length(JSON.stringify(p));
    if (bytes > SCENARIO_LIMITS.maxPriorBytes) return fail("prior_too_large", `prior "${p.id}" is ${bytes} bytes encoded; the limit is ${SCENARIO_LIMITS.maxPriorBytes}`, path);
    for (const name of ["knowledge", "heightDm", "terrainCost"] as const) {
      const seen = new Set<number>();
      for (const [m, c] of (p.layers[name]?.chunks ?? []).entries()) {
        const cpath = `${path}/layers/${name}/chunks/${m}`;
        if (c.ci >= chunksX || c.cj >= chunksY) return fail("prior_size_mismatch", `prior "${p.id}": chunk (${c.ci}, ${c.cj}) is outside the world's ${chunksX} × ${chunksY} chunk grid`, cpath);
        const id = c.cj * chunksX + c.ci;
        if (seen.has(id)) return fail("duplicate_chunk", `chunk (${c.ci}, ${c.cj}) appears twice in prior "${p.id}" ${name}`, cpath);
        seen.add(id);
      }
    }
  }
  return ok(undefined);
}

/** A zone's outline as a polygon (the rect shorthand expanded counter-clockwise). */
export function zonePolygon(z: ZoneSpec): [number, number][] {
  if (z.rect) {
    const { x0, y0, x1, y1 } = z.rect;
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }
  return (z.polygon ?? []).map(([x, y]) => [x, y]);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
}

function segmentsIntersect(p: readonly number[], q: readonly number[]): boolean {
  const [ax = 0, ay = 0, bx = 0, by = 0] = p;
  const [cx = 0, cy = 0, dx = 0, dy = 0] = q;
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) ||
    (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) ||
    (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) ||
    (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by))
  );
}

/** Non-zero area and no two non-adjacent edges touching (n ≤ 256, so O(n²) is fine). */
export function isSimplePolygon(poly: readonly (readonly [number, number])[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let area2 = 0;
  const edges: number[][] = [];
  for (let k = 0; k < n; k++) {
    const [ax, ay] = poly[k] ?? [0, 0];
    const [bx, by] = poly[(k + 1) % n] ?? [0, 0];
    area2 += ax * by - bx * ay;
    edges.push([ax, ay, bx, by]);
  }
  if (area2 === 0) return false;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const adjacent = b === a + 1 || (a === 0 && b === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(edges[a] ?? [], edges[b] ?? [])) return false;
    }
  }
  // Repeated vertices make adjacent edges degenerate.
  for (let a = 0; a < n; a++) {
    const [ax, ay] = poly[a] ?? [0, 0];
    const [bx, by] = poly[(a + 1) % n] ?? [0, 0];
    if (ax === bx && ay === by) return false;
  }
  return true;
}
