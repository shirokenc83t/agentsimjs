import Type, { type Static } from "typebox";

/**
 * Scenario document v0 (ADR-0025): canonical JSON, validated right after parsing. Structural limits are
 * in the schema; cross-field rules (unique keys, chunk bounds, layer values, zone geometry, agent
 * placement) are checked by `validateScenario` with stable error codes.
 */
export const SCENARIO_SCHEMA_VERSION = 0;

export const SCENARIO_LIMITS = {
  maxDocumentBytes: 64 * 1024 * 1024,
  maxCellsPerSide: 8192,
  maxAgents: 1024,
  maxZones: 4096,
  maxPolygonVertices: 256,
  maxObjects: 4096,
  maxPriors: 8,
  /** Encoded (UTF-8 JSON) size of one prior; why in the ADR-0025 addition of 2026-10-09. */
  maxPriorBytes: 4 * 1024 * 1024,
  /** 8192² cells in 8 × 8 chunks. */
  maxChunksPerLayer: 1024 * 1024,
} as const;

const COORD = 1_000_000;
const Metres = (o: { description?: string } = {}) => Type.Number({ minimum: -COORD, maximum: COORD, ...o });
const Altitude = () => Type.Number({ minimum: 0, maximum: 10_000 });

export const ScenarioId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
export const AgentKey = Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });

const Fill = (max: number) => Type.Integer({ minimum: 0, maximum: max });
const LayerChunk = (max: number) =>
  Type.Union([
    Type.Object({ ci: Type.Integer({ minimum: 0, maximum: 1023 }), cj: Type.Integer({ minimum: 0, maximum: 1023 }), fill: Fill(max) }, { additionalProperties: false }),
    // RLE strings are bounded again by the decoder against the chunk size.
    Type.Object({ ci: Type.Integer({ minimum: 0, maximum: 1023 }), cj: Type.Integer({ minimum: 0, maximum: 1023 }), rle: Type.String({ minLength: 4, maxLength: 1_000_000 }) }, { additionalProperties: false }),
  ]);
const Layer = (max: number) =>
  Type.Object({ chunks: Type.Array(LayerChunk(max), { maxItems: SCENARIO_LIMITS.maxChunksPerLayer }) }, { additionalProperties: false });

export const WorldSpec = Type.Object(
  {
    resolutionM: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
    sizeCells: Type.Object(
      { x: Type.Integer({ minimum: 1, maximum: SCENARIO_LIMITS.maxCellsPerSide }), y: Type.Integer({ minimum: 1, maximum: SCENARIO_LIMITS.maxCellsPerSide }) },
      { additionalProperties: false },
    ),
    chunkSize: Type.Union([Type.Literal(8), Type.Literal(16), Type.Literal(32), Type.Literal(64), Type.Literal(128), Type.Literal(256)]),
    altitudeLimitsM: Type.Object({ min: Altitude(), max: Altitude() }, { additionalProperties: false }),
    /** Height of occupied cells with unknown height for aerial vehicles; absent = unlimited (ADR-0025 addition). */
    defaultObstacleHeightM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })),
    layers: Type.Object(
      {
        occupancy: Type.Optional(Layer(1)),
        terrainCost: Type.Optional(Layer(255)),
        heightDm: Type.Optional(Layer(65535)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const Point = Type.Tuple([Metres(), Metres()]);

export const ZoneSpec = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
    kind: Type.Union([Type.Literal("base"), Type.Literal("noFly"), Type.Literal("geofence")]),
    /** Exactly one of `rect` (axis-aligned shorthand) and `polygon`. */
    rect: Type.Optional(Type.Object({ x0: Metres(), y0: Metres(), x1: Metres(), y1: Metres() }, { additionalProperties: false })),
    polygon: Type.Optional(Type.Array(Point, { minItems: 3, maxItems: SCENARIO_LIMITS.maxPolygonVertices })),
    minAltM: Type.Optional(Altitude()),
    maxAltM: Type.Optional(Altitude()),
  },
  { additionalProperties: false },
);

const Battery = Type.Object(
  {
    capacityWh: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 })),
    /** State of charge at start, 0–1. */
    initialSoc: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    /** At or below this state of charge the critical-battery reflex returns the agent to base. */
    criticalSoc: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    /** Crossing this level downwards raises `batteryLow` (ADR-0005 addition); must be above `criticalSoc`. */
    lowSoc: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

