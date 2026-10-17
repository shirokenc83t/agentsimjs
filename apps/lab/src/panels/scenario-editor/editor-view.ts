import { POSE_STRIDE } from "@agentsim/core";
import { zonePolygon, type ZoneSpec } from "@agentsim/scenarios";
import { atlasScratch, ATLAS_BYTES_PER_CELL, encodeAtlasChunk } from "@agentsim/spatial";
import { ChunkQueue, StateInterpolator, type BeliefViewMode, type GridSpec, type SceneRenderer } from "@agentsim/ui";
import { agentIdsOf, type ScenarioDraft } from "./model.ts";

/** Chunks encoded per sync at most; a large first sync spreads over a few calls (the atlas uploads ≤ 16 per frame). */
const CHUNKS_PER_SYNC = 256;

/**
 * Feeds the editor's draft to a `SceneRenderer` the way the sim worker feeds a run (ADR-0027): dirty chunks as
 * atlas texels, zones as outlines, agents at their start poses. The draft is the editor's own grid, never the
 * running world. `sync()` is called after edits (pointer moves, form changes), not per frame.
 */
export class EditorView {
  /** Static agent poses: interpolation off, so the renderer shows exactly the pushed state. */
  readonly interpolator = new StateInterpolator();
  private queue: ChunkQueue | undefined;
  private sentVersion = -1;
  private scratch: ReturnType<typeof atlasScratch> | undefined;
  private draft: ScenarioDraft | undefined;
  private renderer: SceneRenderer | undefined;
  private shownZones: readonly ZoneSpec[] | undefined;
  private shownAgents: ScenarioDraft["agents"] | undefined;
  private shownObjects: ScenarioDraft["objects"] | undefined;
  /** The prior drawn over the world (its knowledge layer as the belief overlay), and how. */
  private prior: { id: string; mode: BeliefViewMode } | undefined;
  private priorQueue: ChunkQueue | undefined;
  /** A zone being drawn (shown, not yet in the draft). */
  private previewZone: ZoneSpec | undefined;

  constructor() {
    this.interpolator.setEnabled(false);
  }

  attach(renderer: SceneRenderer | undefined): void {
    this.renderer = renderer;
    if (renderer && this.draft) this.show(this.draft);
  }

  /** Shows a (new) draft: rebuilds the atlas, frames it top-down and uploads every chunk. */
  show(draft: ScenarioDraft): void {
    this.draft = draft;
    const g = draft.grid;
    this.queue = new ChunkQueue(g.chunksX);
    this.sentVersion = -1;
    this.scratch = atlasScratch(g.chunkSize);
    this.shownZones = undefined;
    this.shownAgents = undefined;
    this.shownObjects = undefined;
    const spec: GridSpec = { dims: { sizeX: g.sizeX, sizeY: g.sizeY, chunkSize: g.chunkSize, resolutionM: g.resolutionM }, zones: [], queue: this.queue };
    this.renderer?.setGrid(spec);
    this.renderer?.viewTopDown();
    this.priorQueue = undefined; // setGrid released the belief layer
    this.applyPrior(true);
    this.sync();
  }

  /**
   * Draws a prior of the draft over the world: `belief` shows what the prior knows, `difference` marks where it disagrees
   * with the world. Its knowledge layer feeds the same belief atlas the Scene uses (ADR-0027); `undefined` removes it.
   * The prior is never part of the world: painting it changes only its own layer (see `ScenarioDraft`).
   */
  showPrior(id: string | undefined, mode: BeliefViewMode = "belief"): void {
    const changedId = this.prior?.id !== id;
    this.prior = id === undefined ? undefined : { id, mode };
    this.applyPrior(changedId);
    this.sync();
  }

  private applyPrior(rebuild: boolean): void {
    const r = this.renderer;
    const d = this.draft;
    if (!r || !d) return;
    if (!this.prior || !d.priorKnowledge(this.prior.id)) {
      if (this.priorQueue || rebuild) r.setBeliefLayer(undefined);
      this.priorQueue = undefined;
      r.setBeliefMode("truth");
      return;
    }
    if (rebuild || !this.priorQueue) {
      this.priorQueue = new ChunkQueue(d.grid.chunksX);
      r.setBeliefLayer(this.priorQueue);
      this.feedPrior(true);
    }
    r.setBeliefMode(this.prior.mode);
  }

