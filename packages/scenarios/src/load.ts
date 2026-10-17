import { err, ok, type Result } from "@agentsim/core";
import { decodeChunkRle, GridSpace, OCCUPANCY_FREE, type LayerName, type PriorMap, type Zone } from "@agentsim/spatial";
import { resolveBody } from "./body-defaults.ts";
import { ugvBodyWarnings, type BodyWarning } from "./body-warnings.ts";
import { canonicalJson, hash32Hex } from "./canonical.ts";
import type { AgentSpec, PriorSpec, ScenarioDocument, UavBody, UgvBody } from "./schema.ts";
import { validateScenario, zonePolygon, type ScenarioError } from "./validate.ts";

const LAYER_LIMITS: Readonly<Record<LayerName, { max: number; bytes: 1 | 2 }>> = {
  occupancy: { max: 1, bytes: 1 },
  terrainCost: { max: 255, bytes: 1 },
  heightDm: { max: 65535, bytes: 2 },
};

export interface LoadedAgent {
  /** Per-run counter by kind, in document order (ADR-0015): `uav-001`, `ugv-001`, … */
  readonly id: string;
  readonly key?: string;
  readonly kind: "uav" | "ugv";
  readonly start: { readonly xM: number; readonly yM: number; readonly zM: number; readonly headingRad: number; readonly airborne: boolean };
  readonly base?: { readonly xM: number; readonly yM: number };
  /** Body parameters as authored (scenario-level defaults; precedence is resolved with the run config). */
  readonly body: UavBody | UgvBody;
}

/** A perceivable non-agent entity (ADR-0025 addition of 2026-10-09), with its defaults filled in. */
export interface LoadedObject {
  readonly id: string;
  readonly kind: string;
  readonly position: { readonly xM: number; readonly yM: number; readonly zM: number };
  readonly size: { readonly radiusM: number; readonly heightM: number };
  readonly label?: string;
}

export interface LoadedScenario {
  readonly document: ScenarioDocument;
  readonly grid: GridSpace;
  readonly agents: readonly LoadedAgent[];
  /** Static objects sensors can perceive, in document order. */
  readonly objects: readonly LoadedObject[];
  /** Non-blocking consistency warnings (stable codes), e.g. a look-ahead that cuts corners too much. */
  readonly warnings: readonly BodyWarning[];
  /** Prior maps, decoded, in document order (ADR-0025 addition of 2026-10-09). */
  readonly priors: readonly PriorMap[];
  /** Content hash of each prior by id, for `effectiveConfigHash`. */
  readonly priorHashes: Readonly<Record<string, string>>;
}

/** What run-configuration resolution needs from a scenario: the document and its agents' IDs, keys, kinds and bodies. */
export interface ScenarioAgentsView {
  /** Only the identity and default seed are needed, so a view can come from a loaded run without the document. */
  readonly document: Pick<ScenarioDocument, "id" | "defaultSeed">;
  readonly agents: readonly Pick<LoadedAgent, "id" | "key" | "kind" | "body">[];
  /**
   * Content hash of each of the scenario's prior maps by id (ADR-0025 addition of 2026-10-09): the ids that
   * `beliefs.init: { prior }` may name, and what `effectiveConfigHash` records of the chosen one.
   */
  readonly priorHashes?: Readonly<Record<string, string>>;
}

/** Content hash of a prior as authored (its canonical JSON): changes whenever any of its data changes. */
export function priorContentHash(p: PriorSpec): string {
  return hash32Hex(canonicalJson(p));
}

function priorHashesOf(doc: ScenarioDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of doc.priors ?? []) out[p.id] = priorContentHash(p);
  return out;
}

/** Agent IDs in document order, one counter per kind (ADR-0015); the single rule `loadScenario` uses too. */
function agentIds(doc: ScenarioDocument): string[] {
  const counters = new Map<string, number>();
  return doc.agents.map((a) => {
    const n = (counters.get(a.kind) ?? 0) + 1;
    counters.set(a.kind, n);
    return formatAgentId(a.kind, n);
  });
}

/**
 * The agents of a validated document without building the world (no layer decoding): enough to resolve and
 * validate run configurations in the UI while editing (ADR-0028). IDs are the ones `loadScenario` assigns.
 */