/** Sensor parameters (ADR-0025 addition of 2026-10-09; the sensor model is the ADR-0012 addition). All optional but id and type. */
export const SensorId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });
const SensorCommon = {
  id: SensorId,
  rateHz: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
  rangeM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 500 })),
  /** Probability that a reading is lost (a sensor fault). */
  dropoutProbability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
};
const RangeSensorFields = {
  rays: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
  fovDeg: Type.Optional(Type.Number({ minimum: 1, maximum: 360 })),
  /** UGV: sensor height above the ground. */
  mountHeightM: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
  /** Vertical half-extent of the beam: its lower edge is the sensor altitude minus this. */
  beamHalfHeightM: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
  rangeSigmaM: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  /** Log-odds increments (magnitudes, ADR-0028 addition: [20, 40]). */
  logOddsHit: Type.Optional(Type.Integer({ minimum: 20, maximum: 40 })),
  logOddsMiss: Type.Optional(Type.Integer({ minimum: 20, maximum: 40 })),
};
export const SensorSpec = Type.Union([
  Type.Object({ type: Type.Literal("lidar"), ...SensorCommon, ...RangeSensorFields }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("proximity"), ...SensorCommon, ...RangeSensorFields }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("camera"),
      ...SensorCommon,
      fovDeg: Type.Optional(Type.Number({ minimum: 1, maximum: 360 })),
      /** UGV: height above the ground; UAV: height above the vehicle. */
      mountHeightM: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
      pDetect: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      positionSigmaM: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
    },
    { additionalProperties: false },
  ),
]);

const Sensors = { sensors: Type.Optional(Type.Array(SensorSpec, { maxItems: 16 })) };

/** Entity beliefs (ADR-0005 addition): an entity is `lost` after this long without an observation. */
const Beliefs = { beliefs: Type.Optional(Type.Object({ lostAfterS: Type.Optional(Type.Number({ minimum: 0.1, maximum: 60 })) }, { additionalProperties: false })) };

/** Consumption "proportional to motion and time" (ROADMAP F1). */
const Energy = Type.Object(
  {
    movingWhPerM: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
    idleW: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

const Compute = { onboardComputeExpansionsPerTick: Type.Optional(Type.Integer({ minimum: 100, maximum: 1_000_000 })) };

/** Body parameters are scenario-level defaults over the built-ins (ADR-0028 precedence); all optional. */
export const UavBody = Type.Object(
  {
    maxSpeedMps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    climbRateMps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 50 })),
    cruiseAltitudeM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })),
    clearanceM: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    footprintRadiusM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 50 })),
    battery: Type.Optional(Battery),
    energy: Type.Optional(Energy),
    ...Compute,
    ...Sensors,
    ...Beliefs,
  },
  { additionalProperties: false },
);

/** Ground drive parameters (ADR-0033); also overridable from the run configuration's `drive` section. */
export const DriveFields = {
  drive: Type.Optional(Type.Union([Type.Literal("differential"), Type.Literal("ackermann"), Type.Literal("forward-only")])),
  /** Ignored (always false) for forward-only. */
  reverseAllowed: Type.Optional(Type.Boolean()),
  maxReverseSpeedMps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 20 })),
  /** Differential only. */
  maxYawRateRadps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 20 })),
  /** Ackermann only: the minimum turning radius is wheelbaseM / tan(maxSteeringAngleRad). */
  wheelbaseM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 20 })),
  maxSteeringAngleRad: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1.4 })),
  maxSteeringRateRadps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 20 })),
};

