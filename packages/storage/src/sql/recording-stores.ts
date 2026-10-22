import { contentHash128Bytes, err, ok, readSnapshot } from "@agentsim/core";
import type {
  BeliefFrame,
  BeliefFrameQuery,
  BeliefFrameStore,
  LoadedSnapshot,
  MetricQuery,
  MetricStore,
  SnapshotInfo,
  SnapshotStore,
  SnapshotWrite,
  StoredBlob,
  StoredMetricSample,
} from "../ports.ts";
import { checkBlobs, checkFrameQuery, checkFrames, checkMetricQuery, checkMetricSamples, checkSnapshot, framesKeepOrder, metricsKeepOrder } from "../recording.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";

// Snapshots, blobs and belief frames over SQL (migration 0007; ADR-0035 addition of 2026-10-17, items 8 and 9).

const runExists = (db: SqlDriver, runId: string): boolean => db.get("SELECT 1 AS x FROM runs WHERE run_id = ?", [runId]) !== undefined;
const toBytes = (b: unknown): Uint8Array => (b instanceof Uint8Array ? new Uint8Array(b) : new Uint8Array(0));

type SnapshotRow = { id: string; seq: number; sim_time: number; tick: number; data: Uint8Array };
const infoOf = (r: Pick<SnapshotRow, "id" | "seq" | "sim_time" | "tick">, bytes: number): SnapshotInfo => ({ id: r.id, seq: r.seq, simTime: r.sim_time, tick: r.tick, bytes });

export class SqlSnapshotStore implements SnapshotStore {
  constructor(private readonly db: SqlDriver) {}

  private insertBlobs(runId: string, blobs: readonly StoredBlob[]): void {
    for (const b of blobs) this.db.run("INSERT OR IGNORE INTO blobs (run_id, id, data) VALUES (?, ?, ?)", [runId, b.id, b.bytes]);
  }

