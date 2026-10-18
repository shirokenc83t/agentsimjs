import Type, { type Static } from "typebox";

/** Storage worker RPC (ADR-0010, ADR-0020). Requests are validated in the worker. */
export const STORAGE_PROTOCOL_VERSION = 2;

export const StorageMode = Type.Union([Type.Literal("opfs-sahpool"), Type.Literal("memory-fallback")]);
export type StorageMode = Static<typeof StorageMode>;

export const StorageInit = Type.Object({
  type: Type.Literal("init"),
  protocolVersion: Type.Literal(STORAGE_PROTOCOL_VERSION),
  /** Below this quota the worker falls back to memory (ADR-0020). */
  quotaThresholdBytes: Type.Integer({ minimum: 0 }),
  dbFile: Type.String({ pattern: "^/[a-z0-9._-]+$" }),
  lockName: Type.String({ minLength: 1, maxLength: 100 }),
  poolName: Type.String({ minLength: 1, maxLength: 100 }),
  /** Test-only: simulate missing OPFS APIs. */
  simulateNoOpfs: Type.Optional(Type.Boolean()),
  /** Test-only: wipe the pool before opening, for isolated contract tests. */
  resetOnOpen: Type.Optional(Type.Boolean()),
  /** Test-only: a quota of this many bytes against the database's own size, instead of the browser's (ADR-0035 §6). */
  simulateQuotaBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Test-only: every commit of recorder batches takes this long first, to exercise flow control (ADR-0035 §6). */
  simulateSlowWriterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
});
export type StorageInit = Static<typeof StorageInit>;

export const OPS = [
  "trace.append", "trace.flush", "trace.query", "trace.count",
  "runs.allocateRunId", "runs.create", "runs.get", "runs.list", "runs.setStatus", "runs.appendInputs", "runs.inputs", "runs.sizes", "runs.delete",
  "cache.get", "cache.put",
  "userData.get", "userData.set", "userData.delete", "userData.keys",
  "scenarios.list", "scenarios.get", "scenarios.saveVersion", "scenarios.delete",
  "runConfigs.list", "runConfigs.get", "runConfigs.saveVersion", "runConfigs.delete",
  "snapshots.putBlobs", "snapshots.getBlob", "snapshots.write", "snapshots.list", "snapshots.read",
  "beliefFrames.append", "beliefFrames.query", "beliefFrames.keyframeAtOrBefore",
  "admin.info", "admin.exportDb", "admin.exportRun", "admin.importDb", "admin.close",
  "test.openSecondConnection", "test.setSimulatedQuota",
] as const;
export type StorageOp = (typeof OPS)[number];

export const StorageRequest = Type.Object({
  type: Type.Literal("request"),
  id: Type.Integer({ minimum: 1 }),
  op: Type.Enum([...OPS]),
  args: Type.Array(Type.Unknown(), { maxItems: 4 }),
});
export type StorageRequest = Static<typeof StorageRequest>;

export type StorageResponse =
  | { readonly type: "response"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "response"; readonly id: number; readonly ok: false; readonly error: { code: string; message: string } };

export type StorageStatus =
  | { readonly type: "status"; readonly state: "loading" }
  | { readonly type: "status"; readonly state: "waiting-lock" }
  | { readonly type: "status"; readonly state: "ready"; readonly mode: StorageMode; readonly warning?: string }
  | { readonly type: "status"; readonly state: "failed"; readonly error: string }
  | { readonly type: "status"; readonly state: "closed" };

export interface StorageInfo {
  readonly mode: StorageMode;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly dbFileBytes: number;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  readonly persisted: boolean | null;
  readonly quotaThresholdBytes: number;
  readonly warning: string | null;
}
