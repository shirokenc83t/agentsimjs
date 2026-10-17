import { err, isValid, ok, type CodedError, type Result } from "@agentsim/core";
import Type, { type Static } from "typebox";

/**
 * A run input as stored (ADR-0015 clarification): a world-scope researcher command applied at the start of
 * `tick`. Same shape as the core's `RunInput`; validated here because a database may have been imported.
 */
export const StoredRunInput = Type.Object(
  {
    inputId: Type.String({ pattern: "^inp-[0-9]{6}$" }),
    tick: Type.Integer({ minimum: 1, maximum: 0x7fffffff }),
    agentId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type StoredRunInput = Static<typeof StoredRunInput>;

/** Bounds on a run's inputs (a command is small; a run has at most this many). */
export const RUN_INPUT_LIMITS = { maxParamsChars: 16 * 1024, maxPerRun: 100_000 } as const;

export type RunInputError = CodedError<"unknown_run" | "invalid_input" | "duplicate_input" | "non_monotonic_input" | "too_many_inputs">;

/**
 * Checks a batch against the run's stored inputs: valid shape and size, input IDs strictly increasing and new,
 * ticks non-decreasing in input order (inputs are recorded in the order they apply). All or nothing.
 */
export function checkRunInputs(existing: readonly Pick<StoredRunInput, "inputId" | "tick">[], batch: readonly unknown[]): Result<StoredRunInput[], RunInputError> {
  if (existing.length + batch.length > RUN_INPUT_LIMITS.maxPerRun) return err({ code: "too_many_inputs", message: `a run holds at most ${RUN_INPUT_LIMITS.maxPerRun} inputs` });
  const out: StoredRunInput[] = [];
  let last = existing[existing.length - 1];
  for (const raw of batch) {
    if (!isValid(StoredRunInput, raw)) return err({ code: "invalid_input", message: "invalid run input" });
    const json = JSON.stringify(raw.params ?? null);
    if (json.length > RUN_INPUT_LIMITS.maxParamsChars) return err({ code: "invalid_input", message: "run input params too large" });
    if (last && raw.inputId <= last.inputId) {
      return err({ code: existing.some((e) => e.inputId === raw.inputId) || out.some((o) => o.inputId === raw.inputId) ? "duplicate_input" : "non_monotonic_input", message: `input ${raw.inputId} after ${last.inputId}` });
    }
    if (last && raw.tick < last.tick) return err({ code: "non_monotonic_input", message: `input ${raw.inputId} at tick ${raw.tick} before tick ${last.tick}` });
    out.push(raw);
    last = raw;
  }
  return ok(out);
}
