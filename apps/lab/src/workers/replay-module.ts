import { decodeValue, err, ok, type Result } from "@agentsim/core";
import { checkBeliefManifest, loadScenario, parseScenarioValue } from "@agentsim/scenarios";
import {
  atlasScratch,
  ATLAS_BYTES_PER_CELL,
  BeliefMap,
  encodeAtlasChunk,
  groupGeometry,
  groupOfChunk,
  groupsNearest,
  type BeliefCellDelta,
  type BeliefGroup,
  type BeliefManifest,
} from "@agentsim/spatial";
import type { BeliefFrame, ReplayBelief, ReplayError, ReplayHandlers, ReplayView, ReplayWorld, StoragePorts } from "@agentsim/storage";

// The replay reads of the storage worker (ADR-0035 addition of 2026-10-17, item 9; ADR-0004 and ADR-0035 additions of 2026-10-18, second): rebuilt here,
// off the render path, from what a run stored. Loaded by the worker when the first replay asks for it, so none of this (the scenario and belief-map code)
// is in the worker's own chunk. A keyframe is a manifest and group sections: a read takes the groups nearest the view first, decoded groups are kept
// (a small LRU, shared by every keyframe that has the same group), and the neighbouring keyframes are read ahead while nothing else asks.

const FRAME_PAGE = 10_000;
/** Decoded groups kept, by size: about four fully observed 1 km² maps with heights. */
const CACHE_BYTES = 96 * 1024 * 1024;

const fail = (code: ReplayError["code"], message: string): Result<never, ReplayError> => err({ code, message });

// ---- decoded groups, kept ------------------------------------------------------------------------------------------------------------

const groupBytes = (g: BeliefGroup): number => g.chunks.reduce((n, c) => n + c.logOdds.byteLength + (c.knownMinDm?.byteLength ?? 0) + (c.knownMaxDm?.byteLength ?? 0), 0);

class GroupCache {
  private readonly entries = new Map<string, { readonly group: BeliefGroup; readonly bytes: number }>();
  private total = 0;
  hits = 0;
  misses = 0;

  get(key: string): BeliefGroup | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key); // most recently used goes last
    this.entries.set(key, e);
    return e.group;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  put(key: string, group: BeliefGroup): void {
    const bytes = groupBytes(group);
    if (bytes > CACHE_BYTES) return;
    const old = this.entries.get(key);
    if (old) this.total -= old.bytes;
    this.entries.delete(key);
    this.entries.set(key, { group, bytes });
    this.total += bytes;
    for (const [k, e] of this.entries) {
      if (this.total <= CACHE_BYTES) break;
      if (k === key) continue;
      this.entries.delete(k);
      this.total -= e.bytes;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
    this.hits = 0;
    this.misses = 0;
  }
}

const groupCache = new GroupCache();
const manifests = new Map<string, BeliefManifest>();
/** Bumped by every read: a read-ahead that started before it stops. */
let generation = 0;

/** What the keyframe cache holds (tests and diagnostics). */
export const replayCacheStats = () => ({ groups: groupCache.size, bytes: groupCache.bytes, hits: groupCache.hits, misses: groupCache.misses });
export const resetReplayCache = (): void => {
  groupCache.clear();
  manifests.clear();
  generation++;
};

async function manifestOf(ports: StoragePorts, runId: string, hash: string): Promise<BeliefManifest | undefined> {
  const key = `${runId}/${hash}`;
  const known = manifests.get(key);
  if (known) return known;
  const blob = await ports.snapshots.getBlob(runId, hash);
  if (!blob) return undefined;
  const manifest = checkBeliefManifest(decodeValue(blob.bytes));
  manifests.set(key, manifest);
  if (manifests.size > 64) manifests.delete(manifests.keys().next().value as string);
  return manifest;
}

/** A group's content: kept if it was read lately, else read (the blob is checked against its hash by the store) and decoded. */
async function groupOf(ports: StoragePorts, runId: string, hash: string, index: number): Promise<BeliefGroup | undefined> {
  const key = `${runId}/${hash}`;
  const kept = groupCache.get(key);
  if (kept) {
    groupCache.hits++;
    return kept;
  }
  groupCache.misses++;
  const blob = await ports.snapshots.getBlob(runId, hash);
  if (!blob) return undefined;
  const group = decodeValue(blob.bytes) as BeliefGroup;
  if (group?.index !== index || !Array.isArray(group.chunks)) throw new RangeError(`belief group ${index} (${hash}) is not the group its manifest names`);
  groupCache.put(key, group);
  return group;
}

const yieldToQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Reads the keyframes next to the one just used into the cache, nearest groups first, a group at a time so a request that arrives is served between them. */
async function readAhead(ports: StoragePorts, runId: string, agentId: string, keyframe: BeliefFrame, focus: { ci: number; cj: number } | undefined, mine: number): Promise<void> {
  try {
    const neighbours: (BeliefFrame | undefined)[] = [
      (await ports.beliefFrames.query({ runId, agentId, kind: "keyframe", fromTick: keyframe.tick + 1, limit: 1 }))[0],
      keyframe.tick > 0 ? await ports.beliefFrames.keyframeAtOrBefore(runId, agentId, keyframe.tick - 1) : undefined,
    ];
    for (const f of neighbours) {
      if (!f?.blobId || f.seq === keyframe.seq || generation !== mine) continue;
      const manifest = await manifestOf(ports, runId, f.blobId);
      if (!manifest) continue;
      const geo = groupGeometry(manifest.meta.sizeX, manifest.meta.sizeY, manifest.meta.chunkSize, manifest.groupChunks);
      const middle = { ci: Math.floor(geo.chunksX / 2), cj: Math.floor(geo.chunksY / 2) };
      const order = groupsNearest(geo, manifest.groups.map((g) => g.index), focus ?? middle);
      const byIndex = new Map(manifest.groups.map((g) => [g.index, g.hash]));
      for (const index of order) {
        const hash = byIndex.get(index) as string;
        if (groupCache.has(`${runId}/${hash}`)) continue;
        await yieldToQueue();
        if (generation !== mine) return;
        await groupOf(ports, runId, hash, index);
      }
    }
  } catch {
    // Reading ahead is a courtesy: a failure shows when the read is actually made.
  }
}

/**
 * An agent's belief map at `tick`: the last keyframe at or before it (its manifest and group sections), then the cell deltas after that keyframe up to the
 * tick. The bytes are the belief overlay's (`classifyChunk`, one byte per cell) for the chunks of the groups asked for (`view`: nearest to a focus first);
 * chunks the map never materialized are unknown and are left out, as the live stream leaves them out.
 */
