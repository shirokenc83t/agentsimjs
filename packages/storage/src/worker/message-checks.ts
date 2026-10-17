import { validate, type Result, type ValidationError } from "@agentsim/core";
import { StorageInit, StorageRequest } from "./protocol.ts";

/**
 * Structural checks for storage worker messages. The main thread is a trusted internal peer, so these
 * run in dev builds and tests only (ADR-0018: validate at trust boundaries). Data persisted through
 * the ports (trace records, run headers) and imported files are always validated.
 */
export interface StorageMessageChecks {
  init(m: unknown): Result<StorageInit, ValidationError>;
  request(m: unknown): Result<StorageRequest, ValidationError>;
}

export const storageMessageChecks: StorageMessageChecks = {
  init: (m) => validate(StorageInit, m),
  request: (m) => validate(StorageRequest, m),
};