export const UgvBody = Type.Object(
  {
    ...DriveFields,
    maxSpeedMps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 50 })),
    /** Forward-only drive only; differential is 0 and Ackermann derives it from the steering geometry. */
    turningRadiusM: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
    footprintRadiusM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 50 })),
    /** Extra mask inflation for path-tracking error (model parameter: changes paths). */
    trackingMarginM: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
    arrivalToleranceM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    lookaheadM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    battery: Type.Optional(Battery),
    energy: Type.Optional(Energy),
    ...Compute,
    ...Sensors,
    ...Beliefs,
  },
  { additionalProperties: false },
);

const Start = Type.Object(
  {
    xM: Metres(),
    yM: Metres(),
    /** UAV only: above the ground → starts airborne at this altitude; absent or on the ground → grounded. */
    zM: Type.Optional(Altitude()),
    /** Radians counter-clockwise from east. */
    headingRad: Type.Optional(Type.Number({ minimum: -7, maximum: 7 })),
  },
  { additionalProperties: false },
);

const Base = Type.Object({ xM: Metres(), yM: Metres() }, { additionalProperties: false });

export const AgentSpec = Type.Union([
  Type.Object(
    { kind: Type.Literal("uav"), key: Type.Optional(AgentKey), start: Start, base: Type.Optional(Base), body: Type.Optional(UavBody) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("ugv"), key: Type.Optional(AgentKey), start: Start, base: Type.Optional(Base), body: Type.Optional(UgvBody) },
    { additionalProperties: false },
  ),
]);

/**
 * A non-agent entity sensors can perceive (ADR-0025 addition of 2026-10-09): static in F2, not an obstacle.
 * Ids share the entity namespace with agents, so they may not take the agent-ID form.
 */
export const ObjectSpec = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    kind: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    position: Type.Object({ xM: Metres(), yM: Metres(), zM: Type.Optional(Altitude()) }, { additionalProperties: false }),
    /** A vertical cylinder. */
    size: Type.Object({ radiusM: Type.Number({ exclusiveMinimum: 0, maximum: 100 }), heightM: Type.Number({ exclusiveMinimum: 0, maximum: 100 }) }, { additionalProperties: false }),
    label: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

/**
 * A map an agent may start from (ADR-0025 addition of 2026-10-09), with the world's size and chunking. It may
 * differ from the world on purpose (stale or wrong maps). `knowledge`: 0 = unknown, 1 = free, 2 = occupied
 * (absent chunks are unknown); `heightDm` and `terrainCost` have the world layers' semantics and are read only
 * where `knowledge` is not 0.
 */
export const PriorSpec = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    confidence: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    layers: Type.Object(
      {
        knowledge: Layer(2),
        heightDm: Type.Optional(Layer(65535)),
        terrainCost: Type.Optional(Layer(255)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ScenarioDocument = Type.Object(
  {
    schemaVersion: Type.Literal(SCENARIO_SCHEMA_VERSION),
    id: ScenarioId,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    defaultSeed: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    world: WorldSpec,
    zones: Type.Array(ZoneSpec, { maxItems: SCENARIO_LIMITS.maxZones }),
    agents: Type.Array(AgentSpec, { maxItems: SCENARIO_LIMITS.maxAgents }),
    objects: Type.Optional(Type.Array(ObjectSpec, { maxItems: SCENARIO_LIMITS.maxObjects })),
    priors: Type.Optional(Type.Array(PriorSpec, { maxItems: SCENARIO_LIMITS.maxPriors })),
  },
  { additionalProperties: false },
);

export type ScenarioDocument = Static<typeof ScenarioDocument>;
export type WorldSpec = Static<typeof WorldSpec>;
export type ZoneSpec = Static<typeof ZoneSpec>;
export type AgentSpec = Static<typeof AgentSpec>;
export type UavBody = Static<typeof UavBody>;
export type UgvBody = Static<typeof UgvBody>;
export type SensorSpec = Static<typeof SensorSpec>;
export type ObjectSpec = Static<typeof ObjectSpec>;
export type PriorSpec = Static<typeof PriorSpec>;
export type LayerKey = keyof WorldSpec["layers"];
