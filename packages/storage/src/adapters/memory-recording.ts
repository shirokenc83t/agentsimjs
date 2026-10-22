import { contentHash128Bytes, err, ok, readSnapshot } from "@agentsim/core";
import type { BeliefFrame, BeliefFrameStore, LoadedSnapshot, MetricStore, SizeEntry, SnapshotInfo, SnapshotStore, StoredBlob, StoredMetricSample } from "../ports.ts";
import { checkBlobs, checkFrameQuery, checkFrames, checkMetricQuery, checkMetricSamples, checkSnapshot, framesKeepOrder, metricsKeepOrder } from "../recording.ts";

// Snapshots, blobs and belief frames in memory: the same rules as the SQL adapter (recording-stores.ts), the same contract suite.

interface Stored {
  readonly info: Omit<SnapshotInfo, "bytes">;
  readonly bytes: Uint8Array;
}

const copy = (b: Uint8Array): Uint8Array => new Uint8Array(b);

function mapFor<V>(all: Map<string, Map<string, V>>, runId: string): Map<string, V> {
  const hit = all.get(runId);
  if (hit) return hit;
  const made = new Map<string, V>();
  all.set(runId, made);
  return made;
}

export function memoryRecordingStores(runExists: (runId: string) => boolean): {
  snapshots: SnapshotStore;
  beliefFrames: BeliefFrameStore;
  metrics: MetricStore;
  /** What the run holds here (blobs, snapshots, frames), for its sizes. */
  sizesOf(runId: string): { blobs: SizeEntry; snapshots: SizeEntry; beliefFrames: SizeEntry; metrics: SizeEntry };
  /** Drops everything of the run (deleting the run). */
  forget(runId: string): void;
} {
  const blobs = new Map<string, Map<string, Uint8Array>>();
  const snapshots = new Map<string, Map<string, Stored>>();
  const frames = new Map<string, BeliefFrame[]>();
  const metrics = new Map<string, StoredMetricSample[]>();
  const blobsOf = (runId: string) => mapFor(blobs, runId);
  const hasBlob = (runId: string, id: string) => blobs.get(runId)?.has(id) === true;
  const cloneFrame = (f: BeliefFrame): BeliefFrame => ({ ...f, chunks: [...f.chunks], ...(f.data === undefined ? {} : { data: copy(f.data) }) });

  const getBlob = (runId: string, id: string): StoredBlob | undefined => {
    const b = blobs.get(runId)?.get(id);
    return b && contentHash128Bytes(b) === id ? { id, bytes: copy(b) } : undefined;
  };

  const snapshotStore: SnapshotStore = {
    async putBlobs(runId, list) {
      if (!runExists(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
      const checked = checkBlobs(list);
      if (!checked.ok) return checked;
      const target = blobsOf(runId);
      for (const b of list) if (!target.has(b.id)) target.set(b.id, copy(b.bytes));
      return ok(undefined);
    },
    async getBlob(runId, id) {
      return getBlob(runId, id);
    },
    async write(runId, s) {
      if (!runExists(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
      const snap = checkSnapshot(s);
      if (!snap.ok) return snap;
      const given = s.blobs ?? [];
      const blobsOk = checkBlobs(given);
      if (!blobsOk.ok) return blobsOk;
      const givenIds = new Set(given.map((b) => b.id));
      for (const h of snap.value.external) {
        if (!givenIds.has(h) && !hasBlob(runId, h)) return err({ code: "missing_blob" as const, message: `the snapshot refers to section ${h}, which is not stored` });
      }
      const mine = mapFor(snapshots, runId);
      if (mine.has(snap.value.id)) return err({ code: "duplicate_snapshot" as const, message: `snapshot ${snap.value.id} is already stored` });
      const target = blobsOf(runId);
      for (const b of given) if (!target.has(b.id)) target.set(b.id, copy(b.bytes));
      mine.set(snap.value.id, { info: { id: snap.value.id, seq: s.seq, simTime: s.simTime, tick: s.tick }, bytes: copy(s.bytes) });
      return ok({ id: snap.value.id });
    },
    async list(runId): Promise<SnapshotInfo[]> {
      return [...(snapshots.get(runId)?.values() ?? [])]
        .map((s) => ({ ...s.info, bytes: s.bytes.length }))
        .sort((a, b) => a.tick - b.tick || a.seq - b.seq || (a.id < b.id ? -1 : 1));
    },
    async read(runId, id): Promise<LoadedSnapshot | undefined> {
      const s = snapshots.get(runId)?.get(id);
      if (!s) return undefined;
      const refs: StoredBlob[] = [];
      for (const sec of readSnapshot(s.bytes).sections) {
        if (sec.bytes !== undefined) continue;
        const b = getBlob(runId, sec.hash);
        if (b) refs.push(b);
      }
      return { ...s.info, bytes: s.bytes.length, container: copy(s.bytes), blobs: refs };
    },
  };

  const frameStore: BeliefFrameStore = {
    async append(runId, list) {
      if (!runExists(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
      const checked = checkFrames(list);
      if (!checked.ok) return checked;
      const stored = frames.get(runId) ?? [];
      for (const f of list) {
        if (f.blobId !== undefined && !hasBlob(runId, f.blobId)) return err({ code: "missing_blob" as const, message: `frame ${f.agentId}#${f.seq} refers to blob ${f.blobId}, which is not stored` });
        if (stored.some((x) => x.agentId === f.agentId && x.seq === f.seq)) return err({ code: "duplicate_frame" as const, message: `frame ${f.agentId}#${f.seq} is already stored` });
      }
      const last = (agentId: string) => {
        const mine = stored.filter((x) => x.agentId === agentId);
        const top = mine.reduce<BeliefFrame | undefined>((a, x) => (a === undefined || x.seq > a.seq ? x : a), undefined);
        return top ? { seq: top.seq, tick: top.tick } : undefined;
      };
      if (!framesKeepOrder(list, last)) return err({ code: "non_monotonic_frame" as const, message: "frames would break seq/tick order" });
      frames.set(runId, [...stored, ...list.map(cloneFrame)]);
      return ok(undefined);
    },
    async query(q) {
      const c = checkFrameQuery(q);
      return (frames.get(c.runId) ?? [])
        .filter((f) => (c.agentId === undefined || f.agentId === c.agentId) && (c.fromTick === undefined || f.tick >= c.fromTick) && (c.toTick === undefined || f.tick <= c.toTick) && (c.kind === undefined || f.kind === c.kind))
        .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : a.seq - b.seq))
        .slice(0, c.limit)
        .map(cloneFrame);
    },
    async keyframeAtOrBefore(runId, agentId, tick) {
      const mine = (frames.get(runId) ?? []).filter((f) => f.agentId === agentId && f.kind === "keyframe" && f.tick <= tick);
      const top = mine.reduce<BeliefFrame | undefined>((a, x) => (a === undefined || x.seq > a.seq ? x : a), undefined);
      return top ? cloneFrame(top) : undefined;
    },
  };

  const after = (s: StoredMetricSample, a: { source: string; name: string; tick: number }): boolean =>
    s.source !== a.source ? s.source > a.source : s.name !== a.name ? s.name > a.name : s.tick > a.tick;
  const metricStore: MetricStore = {
    async append(runId, list) {
      if (!runExists(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
      const checked = checkMetricSamples(list);
      if (!checked.ok) return checked;
      const stored = metrics.get(runId) ?? [];
      for (const s of list) {
        if (stored.some((x) => x.source === s.source && x.name === s.name && x.tick === s.tick)) return err({ code: "duplicate_metric" as const, message: `sample ${s.name} of ${s.source} at tick ${s.tick} is already stored` });
      }
      const last = (source: string, name: string) => stored.filter((x) => x.source === source && x.name === name).reduce<number | undefined>((a, x) => (a === undefined || x.tick > a ? x.tick : a), undefined);
      if (!metricsKeepOrder(list, last)) return err({ code: "non_monotonic_metric" as const, message: "metric samples would break tick order" });
      metrics.set(runId, [...stored, ...list.map((s) => ({ ...s }))]);
      return ok(undefined);
    },
    async query(q) {
      const c = checkMetricQuery(q);
      return (metrics.get(c.runId) ?? [])
        .filter((s) => (c.source === undefined || s.source === c.source) && (c.name === undefined || s.name === c.name) && (c.fromS === undefined || s.simTime >= c.fromS) && (c.toS === undefined || s.simTime <= c.toS) && (c.after === undefined || after(s, c.after)))
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.tick - b.tick))
        .slice(0, c.limit)
        .map((s) => ({ ...s }));
    },
  };

  const sum = (xs: readonly number[]): SizeEntry => ({ count: xs.length, bytes: xs.reduce((a, b) => a + b, 0) });
  return {
    snapshots: snapshotStore,
    beliefFrames: frameStore,
    metrics: metricStore,
    sizesOf: (runId) => ({
      blobs: sum([...(blobs.get(runId)?.values() ?? [])].map((b) => b.length)),
      snapshots: sum([...(snapshots.get(runId)?.values() ?? [])].map((s) => s.bytes.length)),
      beliefFrames: sum((frames.get(runId) ?? []).map((f) => f.data?.length ?? 0)),
      metrics: sum((metrics.get(runId) ?? []).map(() => 40)),
    }),
    forget(runId) {
      blobs.delete(runId);
      snapshots.delete(runId);
      frames.delete(runId);
      metrics.delete(runId);
    },
  };
}