export function scenarioAgents(doc: ScenarioDocument): ScenarioAgentsView {
  const ids = agentIds(doc);
  return {
    document: doc,
    agents: doc.agents.map((a, k) => ({ id: ids[k] ?? "", ...(a.key === undefined ? {} : { key: a.key }), kind: a.kind, body: a.body ?? {} })),
    priorHashes: priorHashesOf(doc),
  };
}

/** Agent ID for the n-th agent (1-based) of a kind. */
export function formatAgentId(kind: string, n: number): string {
  return `${kind}-${String(n).padStart(3, "0")}`;
}

/**
 * Builds the ground-truth world from a validated document: decodes every layer chunk (bounds-checked,
 * untrusted), applies zones and limits, checks that agents start in free space, and assigns agent IDs.
 * Deterministic: the result depends only on the document.
 */
export function loadScenario(doc: ScenarioDocument): Result<LoadedScenario, ScenarioError> {
  const v = validateScenario(doc);
  if (!v.ok) return v;
  const w = doc.world;
  const zones: Zone[] = doc.zones.map((z) => ({
    id: z.id,
    kind: z.kind,
    polygon: zonePolygon(z),
    ...(z.minAltM === undefined ? {} : { minAltM: z.minAltM }),
    ...(z.maxAltM === undefined ? {} : { maxAltM: z.maxAltM }),
  }));
  const grid = new GridSpace({
    sizeX: w.sizeCells.x,
    sizeY: w.sizeCells.y,
    resolutionM: w.resolutionM,
    chunkSize: w.chunkSize,
    altitudeLimitsM: w.altitudeLimitsM,
    zones,
    ...(w.defaultObstacleHeightM === undefined ? {} : { defaultObstacleHeightM: w.defaultObstacleHeightM }),
  });
  const cells = w.chunkSize * w.chunkSize;
  for (const name of ["occupancy", "terrainCost", "heightDm"] as const) {
    const lim = LAYER_LIMITS[name];
    const chunks = w.layers[name]?.chunks ?? [];
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      if (!c) continue;
      const path = `/world/layers/${name}/chunks/${k}`;
      if ("fill" in c) {
        grid.fillChunk(name, c.ci, c.cj, c.fill);
        continue;
      }
      const d = decodeChunkRle(c.rle, cells, lim.bytes);
      if (!d.ok) return err({ code: "layer_decode_failed", message: `${name} chunk (${c.ci}, ${c.cj}): ${d.error.code}: ${d.error.message}`, path });
      for (let i = 0; i < d.value.length; i++) {
        if ((d.value[i] ?? 0) > lim.max) return err({ code: "layer_value_out_of_range", message: `${name} values must be ≤ ${lim.max}`, path });
      }
      grid.setChunk(name, c.ci, c.cj, d.value);
    }
  }

  const ids = agentIds(doc);
  const agents: LoadedAgent[] = [];
  for (let k = 0; k < doc.agents.length; k++) {
    const a = doc.agents[k];
    if (!a) continue;
    const placed = placeAgent(grid, a);
    if (!placed.ok) return err({ ...placed.error, path: `/agents/${k}/start` });
    agents.push({
      id: ids[k] ?? "",
      ...(a.key === undefined ? {} : { key: a.key }),
      kind: a.kind,
      start: placed.value,
      ...(a.base === undefined ? {} : { base: { xM: a.base.xM, yM: a.base.yM } }),
      body: a.body ?? {},
    });
  }
  const warnings: BodyWarning[] = [];
  doc.agents.forEach((a, k) => {
    if (a.kind === "ugv") warnings.push(...ugvBodyWarnings(resolveBody("ugv", a.body ?? {}), `/agents/${k}/body`));
  });
  const objects: LoadedObject[] = (doc.objects ?? []).map((o) => ({
    id: o.id,
    kind: o.kind,
    position: { xM: o.position.xM, yM: o.position.yM, zM: o.position.zM ?? 0 },
    size: { radiusM: o.size.radiusM, heightM: o.size.heightM },
    ...(o.label === undefined ? {} : { label: o.label }),
  }));
  const priors: PriorMap[] = [];
  for (const [k, p] of (doc.priors ?? []).entries()) {
    const decoded = decodePrior(doc, p, `/priors/${k}`);
    if (!decoded.ok) return decoded;
    priors.push(decoded.value);
  }
  return ok({ document: doc, grid, agents, objects, warnings, priors, priorHashes: priorHashesOf(doc) });
}

