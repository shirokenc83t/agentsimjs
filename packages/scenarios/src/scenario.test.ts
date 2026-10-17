import { StateHasher } from "@agentsim/core";
import { OCCUPANCY_BLOCKED, toBase64, type GridSpace } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { buildReferenceWorld } from "@agentsim/spatial";
import { resolveBody } from "./body-defaults.ts";
import { scenarioFromGrid, serializeScenario } from "./encode.ts";
import { formatAgentId, loadScenario } from "./load.ts";
import { SCENARIO_LIMITS, type AgentSpec, type ScenarioDocument, type ZoneSpec } from "./schema.ts";
import { parseScenario, parseScenarioValue, utf8Length, type ScenarioErrorCode } from "./validate.ts";

/** 64 × 64 m world at 1 m (one 64-cell chunk), a base zone in the south-west corner. */
function doc(over: Partial<ScenarioDocument> = {}, world: Partial<ScenarioDocument["world"]> = {}): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "test-world",
    name: "Test world",
    defaultSeed: 7,
    world: {
      resolutionM: 1,
      sizeCells: { x: 64, y: 64 },
      chunkSize: 64,
      altitudeLimitsM: { min: 0, max: 60 },
      layers: {},
      ...world,
    },
    zones: [{ id: "base-a", kind: "base", rect: { x0: 0, y0: 0, x1: 8, y1: 8 } }],
    agents: [
      { kind: "uav", key: "scout", start: { xM: 2, yM: 2 }, base: { xM: 2, yM: 2 } },
      { kind: "ugv", start: { xM: 4, yM: 4 } },
      { kind: "uav", start: { xM: 30, yM: 30, zM: 20 } },
    ],
    ...over,
  };
}

const hashOf = (g: GridSpace) => {
  const h = new StateHasher();
  g.hashInto(h);
  return h.digest();
};

function expectCode(r: { ok: boolean; error?: { code: string } }, code: ScenarioErrorCode) {
  expect(r.ok).toBe(false);
  expect(r.ok ? null : r.error?.code).toBe(code);
}

