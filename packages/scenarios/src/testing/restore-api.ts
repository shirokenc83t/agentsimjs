import { restoreRun, snapshotRun } from "../assemble/snapshot-run.ts";
import type { RestoreApi } from "./restore-check.ts";

/** The run composition the restore tests call (F3a M1, T-006): the snapshot of a whole run and its restore into a run that skipped genesis. */
export const RESTORE_API: RestoreApi = {
  snapshot: (run) => snapshotRun(run),
  restore: (target, bytes) => restoreRun(target, bytes),
};
