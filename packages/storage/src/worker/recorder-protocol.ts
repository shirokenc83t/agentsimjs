import type { PersistedHead, RecorderBatch } from "@agentsim/trace";

// The direct channel between the sim worker's recorder and the storage worker (ADR-0019 and ADR-0035 additions of 2026-10-17): the main
// thread creates a MessageChannel and hands one port to each worker; trace records never travel through the main thread. The messages
// are internal between two workers of the same build, so they are not validated; the records inside go through `trace.append`, which is.

/** The first message on a worker's end: the port itself, transferred. */
export interface RecorderPortMessage {
  readonly type: "recorderPort";
  readonly port: MessagePort;
}

/** Sim worker → storage worker. */
export type RecorderToStorage = { readonly type: "batch"; readonly batch: RecorderBatch };

/** Storage worker → sim worker. */
export type StorageToRecorder =
  /** The run header is stored: the recorder may start sending (records emitted before it were held). */
  | { readonly type: "header"; readonly runId: string }
  /** Everything up to this head is saved (flushed). */
  | { readonly type: "persisted"; readonly head: PersistedHead }
  /**
   * The storage quota state (ADR-0035 §6): `paused` when usage is near the quota (the worker holds the run's batches, unsaved but not
   * lost, and the run pauses as `storage_quota`), `ok` when space is free again (held batches are stored, the run goes on).
   */
  | QuotaMessage
  /** A batch could not be stored: the run's recording is no longer complete. */
  | { readonly type: "rejected"; readonly runId: string; readonly code: string; readonly message: string };

/** Quota state, to the recorder and to the main thread (the status line shows `storage_quota`). */
export interface QuotaMessage {
  readonly type: "quota";
  readonly state: "paused" | "ok";
  readonly usageBytes: number;
  readonly quotaBytes: number;
}

/** Storage worker → main thread, next to the responses: the persisted head, for the status line and the timeline. */
export interface PersistedHeadMessage {
  readonly type: "persisted";
  readonly head: PersistedHead;
}

/** What the storage worker needs of a port (a `MessagePort` in a worker, a fake in tests). */
export interface RecorderPortLike {
  postMessage(message: StorageToRecorder): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
  start?(): void;
}