describe("scenario document v0 (ADR-0025)", () => {
  it("parses, validates and loads a minimal document; IDs are per-kind counters in document order", () => {
    const r = parseScenario(serializeScenario(doc()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const l = loadScenario(r.value);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.value.grid.sizeX).toBe(64);
    expect(l.value.agents.map((a) => [a.id, a.key ?? null, a.start.airborne])).toEqual([
      ["uav-001", "scout", false],
      ["ugv-001", null, false],
      ["uav-002", null, true],
    ]);
    expect(formatAgentId("ugv", 12)).toBe("ugv-012");
    expect(l.value.grid.defaultObstacleHeightM).toBeUndefined();
  });

  it("round-trips the 1 km² reference world: grid → document → JSON → grid with the same state hash", () => {
    const grid = buildReferenceWorld();
    const zones: ZoneSpec[] = [{ id: "base", kind: "base", rect: { x0: 0, y0: 0, x1: 20, y1: 20 } }];
    const agents: AgentSpec[] = [{ kind: "ugv", key: "rover", start: { xM: 5, yM: 5 }, base: { xM: 5, yM: 5 } }];
    const d = scenarioFromGrid({ id: "reference", name: "Reference 1 km²", defaultSeed: 1 }, grid, zones, agents);
    const text = serializeScenario(d);
    const parsed = parseScenario(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const loaded = loadScenario(parsed.value);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Zones are part of the hash; the reference grid has none, so compare layers via a zone-free copy.
    const plain = loadScenario({ ...parsed.value, zones: [], agents: [] });
    expect(plain.ok && hashOf(plain.value.grid)).toBe(hashOf(grid));
    // ADR-0025: the encoded document stays small (raw layers would be ~16 MB).
    expect(utf8Length(text)).toBeLessThan(1_000_000);
  });

  it("warns (without failing) when a UGV's look-ahead and tracking margin are inconsistent", () => {
    const ok = loadScenario(doc());
    expect(ok.ok && ok.value.warnings).toEqual([]); // built-in defaults are consistent
    const bad = loadScenario(doc({ agents: [{ kind: "ugv", start: { xM: 4, yM: 4 }, body: { drive: "forward-only", lookaheadM: 3, turningRadiusM: 1.5, trackingMarginM: 0.2 } }] }));
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.value.warnings.map((w) => [w.code, w.path])).toEqual([
      ["lookahead_exceeds_turning_radius", "/agents/0/body/lookaheadM"],
      ["tracking_margin_below_estimated_cut", "/agents/0/body/trackingMarginM"],
    ]);
  });

  it("applies defaultObstacleHeightM", () => {
    const l = loadScenario(doc({}, { defaultObstacleHeightM: 12 }));
    expect(l.ok && l.value.grid.defaultObstacleHeightM).toBe(12);
  });
});

describe("rejections with stable codes", () => {
  const blockedChunk = { chunks: [{ ci: 0, cj: 0, fill: OCCUPANCY_BLOCKED }] };
  const cases: [string, unknown, ScenarioErrorCode][] = [
    ["not JSON", "{oops", "invalid_json"],
    ["unknown schema version", { ...doc(), schemaVersion: 3 }, "unsupported_schema_version"],
    ["unknown field", { ...doc(), extra: true }, "invalid_document"],
    ["bad id", { ...doc(), id: "Bad Id" }, "invalid_document"],
    ["map too large", doc({}, { sizeCells: { x: 8193, y: 10 } }), "invalid_document"],
    ["chunk size not allowed", doc({}, { chunkSize: 48 as 64 }), "invalid_document"],
    ["altitude limits inverted", doc({}, { altitudeLimitsM: { min: 50, max: 10 } }), "invalid_altitude_limits"],
    ["obstacle height above ceiling", doc({}, { defaultObstacleHeightM: 61 }), "invalid_default_obstacle_height"],
    ["chunk outside the grid", doc({}, { layers: { occupancy: { chunks: [{ ci: 1, cj: 0, fill: 1 }] } } }), "chunk_out_of_bounds"],
    ["duplicate chunk", doc({}, { layers: { terrainCost: { chunks: [{ ci: 0, cj: 0, fill: 5 }, { ci: 0, cj: 0, fill: 6 }] } } }), "duplicate_chunk"],
    ["occupancy fill out of range", doc({}, { layers: { occupancy: { chunks: [{ ci: 0, cj: 0, fill: 2 }] } } }), "invalid_document"],
    ["duplicate zone id", doc({ zones: [doc().zones[0] as ZoneSpec, doc().zones[0] as ZoneSpec] }), "duplicate_zone_id"],
    ["zone with rect and polygon", doc({ zones: [{ id: "z", kind: "noFly", rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, polygon: [[0, 0], [1, 0], [1, 1]] }], agents: [] }), "zone_shape"],
    ["self-intersecting polygon", doc({ zones: [{ id: "z", kind: "noFly", polygon: [[0, 0], [10, 10], [10, 0], [0, 10]] }], agents: [] }), "invalid_polygon"],
    ["degenerate polygon", doc({ zones: [{ id: "z", kind: "noFly", polygon: [[0, 0], [5, 5], [10, 10]] }], agents: [] }), "invalid_polygon"],
    ["inverted altitude band", doc({ zones: [{ id: "z", kind: "noFly", rect: { x0: 0, y0: 0, x1: 5, y1: 5 }, minAltM: 30, maxAltM: 10 }], agents: [] }), "invalid_altitude_band"],
    ["duplicate agent key", doc({ agents: [{ kind: "ugv", key: "a", start: { xM: 1, yM: 1 } }, { kind: "ugv", key: "a", start: { xM: 3, yM: 3 } }] }), "duplicate_agent_key"],
    ["agent outside the map", doc({ agents: [{ kind: "ugv", start: { xM: 64, yM: 1 } }] }), "agent_out_of_bounds"],
    ["ground vehicle with altitude", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1, zM: 5 } }] }), "agent_start_blocked"],
    ["UAV above the ceiling", doc({ agents: [{ kind: "uav", start: { xM: 1, yM: 1, zM: 80 } }] }), "agent_start_blocked"],
    ["base outside a base zone", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, base: { xM: 30, yM: 30 } }] }), "base_outside_zone"],
    ["critical battery above initial", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, body: { battery: { initialSoc: 0.2, criticalSoc: 0.5 } } }] }), "invalid_battery"],
    // F2 (ADR-0025 addition of 2026-10-09): low battery above critical, sensors, objects.
    ["low battery not above critical", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, body: { battery: { lowSoc: 0.1, criticalSoc: 0.15 } } }] }), "low_soc_not_above_critical"],
    ["authored critical above the default low", doc({ agents: [{ kind: "uav", start: { xM: 1, yM: 1 }, body: { battery: { criticalSoc: 0.35 } } }] }), "low_soc_not_above_critical"],
    [
      "duplicate sensor id",
      doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, body: { sensors: [{ id: "front", type: "proximity" }, { id: "front", type: "camera" }] } }] }),
      "sensor_id_duplicate",
    ],
    [
      "UAV range beam thinner than its clearance",
      doc({ agents: [{ kind: "uav", start: { xM: 1, yM: 1 }, body: { clearanceM: 2, sensors: [{ id: "lidar", type: "lidar", beamHalfHeightM: 1 }] } }] }),
      "sensor_band_below_clearance",
    ],
    ["sensor rate out of range", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, body: { sensors: [{ id: "lidar", type: "lidar", rateHz: 500 }] } }] }), "invalid_document"],
    ["log-odds increment out of range", doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 }, body: { sensors: [{ id: "lidar", type: "lidar", logOddsHit: 50 }] } }] }), "invalid_document"],
    [
      "duplicate object id",
      doc({ objects: [{ id: "t1", kind: "target", position: { xM: 5, yM: 5 }, size: { radiusM: 0.5, heightM: 1 } }, { id: "t1", kind: "target", position: { xM: 6, yM: 6 }, size: { radiusM: 0.5, heightM: 1 } }] }),
      "object_id_duplicate",
    ],
    ["object id in the agent-ID form", doc({ objects: [{ id: "ugv-001", kind: "target", position: { xM: 5, yM: 5 }, size: { radiusM: 0.5, heightM: 1 } }] }), "object_id_reserved"],
    ["object outside the map", doc({ objects: [{ id: "t1", kind: "target", position: { xM: 70, yM: 5 }, size: { radiusM: 0.5, heightM: 1 } }] }), "object_out_of_bounds"],
    ["too many agents", doc({ agents: Array.from({ length: SCENARIO_LIMITS.maxAgents + 1 }, () => ({ kind: "ugv" as const, start: { xM: 1, yM: 1 } })) }), "invalid_document"],
    ["too many zones", doc({ zones: Array.from({ length: SCENARIO_LIMITS.maxZones + 1 }, (_, k) => ({ id: `z${k}`, kind: "noFly" as const, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } })), agents: [] }), "invalid_document"],
    ["polygon with too many vertices", doc({ zones: [{ id: "z", kind: "noFly", polygon: Array.from({ length: 257 }, (_, k) => [k, k % 2] as [number, number]) }], agents: [] }), "invalid_document"],
  ];
  it.each(cases)("%s", (_, input, code) => {
    const r = typeof input === "string" ? parseScenario(input) : parseScenarioValue(JSON.parse(JSON.stringify(input)));
    expectCode(r, code);
  });

  it("rejects agents starting inside obstacles or no-fly volumes when loading", () => {
    const onBuilding = doc({ agents: [{ kind: "ugv", start: { xM: 1, yM: 1 } }] }, { layers: { occupancy: blockedChunk } });
    expectCode(loadScenario(onBuilding), "agent_start_blocked");
    const groundedUavOnBuilding = doc({ agents: [{ kind: "uav", start: { xM: 1, yM: 1 } }] }, { layers: { occupancy: blockedChunk } });
    expectCode(loadScenario(groundedUavOnBuilding), "agent_start_blocked");
    const inNoFly = doc({ zones: [{ id: "nf", kind: "noFly", rect: { x0: 20, y0: 20, x1: 40, y1: 40 } }], agents: [{ kind: "uav", start: { xM: 30, yM: 30, zM: 20 } }] });
    expectCode(loadScenario(inNoFly), "agent_start_blocked");
    // Unknown-height obstacles are unlimited without defaultObstacleHeightM, so a UAV above one is blocked…
    const overUnknown = doc({ zones: [], agents: [{ kind: "uav", start: { xM: 1, yM: 1, zM: 40 } }] }, { layers: { occupancy: blockedChunk } });
    expectCode(loadScenario(overUnknown), "agent_start_blocked");
    // …and allowed above the default height when one is set.
    expect(loadScenario({ ...overUnknown, world: { ...overUnknown.world, defaultObstacleHeightM: 10 } }).ok).toBe(true);
  });
});

