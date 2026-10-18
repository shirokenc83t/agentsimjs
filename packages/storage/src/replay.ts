import type { CodedError, Result } from "@agentsim/core";
import type { StoragePorts } from "./ports.ts";

// Replay reads a recorded run from storage alone (ADR-0035 addition of 2026-10-17, item 9; ADR-0019 addition of that date): the belief map of
// an agent at a tick, and the world a run was made in. Both are rebuilt in the storage worker, off the render path, by a module that is
// loaded when the first replay asks for it (the app supplies it: it needs the scenario and belief-map code that this package does not have).

export type ReplayErrorCode = "unknown_run" | "not_recorded" | "no_keyframe" | "scenario_missing" | "scenario_invalid" | "unknown_agent" | "unsupported_recording";
export type ReplayError = CodedError<ReplayErrorCode>;

/**
 * Which groups of the map a read returns (keyframes are lists of fixed square groups of chunks): the groups are ordered by their distance to
 * `focus` (default: the middle of the map), and the read returns `limit` of them after skipping `skip`. A first read of the nearest few paints at
 * once; a second read (`skip` = what the first returned) brings the rest.
 */
export interface ReplayView {
  readonly focus?: { readonly ci: number; readonly cj: number };
  readonly skip?: number;
  readonly limit?: number;
}

/** An agent's belief map at a tick as the belief overlay takes it: the believed state of every materialized chunk of the groups asked for, one byte per cell. */
export interface ReplayBelief {
  readonly runId: string;
  readonly agentId: string;
  readonly tick: number;
  /** The keyframe the rebuild started from, and how many deltas it applied after it. */
  readonly keyframeTick: number;
  readonly deltasApplied: number;
  /** Wall time of each phase of the rebuild in the worker (diagnostics: never in a trace or a hash). */
  readonly timingsMs?: { readonly blob: number; readonly decode: number; readonly deltas: number; readonly classify: number };
  /** The groups the map has at this tick (the keyframe's and those the deltas made), and which of them this read returned (positions in the order of the view). */
  readonly groups: { readonly total: number; readonly from: number; readonly to: number; readonly groupChunks: number; readonly cached: number; readonly read: number };
  readonly sizeX: number;
  readonly sizeY: number;
  readonly chunkSize: number;
  /** `(ci, cj)` pairs of the chunks in `data`. */
  readonly coords: Uint16Array;
  /** The chunks back to back (`chunkSize²` bytes each); transferred, not copied. */
  readonly data: Uint8Array;
}

/** The ground truth a run was made in, as the Scene's grid message and atlas chunks carry it. */
export interface ReplayWorld {
  readonly runId: string;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: number;
  readonly defaultObstacleHeightM?: number;
  readonly zones: readonly { readonly id: string; readonly kind: string; readonly polygon: readonly number[] }[];
  /** `(ci, cj)` pairs of every chunk, and their atlas encoding back to back (`chunkSize² × 4` bytes each); transferred. */
  readonly coords: Uint16Array;
  readonly data: Uint8Array;
}

export interface ReplayHandlers {
  beliefAt(ports: StoragePorts, runId: string, agentId: string, tick: number, view?: ReplayView): Promise<Result<ReplayBelief, ReplayError>>;
  world(ports: StoragePorts, runId: string): Promise<Result<ReplayWorld, ReplayError>>;
}

/** What the app hands the storage worker besides the ports: code the package cannot hold, loaded on first use. */
export interface StorageExtensions {
  readonly replay?: () => Promise<ReplayHandlers>;
}

/** The replay reads of the storage client (they run in the worker). */
export interface ReplayClient {
  beliefAt(runId: string, agentId: string, tick: number, view?: ReplayView): Promise<Result<ReplayBelief, ReplayError>>;
  world(runId: string): Promise<Result<ReplayWorld, ReplayError>>;
}
