import { Settings } from "typebox/system";

let initialized = false;

/**
 * Configures TypeBox for this realm (main thread or a worker). Called by `validate()`/`isValid()` before every
 * check, and at startup by the sim and storage workers; the lab main thread relies on the lazy call only, to
 * keep TypeBox out of its initial chunk (ADR-0018 addition 2026-10-08). Lint keeps the checker unreachable
 * outside this wrapper. Acceleration is disabled so TypeBox never generates code: the app
 * runs under a CSP without 'unsafe-eval'. Optional-property semantics match our tsconfig.
 * Kept in its own module so realms that never validate do not bundle the TypeBox checker.
 */
export function initValidation(): void {
  if (initialized) return;
  Settings.Set({ useAcceleration: false, exactOptionalPropertyTypes: true });
  initialized = true;
}