describe("F2 additions: sensors, objects, low battery (ADR-0025 addition of 2026-10-09)", () => {
  it("bodies without sensors get the built-in set for their kind", () => {
    const ugv = resolveBody("ugv", {});
    expect(ugv.sensors.map((s) => [s.id, s.type, s.rateHz, s.rangeM])).toEqual([
      ["lidar", "lidar", 10, 30],
      ["proximity", "proximity", 10, 2], // the tick rate: faster sensors are rejected
      ["camera", "camera", 5, 40],
    ]);
    const lidar = ugv.sensors[0];
    expect(lidar?.type === "lidar" && [lidar.rays, lidar.fovDeg, lidar.mountHeightM, lidar.beamHalfHeightM, lidar.rangeSigmaM]).toEqual([180, 360, 0.5, 0.5, 0.02]);
    expect(ugv.battery.lowSoc).toBe(0.3);
    expect(ugv.beliefs.lostAfterS).toBe(2);
    const uav = resolveBody("uav", { clearanceM: 3 });
    expect(uav.sensors.map((s) => [s.id, s.rangeM])).toEqual([
      ["lidar", 50],
      ["proximity", 3],
      ["camera", 60],
    ]);
    for (const s of uav.sensors) if (s.type !== "camera") expect(s.beamHalfHeightM).toBe(3); // follows the clearance
    // Camera mounts: 1 m above the ground on a UGV, at the vehicle on a UAV.
    expect(ugv.sensors.find((s) => s.type === "camera")?.mountHeightM).toBe(1);
    expect(uav.sensors.find((s) => s.type === "camera")?.mountHeightM).toBe(0);
    expect(resolveBody("ugv", { sensors: [{ id: "cam", type: "camera", mountHeightM: 2.5 }] }).sensors[0]?.mountHeightM).toBe(2.5);
  });

  it("authored sensors replace the built-in set; each one is completed from its type's defaults", () => {
    const b = resolveBody("ugv", { sensors: [{ id: "front", type: "lidar", rays: 90, fovDeg: 180 }] });
    expect(b.sensors).toHaveLength(1);
    expect(b.sensors[0]).toMatchObject({ id: "front", type: "lidar", rays: 90, fovDeg: 180, rangeM: 30, rateHz: 10, logOddsHit: 30, logOddsMiss: 20, dropoutProbability: 0 });
  });

  it("objects are loaded with the scenario, in document order", () => {
    const r = loadScenario(doc({ objects: [{ id: "t1", kind: "target", position: { xM: 5, yM: 5 }, size: { radiusM: 0.5, heightM: 1 }, label: "lost hiker" }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.objects).toEqual([{ id: "t1", kind: "target", position: { xM: 5, yM: 5, zM: 0 }, size: { radiusM: 0.5, heightM: 1 }, label: "lost hiker" }]);
  });
});

describe("malicious and malformed input (untrusted files, ADR-0025)", () => {
  const rleDoc = (rle: string, layer: "occupancy" | "heightDm" = "occupancy") => doc({ agents: [] }, { layers: { [layer]: { chunks: [{ ci: 0, cj: 0, rle }] } } });

  it.each([
    ["bad base64", "@@@@"],
    ["runs overflow the chunk", "/38B"], // varint 0x3fff = 16383 > 4096 cells? (first run exceeds)
    ["runs underflow the chunk", "AQA="], // one cell
    ["zero-length run", "AAA="],
    ["truncated pair", "gQ=="],
  ])("RLE: %s → layer_decode_failed", (_, rle) => {
    const p = parseScenarioValue(JSON.parse(JSON.stringify(rleDoc(rle))));
    expect(p.ok).toBe(true);
    if (p.ok) expectCode(loadScenario(p.value), "layer_decode_failed");
  });

  it("RLE values outside the layer range are rejected", () => {
    // 4096 cells of value 2 in the occupancy layer: run 4096 = 0x80 0x20, value 2.
    const rle = toBase64(Uint8Array.from([0x80, 0x20, 2]));
    const p = parseScenarioValue(rleDoc(rle));
    expect(p.ok).toBe(true);
    if (p.ok) expectCode(loadScenario(p.value), "layer_value_out_of_range");
  });

  it("rejects prototype keys, wrong types and code-like strings", () => {
    for (const text of [
      '{"__proto__": {"polluted": true}, "schemaVersion": 0}',
      JSON.stringify({ ...doc(), constructor: { prototype: {} } }),
      JSON.stringify({ ...doc(), defaultSeed: "1" }),
      JSON.stringify({ ...doc(), name: { toString: "() => 1" } }),
      JSON.stringify(doc({}, { resolutionM: Number.NaN })), // NaN → null in JSON
    ]) {
      expect(parseScenario(text).ok, text.slice(0, 60)).toBe(false);
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects documents over 64 MiB before parsing", () => {
    expectCode(parseScenario(" ".repeat(SCENARIO_LIMITS.maxDocumentBytes + 1)), "too_large");
    // Byte length, not UTF-16 length: 2-byte characters count twice.
    expect(utf8Length("é€😀a")).toBe(2 + 3 + 4 + 1);
  });

  it("rejects non-object documents", () => {
    for (const v of [null, 42, "x", [doc()]]) expect(parseScenarioValue(v).ok).toBe(false);
  });
});
