import type { GridSpace, LayerName } from "@agentsim/spatial";
import {
  decodePrior,
  encodePriorKnowledge,
  loadScenario,
  scenarioFromGrid,
  SCENARIO_LIMITS,
  SCENARIO_SCHEMA_VERSION,
  validateScenario,
  type AgentSpec,
  type ObjectSpec,
  type PriorSpec,
  type ScenarioDocument,
  type ScenarioError,
  type ZoneSpec,
} from "@agentsim/scenarios";

/**
 * Scenario editor model (F1 e7, ADR-0025): a draft of one scenario document. The grid layers live in a
 * `GridSpace` owned by the editor (never the running world); zones, agents and metadata are plain document
 * values. `toDocument()` encodes the draft with the same encoder as presets, and saving always creates a new
 * version through the storage port.
 */

export type PaintLayer = LayerName;

export interface Brush {
  readonly layer: PaintLayer;
  /** Raw layer value: occupancy 0/1, terrain cost 0–255, height in decimetres 0–65535. */
  readonly value: number;
  /** Disc radius in cells (0 = one cell). */
  readonly radiusCells: number;
}

export const LAYER_MAX: Readonly<Record<PaintLayer, number>> = { occupancy: 1, terrainCost: 255, heightDm: 65535 };

/** Undo record of one stroke: the cells it changed and their previous values. */
interface StrokeUndo {
  readonly layer: PaintLayer;
  readonly cells: number[];
  readonly old: number[];
}

const MAX_UNDO = 50;

/** What a prior brush writes into a prior's knowledge layer; `flip` swaps free and occupied (stale-map errors). */
export type PriorBrushValue = "unknown" | "free" | "occupied" | "flip";
const KNOWLEDGE: Readonly<Record<Exclude<PriorBrushValue, "flip">, number>> = { unknown: 0, free: 1, occupied: 2 };

export interface PriorBrush {
  readonly value: PriorBrushValue;
  /** Disc radius in cells (0 = one cell). */
  readonly radiusCells: number;
}

/** A prior being edited: its dense knowledge layer, the chunks changed since the view last looked, and undo. */
interface PriorEdit {
  readonly knowledge: Uint8Array;
  readonly dirty: Set<number>;
  edited: boolean;
  undo: { cells: number[]; old: number[] }[];
  stroke: { cells: number[]; old: number[]; seen: Set<number>; lastX: number; lastY: number } | undefined;
}

export interface PriorSummary {
  readonly id: string;
  readonly description: string | undefined;
  readonly confidence: number;
  /** Cells the prior has an opinion about, % of the map. */
  readonly knownPct: number;
  /** Of those, % that disagree with the world (free vs blocked). */
  readonly wrongPct: number;
  /** Changed in this draft (its encoding is rewritten on save). */
  readonly edited: boolean;
}

export interface DraftMeta {
  readonly id: string;
  readonly name: string;
  readonly defaultSeed: number;
}

export interface NewScenarioSpec extends DraftMeta {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: 8 | 16 | 32 | 64 | 128 | 256;
}

/** Agent IDs as the loader assigns them (ADR-0015): per-kind counters in document order. */
export function agentIdsOf(agents: readonly AgentSpec[]): string[] {
  const n = { uav: 0, ugv: 0 };
  return agents.map((a) => `${a.kind}-${String(++n[a.kind]).padStart(3, "0")}`);
}

export class ScenarioDraft {
  private undoStack: StrokeUndo[] = [];
  private stroke: { undo: StrokeUndo; seen: Set<number>; lastX: number; lastY: number } | undefined;
  /** Bumped on every change (React re-renders on it). */
  revision = 0;

  private constructor(
    public meta: DraftMeta,
    readonly grid: GridSpace,
    public zones: readonly ZoneSpec[],
    public agents: readonly AgentSpec[],
    /** Scenario objects and prior maps (ADR-0025 additions): carried through unchanged unless edited here. */
    public objects: readonly ObjectSpec[] = [],
    public priors: readonly PriorSpec[] = [],
  ) {}

  private readonly priorEdits = new Map<string, PriorEdit>();

  /** A draft of a stored or imported document; the document is validated and decoded by the loader. */
  static fromDocument(doc: ScenarioDocument): { ok: true; value: ScenarioDraft } | { ok: false; error: ScenarioError } {
    const r = loadScenario(doc);
    if (!r.ok) return r;
    return { ok: true, value: new ScenarioDraft({ id: doc.id, name: doc.name, defaultSeed: doc.defaultSeed }, r.value.grid, doc.zones, doc.agents, doc.objects ?? [], doc.priors ?? []) };
  }