  /** Pushes the prior's changed chunks (all of them when `all`) as one byte per cell, the belief overlay's format. */
  private feedPrior(all: boolean): void {
    const d = this.draft;
    const id = this.prior?.id;
    if (!d || id === undefined || !this.priorQueue) return;
    const k = d.priorKnowledge(id);
    if (!k) return;
    const g = d.grid;
    const n = g.chunkSize;
    const chunks = d.drainPriorDirty(id, all);
    for (let start = 0; start < chunks.length; start += CHUNKS_PER_SYNC) {
      const batch = chunks.slice(start, start + CHUNKS_PER_SYNC);
      const coords = new Uint16Array(batch.length * 2);
      const data = new Uint8Array(batch.length * n * n);
      batch.forEach((c, m) => {
        const ci = c % g.chunksX;
        const cj = (c - ci) / g.chunksX;
        coords[m * 2] = ci;
        coords[m * 2 + 1] = cj;
        for (let lj = 0; lj < n; lj++) {
          const j = cj * n + lj;
          if (j >= g.sizeY) break;
          for (let li = 0; li < n; li++) {
            const i = ci * n + li;
            if (i >= g.sizeX) break;
            data[m * n * n + lj * n + li] = k[j * g.sizeX + i] ?? 0;
          }
        }
      });
      this.priorQueue.push(coords, data);
    }
  }

  setPreviewZone(z: ZoneSpec | undefined): void {
    this.previewZone = z;
    this.shownZones = undefined;
    this.sync();
  }

  /** Pushes what changed since the last sync: dirty chunks, zones, agents. */
  sync(): void {
    const d = this.draft;
    const r = this.renderer;
    if (!d || !r || !this.queue || !this.scratch) return;
    const g = d.grid;
    if (g.version !== this.sentVersion) {
      const changed = this.sentVersion < 0 ? Array.from({ length: g.chunksX * g.chunksY }, (_, k) => k) : g.chunksChangedSince(this.sentVersion);
      this.sentVersion = g.version;
      const bytes = g.chunkSize * g.chunkSize * ATLAS_BYTES_PER_CELL;
      for (let start = 0; start < changed.length; start += CHUNKS_PER_SYNC) {
        const batch = changed.slice(start, start + CHUNKS_PER_SYNC);
        const coords = new Uint16Array(batch.length * 2);
        const data = new Uint8Array(batch.length * bytes);
        batch.forEach((k, n) => {
          const ci = k % g.chunksX;
          const cj = (k - ci) / g.chunksX;
          coords[n * 2] = ci;
          coords[n * 2 + 1] = cj;
          encodeAtlasChunk(g, ci, cj, data.subarray(n * bytes, (n + 1) * bytes), this.scratch);
        });
        this.queue.push(coords, data);
      }
    }
    if (this.shownZones !== d.zones) {
      this.shownZones = d.zones;
      const zones = this.previewZone ? [...d.zones, this.previewZone] : d.zones;
      r.setZones(zones.map((z) => ({ id: z.id, kind: z.kind, polygon: zonePolygon(z).flat() })));
    }
    if (this.prior) this.feedPrior(false);
    if (this.shownAgents !== d.agents || this.shownObjects !== d.objects) {
      this.shownAgents = d.agents;
      this.shownObjects = d.objects;
      const poses = new Float32Array((d.agents.length + d.objects.length) * POSE_STRIDE);
      d.agents.forEach((a, k) => {
        poses[k * POSE_STRIDE] = a.start.xM;
        poses[k * POSE_STRIDE + 1] = a.start.yM;
        poses[k * POSE_STRIDE + 2] = a.kind === "uav" ? (a.start.zM ?? 0) : 0;
        poses[k * POSE_STRIDE + 3] = a.start.headingRad ?? 0;
      });
      // Objects are drawn after the agents, labelled with their ids (static entities).
      d.objects.forEach((o, k) => {
        const at = (d.agents.length + k) * POSE_STRIDE;
        poses[at] = o.position.xM;
        poses[at + 1] = o.position.yM;
        poses[at + 2] = 0;
        poses[at + 3] = 0;
      });
      this.interpolator.snapToNext();
      this.interpolator.push(poses, 0);
      r.setEntityIds([...agentIdsOf(d.agents), ...d.objects.map((o) => o.id)], [...d.agents.map((a) => a.kind === "uav"), ...d.objects.map(() => false)]);
    }
  }

  /** Atlas chunks still waiting for upload (e2e probe: the view is settled at 0). */
  get pendingChunks(): number {
    return this.queue?.size ?? 0;
  }
}