  async putBlobs(runId: string, blobs: readonly StoredBlob[]) {
    if (!runExists(this.db, runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
    const checked = checkBlobs(blobs);
    if (!checked.ok) return checked;
    this.db.transaction(() => this.insertBlobs(runId, blobs));
    return ok(undefined);
  }

  async getBlob(runId: string, id: string) {
    const r = this.db.get<{ data: Uint8Array }>("SELECT data FROM blobs WHERE run_id = ? AND id = ?", [runId, id]);
    if (!r) return undefined;
    const bytes = toBytes(r.data);
    // A database may have been imported from a file: what is read is checked against its name.
    return contentHash128Bytes(bytes) === id ? { id, bytes } : undefined;
  }

  async write(runId: string, s: SnapshotWrite) {
    if (!runExists(this.db, runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
    const snap = checkSnapshot(s);
    if (!snap.ok) return snap;
    const blobs = s.blobs ?? [];
    const blobsOk = checkBlobs(blobs);
    if (!blobsOk.ok) return blobsOk;
    const given = new Set(blobs.map((b) => b.id));
    for (const h of snap.value.external) {
      if (!given.has(h) && !this.db.get("SELECT 1 AS x FROM blobs WHERE run_id = ? AND id = ?", [runId, h])) {
        return err({ code: "missing_blob" as const, message: `the snapshot refers to section ${h}, which is not stored` });
      }
    }
    if (this.db.get("SELECT 1 AS x FROM snapshots WHERE run_id = ? AND id = ?", [runId, snap.value.id])) {
      return err({ code: "duplicate_snapshot" as const, message: `snapshot ${snap.value.id} is already stored` });
    }
    this.db.transaction(() => {
      this.insertBlobs(runId, blobs);
      this.db.run("INSERT INTO snapshots (run_id, id, seq, sim_time, tick, data) VALUES (?, ?, ?, ?, ?, ?)", [runId, snap.value.id, s.seq, s.simTime, s.tick, s.bytes]);
    });
    return ok({ id: snap.value.id });
  }

  async list(runId: string): Promise<SnapshotInfo[]> {
    return this.db
      .all<Omit<SnapshotRow, "data"> & { size: number }>("SELECT id, seq, sim_time, tick, length(data) AS size FROM snapshots WHERE run_id = ? ORDER BY tick, seq, id", [runId])
      .map((r) => infoOf(r, r.size));
  }

  async read(runId: string, id: string): Promise<LoadedSnapshot | undefined> {
    const r = this.db.get<SnapshotRow>("SELECT id, seq, sim_time, tick, data FROM snapshots WHERE run_id = ? AND id = ?", [runId, id]);
    if (!r) return undefined;
    const container = toBytes(r.data);
    const blobs: StoredBlob[] = [];
    for (const sec of readSnapshot(container).sections) {
      if (sec.bytes !== undefined) continue;
      const b = await this.getBlob(runId, sec.hash);
      if (b) blobs.push(b);
    }
    return { ...infoOf(r, container.length), container, blobs };
  }
}

type FrameRow = { agent_id: string; seq: number; tick: number; sim_time: number; kind: string; chunks: string; blob_id: string | null; data: Uint8Array | null };
const frameOf = (r: FrameRow): BeliefFrame => ({
  agentId: r.agent_id,
  seq: r.seq,
  tick: r.tick,
  simTime: r.sim_time,
  kind: r.kind as BeliefFrame["kind"],
  chunks: JSON.parse(r.chunks) as number[],
  ...(r.blob_id === null ? {} : { blobId: r.blob_id }),
  ...(r.data === null ? {} : { data: toBytes(r.data) }),
});
const FRAME_COLUMNS = "agent_id, seq, tick, sim_time, kind, chunks, blob_id, data";

export class SqlBeliefFrameStore implements BeliefFrameStore {
  constructor(private readonly db: SqlDriver) {}

  async append(runId: string, frames: readonly BeliefFrame[]) {
    if (!runExists(this.db, runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
    const checked = checkFrames(frames);
    if (!checked.ok) return checked;
    for (const f of frames) {
      if (f.blobId !== undefined && !this.db.get("SELECT 1 AS x FROM blobs WHERE run_id = ? AND id = ?", [runId, f.blobId])) {
        return err({ code: "missing_blob" as const, message: `frame ${f.agentId}#${f.seq} refers to blob ${f.blobId}, which is not stored` });
      }
      if (this.db.get("SELECT 1 AS x FROM belief_frames WHERE run_id = ? AND agent_id = ? AND seq = ?", [runId, f.agentId, f.seq])) {
        return err({ code: "duplicate_frame" as const, message: `frame ${f.agentId}#${f.seq} is already stored` });
      }
    }
    const last = (agentId: string) => {
      const r = this.db.get<{ seq: number; tick: number }>("SELECT seq, tick FROM belief_frames WHERE run_id = ? AND agent_id = ? ORDER BY seq DESC LIMIT 1", [runId, agentId]);
      return r ? { seq: r.seq, tick: r.tick } : undefined;
    };
    if (!framesKeepOrder(frames, last)) return err({ code: "non_monotonic_frame" as const, message: "frames would break seq/tick order" });
    this.db.transaction(() => {
      for (const f of frames) {
        this.db.run(`INSERT INTO belief_frames (run_id, ${FRAME_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          runId, f.agentId, f.seq, f.tick, f.simTime, f.kind, JSON.stringify(f.chunks), f.blobId ?? null, f.data ?? null,
        ]);
      }
    });
    return ok(undefined);
  }

  async query(q: BeliefFrameQuery): Promise<BeliefFrame[]> {
    const c = checkFrameQuery(q);
    const where = ["run_id = ?"];
    const params: SqlValue[] = [c.runId];
    if (c.agentId !== undefined) {
      where.push("agent_id = ?");
      params.push(c.agentId);
    }
    if (c.fromTick !== undefined) {
      where.push("tick >= ?");
      params.push(c.fromTick);
    }
    if (c.toTick !== undefined) {
      where.push("tick <= ?");
      params.push(c.toTick);
    }
    if (c.kind !== undefined) {
      where.push("kind = ?");
      params.push(c.kind);
    }
    params.push(c.limit);
    return this.db.all<FrameRow>(`SELECT ${FRAME_COLUMNS} FROM belief_frames WHERE ${where.join(" AND ")} ORDER BY agent_id, seq LIMIT ?`, params).map(frameOf);
  }

  async keyframeAtOrBefore(runId: string, agentId: string, tick: number) {
    const r = this.db.get<FrameRow>(
      `SELECT ${FRAME_COLUMNS} FROM belief_frames WHERE run_id = ? AND agent_id = ? AND kind = 'keyframe' AND tick <= ? ORDER BY seq DESC LIMIT 1`,
      [runId, agentId, tick],
    );
    return r ? frameOf(r) : undefined;
  }
}

type MetricRow = { source: string; name: string; tick: number; sim_time: number; value: number };

/** Metric samples over SQL (migration 0012; ADR-0035 section 4). */
export class SqlMetricStore implements MetricStore {
  constructor(private readonly db: SqlDriver) {}

  async append(runId: string, samples: readonly StoredMetricSample[]) {
    if (!runExists(this.db, runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
    const checked = checkMetricSamples(samples);
    if (!checked.ok) return checked;
    for (const s of samples) {
      if (this.db.get("SELECT 1 AS x FROM metrics WHERE run_id = ? AND source = ? AND name = ? AND tick = ?", [runId, s.source, s.name, s.tick])) {
        return err({ code: "duplicate_metric" as const, message: `sample ${s.name} of ${s.source} at tick ${s.tick} is already stored` });
      }
    }
    const last = (source: string, name: string) => this.db.get<{ tick: number | null }>("SELECT max(tick) AS tick FROM metrics WHERE run_id = ? AND source = ? AND name = ?", [runId, source, name])?.tick ?? undefined;
    if (!metricsKeepOrder(samples, last)) return err({ code: "non_monotonic_metric" as const, message: "metric samples would break tick order" });
    this.db.transaction(() => {
      for (const s of samples) this.db.run("INSERT INTO metrics (run_id, source, name, tick, sim_time, value) VALUES (?, ?, ?, ?, ?, ?)", [runId, s.source, s.name, s.tick, s.simTime, s.value]);
    });
    return ok(undefined);
  }

  async query(q: MetricQuery): Promise<StoredMetricSample[]> {
    const c = checkMetricQuery(q);
    const where = ["run_id = ?"];
    const params: SqlValue[] = [c.runId];
    if (c.source !== undefined) {
      where.push("source = ?");
      params.push(c.source);
    }
    if (c.name !== undefined) {
      where.push("name = ?");
      params.push(c.name);
    }
    if (c.fromS !== undefined) {
      where.push("sim_time >= ?");
      params.push(c.fromS);
    }
    if (c.toS !== undefined) {
      where.push("sim_time <= ?");
      params.push(c.toS);
    }
    if (c.after !== undefined) {
      where.push("(source, name, tick) > (?, ?, ?)");
      params.push(c.after.source, c.after.name, c.after.tick);
    }
    params.push(c.limit);
    return this.db
      .all<MetricRow>(`SELECT source, name, tick, sim_time, value FROM metrics WHERE ${where.join(" AND ")} ORDER BY source, name, tick LIMIT ?`, params)
      .map((r) => ({ source: r.source, name: r.name, tick: r.tick, simTime: r.sim_time, value: r.value }));
  }
}