  /** An empty world (all free, nominal terrain, height 0) with no zones and no agents. */
  static blank(spec: NewScenarioSpec): ScenarioDraft {
    const doc: ScenarioDocument = {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      id: spec.id,
      name: spec.name,
      defaultSeed: spec.defaultSeed,
      world: { resolutionM: spec.resolutionM, sizeCells: { x: spec.sizeX, y: spec.sizeY }, chunkSize: spec.chunkSize, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
      zones: [],
      agents: [],
    };
    const r = ScenarioDraft.fromDocument(doc);
    if (!r.ok) throw new Error(`blank scenario: ${r.error.code}: ${r.error.message}`);
    return r.value;
  }

  get resolutionM(): number {
    return this.grid.resolutionM;
  }

  private changed(): void {
    this.revision++;
  }

  // ---- painting ------------------------------------------------------------------------------------

  /** Starts a stroke at a point (metres) and paints the first disc. Returns the number of changed cells. */
  beginStroke(xM: number, yM: number, brush: Brush): number {
    this.stroke = { undo: { layer: brush.layer, cells: [], old: [] }, seen: new Set(), lastX: xM, lastY: yM };
    return this.stamp(xM, yM, brush);
  }

  /**
   * Continues the stroke to a point: discs are stamped along the segment from the previous point at most half a
   * cell apart, so a fast drag leaves no gaps.
   */
  extendStroke(xM: number, yM: number, brush: Brush): number {
    const s = this.stroke;
    if (!s) return this.beginStroke(xM, yM, brush);
    const res = this.grid.resolutionM;
    const d = Math.hypot(xM - s.lastX, yM - s.lastY);
    const steps = Math.max(1, Math.ceil(d / (res * 0.5)));
    let n = 0;
    for (let k = 1; k <= steps; k++) n += this.stamp(s.lastX + ((xM - s.lastX) * k) / steps, s.lastY + ((yM - s.lastY) * k) / steps, brush);
    s.lastX = xM;
    s.lastY = yM;
    return n;
  }

  /** Ends the stroke; a stroke that changed cells becomes one undo step. */
  endStroke(): void {
    const s = this.stroke;
    this.stroke = undefined;
    if (!s || s.undo.cells.length === 0) return;
    this.undoStack.push(s.undo);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  /** Paints one disc of `radiusCells` around the cell containing the point; cells outside the grid are skipped. */
  private stamp(xM: number, yM: number, brush: Brush): number {
    const g = this.grid;
    const ci = Math.floor(xM / g.resolutionM);
    const cj = Math.floor(yM / g.resolutionM);
    const r = Math.max(0, Math.floor(brush.radiusCells));
    const v = Math.max(0, Math.min(LAYER_MAX[brush.layer], Math.round(brush.value)));
    const layer = brush.layer === "occupancy" ? g.occupancy : brush.layer === "terrainCost" ? g.terrainCost : g.heightDm;
    let changed = 0;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (!g.inBounds(i, j) || (i - ci) * (i - ci) + (j - cj) * (j - cj) > r * r) continue;
        const idx = j * g.sizeX + i;
        const old = layer.get(i, j);
        if (old === v) continue;
        const s = this.stroke;
        if (s && !s.seen.has(idx)) {
          s.seen.add(idx);
          s.undo.cells.push(idx);
          s.undo.old.push(old);
        }
        g.setCell(brush.layer, i, j, v);
        changed++;
      }
    }
    if (changed > 0) this.changed();
    return changed;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Reverts the last stroke. */
  undo(): boolean {
    const u = this.undoStack.pop();
    if (!u) return false;
    const sx = this.grid.sizeX;
    for (let k = u.cells.length - 1; k >= 0; k--) {
      const idx = u.cells[k] ?? 0;
      this.grid.setCell(u.layer, idx % sx, (idx / sx) | 0, u.old[k] ?? 0);
    }
    this.changed();
    return true;
  }

  // ---- zones and agents ----------------------------------------------------------------------------

  setMeta(meta: Partial<DraftMeta>): void {
    this.meta = { ...this.meta, ...meta };
    this.changed();
  }

  /** Adds an axis-aligned zone (corners in any order) with a fresh ID like `geofence-2`. */
  addRectZone(kind: ZoneSpec["kind"], x0: number, y0: number, x1: number, y1: number): ZoneSpec {
    const prefix = kind === "noFly" ? "nofly" : kind;
    const taken = new Set(this.zones.map((z) => z.id));
    let n = 1;
    while (taken.has(`${prefix}-${n}`)) n++;
    const z: ZoneSpec = { id: `${prefix}-${n}`, kind, rect: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) } };
    this.zones = [...this.zones, z];
    this.changed();
    return z;
  }

  updateZone(index: number, zone: ZoneSpec): void {
    this.zones = this.zones.map((z, k) => (k === index ? zone : z));
    this.changed();
  }

  deleteZone(index: number): void {
    this.zones = this.zones.filter((_, k) => k !== index);
    this.changed();
  }

  /** Places a new agent with a fresh key (`ugv-2`, …) and the scenario's first base zone centre as its base. */
  addAgent(kind: AgentSpec["kind"], xM: number, yM: number): number {
    const taken = new Set(this.agents.flatMap((a) => (a.key === undefined ? [] : [a.key])));
    let n = 1;
    while (taken.has(`${kind}-${n}`)) n++;
    const base = this.zones.find((z) => z.kind === "base")?.rect;
    const agent = {
      kind,
      key: `${kind}-${n}`,
      start: { xM: round2(xM), yM: round2(yM) },
      ...(base ? { base: { xM: round2((base.x0 + base.x1) / 2), yM: round2((base.y0 + base.y1) / 2) } } : {}),
    } as AgentSpec;
    this.agents = [...this.agents, agent];
    this.changed();
    return this.agents.length - 1;
  }

  moveAgent(index: number, xM: number, yM: number): void {
    this.updateAgent(index, (a) => ({ ...a, start: { ...a.start, xM: round2(xM), yM: round2(yM) } }) as AgentSpec);
  }

  updateAgent(index: number, f: (a: AgentSpec) => AgentSpec): void {
    this.agents = this.agents.map((a, k) => (k === index ? f(a) : a));
    this.changed();
  }

  deleteAgent(index: number): void {
    this.agents = this.agents.filter((_, k) => k !== index);
    this.changed();
  }

  /** Index of the agent whose start is nearest to the point within `withinM`, or -1. */
  agentNear(xM: number, yM: number, withinM: number): number {
    let best = -1;
    let bestD = withinM;
    this.agents.forEach((a, k) => {
      const d = Math.hypot(a.start.xM - xM, a.start.yM - yM);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  }

  // ---- document --------------------------------------------------------------------------------------

  // ---- objects -----------------------------------------------------------------------------------------

  /** Places an object with a fresh ID (`marker-1`, ...); size and height are sensible defaults to edit. */
  addObject(xM: number, yM: number, kind = "marker"): number {
    const taken = new Set(this.objects.map((o) => o.id));
    let n = 1;
    while (taken.has(`${kind}-${n}`)) n++;
    this.objects = [...this.objects, { id: `${kind}-${n}`, kind, position: { xM: round2(xM), yM: round2(yM) }, size: { radiusM: 0.4, heightM: 1.2 } }];
    this.changed();
    return this.objects.length - 1;
  }

  moveObject(index: number, xM: number, yM: number): void {
    this.updateObject(index, (o) => ({ ...o, position: { ...o.position, xM: round2(xM), yM: round2(yM) } }));
  }

  updateObject(index: number, f: (o: ObjectSpec) => ObjectSpec): void {
    this.objects = this.objects.map((o, k) => (k === index ? f(o) : o));
    this.changed();
  }

  deleteObject(index: number): void {
    this.objects = this.objects.filter((_, k) => k !== index);
    this.changed();
  }

  /** Index of the object nearest to the point within `withinM`, or -1. */
  objectNear(xM: number, yM: number, withinM: number): number {
    let best = -1;
    let bestD = withinM;
    this.objects.forEach((o, k) => {
      const d = Math.hypot(o.position.xM - xM, o.position.yM - yM);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  }

  // ---- priors (ADR-0025 addition of 2026-10-09) -----------------------------------------------------------
  // Prior brushes write the prior's knowledge layer only: the world's grid is never touched.

  /** The prior's dense knowledge layer (row-major; 0 unknown, 1 free, 2 occupied), decoded on first use. */
  private priorEdit(id: string): PriorEdit | undefined {
    const have = this.priorEdits.get(id);
    if (have) return have;
    const p = this.priors.find((x) => x.id === id);
    if (!p) return undefined;
    const g = this.grid;
    const stub = { world: { sizeCells: { x: g.sizeX, y: g.sizeY }, chunkSize: g.chunkSize } } as unknown as ScenarioDocument;
    const d = decodePrior(stub, p, `/priors/${id}`);
    if (!d.ok) return undefined;
    const e: PriorEdit = { knowledge: d.value.knowledge, dirty: new Set(), edited: false, undo: [], stroke: undefined };
    this.priorEdits.set(id, e);
    return e;
  }

  /** The prior's knowledge layer for display (never modified by the caller). */
  priorKnowledge(id: string): Uint8Array | undefined {
    return this.priorEdit(id)?.knowledge;
  }

  /** Chunk indices of the prior's knowledge changed since the last call (`all`: every chunk, for a first look). */
  drainPriorDirty(id: string, all = false): number[] {
    const e = this.priorEdit(id);
    if (!e) return [];
    const g = this.grid;
    if (all) {
      e.dirty.clear();
      return Array.from({ length: g.chunksX * g.chunksY }, (_, k) => k);
    }
    const out = [...e.dirty].sort((a, b) => a - b);
    e.dirty.clear();
    return out;
  }

  priorSummaries(): PriorSummary[] {
    const g = this.grid;
    const n = g.sizeX * g.sizeY;
    return this.priors.map((p) => {
      const k = this.priorEdit(p.id)?.knowledge;
      let known = 0;
      let wrong = 0;
      if (k) {
        for (let j = 0; j < g.sizeY; j++) {
          for (let i = 0; i < g.sizeX; i++) {
            const v = k[j * g.sizeX + i] ?? 0;
            if (v === 0) continue;
            known++;
            if ((v === 2) !== g.isBlocked(i, j)) wrong++;
          }
        }
      }
      return { id: p.id, description: p.description, confidence: p.confidence, knownPct: n === 0 ? 0 : (100 * known) / n, wrongPct: known === 0 ? 0 : (100 * wrong) / known, edited: this.priorEdits.get(p.id)?.edited ?? false };
    });
  }

  /** A new prior that knows the whole world as it is now (free / occupied); edit it afterwards (hide, flip). */
  createPriorFromWorld(id: string, confidence: number, description?: string): { ok: true } | { ok: false; code: string; message: string } {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return { ok: false, code: "invalid_id", message: "a prior id is lowercase letters, digits and hyphens, starting with a letter (at most 32)" };
    if (this.priors.some((p) => p.id === id)) return { ok: false, code: "prior_id_duplicate", message: `prior id "${id}" is used twice` };
    if (this.priors.length >= SCENARIO_LIMITS.maxPriors) return { ok: false, code: "too_many_priors", message: `a scenario holds at most ${SCENARIO_LIMITS.maxPriors} priors` };
    if (!(confidence > 0 && confidence <= 1)) return { ok: false, code: "invalid_confidence", message: "confidence is in (0, 1]" };
    const g = this.grid;
    const knowledge = new Uint8Array(g.sizeX * g.sizeY);
    for (let j = 0; j < g.sizeY; j++) for (let i = 0; i < g.sizeX; i++) knowledge[j * g.sizeX + i] = g.isBlocked(i, j) ? 2 : 1;
    this.priors = [...this.priors, { id, confidence, ...(description ? { description } : {}), layers: { knowledge: { chunks: [] } } }];
    this.priorEdits.set(id, { knowledge, dirty: new Set(), edited: true, undo: [], stroke: undefined });
    this.changed();
    return { ok: true };
  }

  updatePrior(id: string, patch: { confidence?: number; description?: string }): void {
    this.priors = this.priors.map((p) => (p.id === id ? ({ ...p, ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }), ...(patch.description === undefined ? {} : { description: patch.description }) } as PriorSpec) : p));
    this.changed();
  }

  deletePrior(id: string): void {
    this.priors = this.priors.filter((p) => p.id !== id);
    this.priorEdits.delete(id);
    this.changed();
  }

  /** Starts a prior stroke (metres) and paints the first disc; returns the number of changed cells. */
  beginPriorStroke(id: string, xM: number, yM: number, brush: PriorBrush): number {
    const e = this.priorEdit(id);
    if (!e) return 0;
    e.stroke = { cells: [], old: [], seen: new Set(), lastX: xM, lastY: yM };
    return this.stampPrior(e, xM, yM, brush);
  }

  extendPriorStroke(id: string, xM: number, yM: number, brush: PriorBrush): number {
    const e = this.priorEdit(id);
    if (!e) return 0;
    const s = e.stroke;
    if (!s) return this.beginPriorStroke(id, xM, yM, brush);
    const d = Math.hypot(xM - s.lastX, yM - s.lastY);
    const steps = Math.max(1, Math.ceil(d / (this.grid.resolutionM * 0.5)));
    let n = 0;
    for (let k = 1; k <= steps; k++) n += this.stampPrior(e, s.lastX + ((xM - s.lastX) * k) / steps, s.lastY + ((yM - s.lastY) * k) / steps, brush);
    s.lastX = xM;
    s.lastY = yM;
    return n;
  }

  endPriorStroke(id: string): void {
    const e = this.priorEdits.get(id);
    if (!e) return;
    const s = e.stroke;
    e.stroke = undefined;
    if (!s || s.cells.length === 0) return;
    e.undo.push({ cells: s.cells, old: s.old });
    if (e.undo.length > MAX_UNDO) e.undo.shift();
  }

  canUndoPrior(id: string): boolean {
    return (this.priorEdits.get(id)?.undo.length ?? 0) > 0;
  }

  undoPrior(id: string): boolean {
    const e = this.priorEdits.get(id);
    const u = e?.undo.pop();
    if (!e || !u) return false;
    for (let k = u.cells.length - 1; k >= 0; k--) {
      const idx = u.cells[k] ?? 0;
      e.knowledge[idx] = u.old[k] ?? 0;
      e.dirty.add(this.chunkOfIndex(idx));
    }
    e.edited = true;
    this.changed();
    return true;
  }

  private chunkOfIndex(idx: number): number {
    const g = this.grid;
    const i = idx % g.sizeX;
    const j = (idx / g.sizeX) | 0;
    return Math.floor(j / g.chunkSize) * g.chunksX + Math.floor(i / g.chunkSize);
  }

  private stampPrior(e: PriorEdit, xM: number, yM: number, brush: PriorBrush): number {
    const g = this.grid;
    const ci = Math.floor(xM / g.resolutionM);
    const cj = Math.floor(yM / g.resolutionM);
    const r = Math.max(0, Math.floor(brush.radiusCells));
    let changed = 0;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (!g.inBounds(i, j) || (i - ci) * (i - ci) + (j - cj) * (j - cj) > r * r) continue;
        const idx = j * g.sizeX + i;
        const old = e.knowledge[idx] ?? 0;
        const v = brush.value === "flip" ? (old === 1 ? 2 : old === 2 ? 1 : 0) : KNOWLEDGE[brush.value];
        if (old === v) continue;
        const s = e.stroke;
        if (s && !s.seen.has(idx)) {
          s.seen.add(idx);
          s.cells.push(idx);
          s.old.push(old);
        }
        e.knowledge[idx] = v;
        e.dirty.add(this.chunkOfIndex(idx));
        e.edited = true;
        changed++;
      }
    }
    if (changed > 0) this.changed();
    return changed;
  }

  /** The priors as document values: an edited prior's knowledge layer is re-encoded, every other one passes through verbatim. */
  private encodedPriors(): PriorSpec[] {
    const g = this.grid;
    return this.priors.map((p) => {
      const e = this.priorEdits.get(p.id);
      if (!e?.edited) return p;
      return { ...p, layers: { ...p.layers, knowledge: { chunks: encodePriorKnowledge(g.sizeX, g.sizeY, g.chunkSize, e.knowledge) } } } as PriorSpec;
    });
  }

  /** The draft as a scenario document (deterministic encoding, ADR-0025). */
  toDocument(): ScenarioDocument {
    return scenarioFromGrid(this.meta, this.grid, this.zones, this.agents, { objects: this.objects, priors: this.encodedPriors() });
  }

  /**
   * Validation of what the editor edits besides the grid (ids, limits, sizes, prior encoding), cheap enough to run on
   * every change: the document with its layers left out, through the loader's own schema and rule checks, so each
   * problem carries the stable code the loader would answer with (`object_id_reserved`, `prior_too_large`, ...).
   */
  validateExtras(): { ok: true } | { ok: false; error: ScenarioError } {
    const g = this.grid;
    const doc: ScenarioDocument = {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      id: this.meta.id,
      name: this.meta.name,
      defaultSeed: this.meta.defaultSeed,
      world: { resolutionM: g.resolutionM, sizeCells: { x: g.sizeX, y: g.sizeY }, chunkSize: g.chunkSize as 8 | 16 | 32 | 64 | 128 | 256, altitudeLimitsM: { min: g.altitudeLimitsM.min, max: g.altitudeLimitsM.max }, layers: {} },
      zones: [...this.zones],
      agents: [...this.agents],
      ...(this.objects.length > 0 ? { objects: [...this.objects] } : {}),
      ...(this.priors.length > 0 ? { priors: this.encodedPriors() } : {}),
    };
    const r = validateScenario(doc);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Full validation as the simulator loads it (schema, layers, zones, agent placement), with stable codes. */
  validate(): { ok: true; document: ScenarioDocument } | { ok: false; error: ScenarioError } {
    const doc = this.toDocument();
    const r = loadScenario(doc);
    return r.ok ? { ok: true, document: doc } : { ok: false, error: r.error };
  }
}

/** Positions are stored to the centimetre (stable documents, readable diffs). */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