const PRIOR_LAYER_LIMITS = {
  knowledge: { max: 2, bytes: 1 },
  heightDm: { max: 65535, bytes: 2 },
  terrainCost: { max: 255, bytes: 1 },
} as const;

/** Decodes a prior's layers into dense row-major arrays (untrusted: RLE bounds and values are checked). */
export function decodePrior(doc: ScenarioDocument, p: PriorSpec, path: string): Result<PriorMap, ScenarioError> {
  const w = doc.world;
  const sizeX = w.sizeCells.x;
  const sizeY = w.sizeCells.y;
  const cs = w.chunkSize;
  const n = sizeX * sizeY;
  const knowledge = new Uint8Array(n);
  const heightDm = p.layers.heightDm ? new Uint16Array(n) : undefined;
  // Absent terrain chunks take the world layer's default (nominal).
  const terrainCost = p.layers.terrainCost ? new Uint8Array(n).fill(10) : undefined;
  for (const [name, target] of [
    ["knowledge", knowledge],
    ["heightDm", heightDm],
    ["terrainCost", terrainCost],
  ] as const) {
    if (!target) continue;
    const lim = PRIOR_LAYER_LIMITS[name];
    for (const [m, c] of (p.layers[name]?.chunks ?? []).entries()) {
      const cpath = `${path}/layers/${name}/chunks/${m}`;
      let values: ArrayLike<number> | number;
      if ("fill" in c) values = c.fill;
      else {
        const d = decodeChunkRle(c.rle, cs * cs, lim.bytes);
        if (!d.ok) return err({ code: "layer_decode_failed", message: `prior "${p.id}" ${name} chunk (${c.ci}, ${c.cj}): ${d.error.code}: ${d.error.message}`, path: cpath });
        for (let i = 0; i < d.value.length; i++) {
          if ((d.value[i] ?? 0) > lim.max) return err({ code: "layer_value_out_of_range", message: `prior ${name} values must be ≤ ${lim.max}`, path: cpath });
        }
        values = d.value;
      }
      // Cells of an edge chunk beyond the map are dropped.
      for (let lj = 0; lj < cs; lj++) {
        const j = c.cj * cs + lj;
        if (j >= sizeY) break;
        for (let li = 0; li < cs; li++) {
          const i = c.ci * cs + li;
          if (i >= sizeX) break;
          target[j * sizeX + i] = typeof values === "number" ? values : (values[lj * cs + li] ?? 0);
        }
      }
    }
  }
  return ok({ id: p.id, sizeX, sizeY, confidence: p.confidence, knowledge, heightDm, terrainCost });
}

function placeAgent(grid: GridSpace, a: AgentSpec): Result<LoadedAgent["start"], ScenarioError> {
  const { xM, yM } = a.start;
  const headingRad = a.start.headingRad ?? 0;
  const i = grid.cellI(xM);
  const j = grid.cellJ(yM);
  const ground = grid.groundHeightM(i, j);
  if (a.kind === "ugv") {
    if (!grid.isFreeForGround(xM, yM)) return err({ code: "agent_start_blocked", message: "ground vehicle starts on an occupied, impassable or out-of-geofence cell" });
    return ok({ xM, yM, zM: ground, headingRad, airborne: false });
  }
  const z = a.start.zM ?? 0;
  if (z > ground) {
    if (!grid.isFreeForAir(xM, yM, z)) return err({ code: "agent_start_blocked", message: "UAV starts inside an obstacle, a no-fly volume or outside the airspace" });
    return ok({ xM, yM, zM: z, headingRad, airborne: true });
  }
  // Grounded UAV: the cell below must not be occupied.
  if (grid.occupancy.get(i, j) !== OCCUPANCY_FREE || grid.zones.outsideGeofence(xM, yM)) {
    return err({ code: "agent_start_blocked", message: "grounded UAV starts on an occupied or out-of-geofence cell" });
  }
  return ok({ xM, yM, zM: ground, headingRad, airborne: false });
}
