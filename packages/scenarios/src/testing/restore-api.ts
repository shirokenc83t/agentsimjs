import type { RestoreApi } from "./restore-check.ts";

const NOT_YET = "snapshotRun and restoreRun (scenarios/assemble) arrive with T-006";

/**
 * The run composition the restore tests call (F3a M1). T-006 replaces this stub with `snapshotRun` and `restoreRun`
 * and un-skips the tests of T-003; until then they stay skipped and nothing calls it.
 */
export const RESTORE_API: RestoreApi = {
  snapshot() {
    throw new Error(NOT_YET);
  },
  restore() {
    throw new Error(NOT_YET);
  },
};
