import { decodeValue, err, ok, type Result } from "@agentsim/core";
import { loadScenario, parseScenarioValue } from "@agentsim/scenarios";
import { atlasScratch, ATLAS_BYTES_PER_CELL, BeliefMap, encodeAtlasChunk, type BeliefCellDelta, type BeliefMapSnapshot } from "@agentsim/spatial";
import type { BeliefFrame, ReplayBelief, ReplayError, ReplayHandlers, ReplayWorld, StoragePorts } from "@agentsim/storage";

// The replay reads of the storage worker (ADR-0035 addition of 2026-10-17, item 9): rebuilt here, off the render path, from what a run stored.
// Loaded by the worker when the first replay asks for it, so none of this (the scenario and belief-map code) is in the worker's own chunk.

const FRAME_PAGE = 10_000;

const fail = (code: ReplayError["code"], message: string): Result<never, ReplayError> => err({ code, message });

/**
 * An agent's belief map at `tick`: the last keyframe at or before it, then the cell deltas after that keyframe up to the tick. The bytes
 * are the belief overlay's (`classifyChunk`, one byte per cell) for every chunk the map has; chunks it never materialized are unknown and
 * are left out, as the live stream leaves them out.
 */
export async function beliefAt(ports: StoragePorts, runId: string, agentId: string, tick: number): Promise<Result<ReplayBelief, ReplayError>> {
  const run = await ports.runs.get(runId);
  if (!run) return fail("unknown_run", `unknown run ${runId}`);
  if (run.recording !== "stored") return fail("not_recorded", `run ${runId} was not recorded`);
  const keyframe = await ports.beliefFrames.keyframeAtOrBefore(runId, agentId, tick);
  if (!keyframe?.blobId) {
    const any = await ports.beliefFrames.query({ runId, agentId, limit: 1 });
    return any.length > 0 ? fail("no_keyframe", `no keyframe of ${agentId} at or before tick ${tick}`) : fail("unknown_agent", `${agentId} has no belief frames in ${runId}`);
  }
  const t0 = performance.now();
  const blob = await ports.snapshots.getBlob(runId, keyframe.blobId);
  const t1 = performance.now();
  if (!blob) return fail("no_keyframe", `the keyframe blob of ${agentId} is missing`);
  const snapshot = decodeValue(blob.bytes) as BeliefMapSnapshot;
  const map = new BeliefMap(snapshot.sizeX, snapshot.sizeY, snapshot.chunkSize);
  map.restore(snapshot);
  const t2 = performance.now();
  let applied = 0;
  let after = keyframe.seq;
  for (;;) {
    const page: BeliefFrame[] = await ports.beliefFrames.query({ runId, agentId, kind: "delta", fromTick: keyframe.tick, toTick: tick, limit: FRAME_PAGE });
    let last = after;
    for (const f of page) {
      if (f.seq <= after) continue;
      map.applyCellDelta(decodeValue(f.data ?? new Uint8Array()) as BeliefCellDelta);
      applied++;
      last = f.seq;
    }
    if (page.length < FRAME_PAGE || last === after) break;
    after = last;
  }
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
  return ok({ runId, agentId, tick, keyframeTick: keyframe.tick, deltasApplied: applied, timingsMs: { blob: t1 - t0, decode: t2 - t1, deltas: t3 - t2, classify: t4 - t3 }, sizeX: map.sizeX, sizeY: map.sizeY, chunkSize: n, coords, data });
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