export async function beliefAt(ports: StoragePorts, runId: string, agentId: string, tick: number, view: ReplayView = {}): Promise<Result<ReplayBelief, ReplayError>> {
  const mine = ++generation;
  const run = await ports.runs.get(runId);
  if (!run) return fail("unknown_run", `unknown run ${runId}`);
  if (run.recording !== "stored") return fail("not_recorded", `run ${runId} was not recorded`);
  const keyframe = await ports.beliefFrames.keyframeAtOrBefore(runId, agentId, tick);
  if (!keyframe?.blobId) {
    const any = await ports.beliefFrames.query({ runId, agentId, limit: 1 });
    return any.length > 0 ? fail("no_keyframe", `no keyframe of ${agentId} at or before tick ${tick}`) : fail("unknown_agent", `${agentId} has no belief frames in ${runId}`);
  }
  const t0 = performance.now();
  let manifest: BeliefManifest | undefined;
  try {
    manifest = await manifestOf(ports, runId, keyframe.blobId);
  } catch (e) {
    return fail("unsupported_recording", `the keyframe of ${agentId} is not a belief map manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!manifest) return fail("no_keyframe", `the keyframe manifest of ${agentId} is missing`);
  // The deltas after the keyframe, up to the tick.
  const deltas: { readonly frame: BeliefFrame; readonly delta: BeliefCellDelta }[] = [];
  let after = keyframe.seq;
  for (; !view.keyframeOnly; ) {
    const page: BeliefFrame[] = await ports.beliefFrames.query({ runId, agentId, kind: "delta", fromTick: keyframe.tick, toTick: tick, limit: FRAME_PAGE });
    let last = after;
    for (const f of page) {
      if (f.seq <= after) continue;
      deltas.push({ frame: f, delta: decodeValue(f.data ?? new Uint8Array()) as BeliefCellDelta });
      last = f.seq;
    }
    if (page.length < FRAME_PAGE || last === after) break;
    after = last;
  }
  const { meta } = manifest;
  const geo = groupGeometry(meta.sizeX, meta.sizeY, meta.chunkSize, manifest.groupChunks);
  // The groups the map has at this tick: the keyframe's, and any a delta made (a chunk first observed after the keyframe).
  const held = new Map(manifest.groups.map((g) => [g.index, g.hash]));
  const all = new Set(held.keys());
  for (const { frame } of deltas) for (const k of frame.chunks) all.add(groupOfChunk(geo, k));
  const order = groupsNearest(geo, [...all], view.focus ?? { ci: Math.floor(geo.chunksX / 2), cj: Math.floor(geo.chunksY / 2) });
  const from = Math.min(order.length, Math.max(0, view.skip ?? 0));
  const to = Math.min(order.length, view.limit === undefined ? order.length : from + Math.max(0, view.limit));
  const chosen = new Set(order.slice(from, to));
  const t1 = performance.now();
  const hits0 = groupCache.hits;
  const misses0 = groupCache.misses;
  const map = new BeliefMap(meta.sizeX, meta.sizeY, meta.chunkSize);
  for (const index of chosen) {
    const hash = held.get(index);
    if (hash === undefined) continue;
    const group = await groupOf(ports, runId, hash, index);
    if (!group) return fail("no_keyframe", `belief group ${index} of the keyframe of ${agentId} is missing`);
    map.applyChunks(group.chunks);
  }
  const t2 = performance.now();
  const inChosen = (k: number) => chosen.has(groupOfChunk(geo, k));
  for (const { delta } of deltas) map.applyCellDelta(delta, inChosen);
  const t3 = performance.now();
  const indices = map.materializedIndices();
  const n = map.chunkSize;
  const bytes = n * n;
  const coords = new Uint16Array(indices.length * 2);
  const data = new Uint8Array(indices.length * bytes);
  indices.forEach((k, i) => {
    const ci = k % map.chunksX;
    const cj = (k - ci) / map.chunksX;
    coords[i * 2] = ci;
    coords[i * 2 + 1] = cj;
    map.classifyChunk(ci, cj, data.subarray(i * bytes, (i + 1) * bytes));
  });
  const t4 = performance.now();
  // Reading ahead: the neighbouring keyframes, while nothing else asks (the next read bumps the generation and ends it).
  setTimeout(() => void readAhead(ports, runId, agentId, keyframe, view.focus, mine), 0);
  return ok({
    runId,
    agentId,
    tick,
    keyframeTick: keyframe.tick,
    deltasApplied: deltas.length,
    timingsMs: { blob: t2 - t1 + (t1 - t0), decode: 0, deltas: t3 - t2, classify: t4 - t3 },
    groups: { total: order.length, from, to, groupChunks: manifest.groupChunks, cached: groupCache.hits - hits0, read: groupCache.misses - misses0 },
    sizeX: map.sizeX,
    sizeY: map.sizeY,
    chunkSize: n,
    coords,
    data,
  });
}

/** The world a run was made in: its scenario version loaded here, so the main thread never parses a scenario (ADR-0019). */
export async function world(ports: StoragePorts, runId: string): Promise<Result<ReplayWorld, ReplayError>> {
  const run = await ports.runs.get(runId);
  if (!run) return fail("unknown_run", `unknown run ${runId}`);
  if (run.scenarioId === undefined) return fail("scenario_missing", `run ${runId} was not made from a stored scenario`);
  const stored = await ports.scenarios.get(run.scenarioId, run.scenarioVersion);
  if (!stored) return fail("scenario_missing", `scenario ${run.scenarioId} v${run.scenarioVersion ?? "?"} is not stored`);
  const parsed = parseScenarioValue(stored.document);
  if (!parsed.ok) return fail("scenario_invalid", parsed.error.message);
  const loaded = loadScenario(parsed.value);
  if (!loaded.ok) return fail("scenario_invalid", loaded.error.message);
  const g = loaded.value.grid;
  const count = g.chunksX * g.chunksY;
  const bytes = g.chunkSize * g.chunkSize * ATLAS_BYTES_PER_CELL;
  const scratch = atlasScratch(g.chunkSize);
  const coords = new Uint16Array(count * 2);
  const data = new Uint8Array(count * bytes);
  for (let k = 0; k < count; k++) {
    const ci = k % g.chunksX;
    const cj = (k - ci) / g.chunksX;
    coords[k * 2] = ci;
    coords[k * 2 + 1] = cj;
    encodeAtlasChunk(g, ci, cj, data.subarray(k * bytes, (k + 1) * bytes), scratch);
  }
  return ok({
    runId,
    sizeX: g.sizeX,
    sizeY: g.sizeY,
    resolutionM: g.resolutionM,
    chunkSize: g.chunkSize,
    ...(g.defaultObstacleHeightM === undefined ? {} : { defaultObstacleHeightM: g.defaultObstacleHeightM }),
    zones: g.zones.zones.map((z) => ({ id: z.id, kind: z.kind, polygon: z.polygon.flat() })),
    coords,
    data,
  });
}

/** The module's shape for the storage worker. */
export const handlers: ReplayHandlers = { beliefAt, world };
