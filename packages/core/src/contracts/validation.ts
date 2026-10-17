import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { err, ok, type CodedError, type Result } from "../result.ts";
import { initValidation } from "./init-validation.ts";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationError = CodedError<"invalid"> & { readonly issues: readonly ValidationIssue[] };

/** Validates untrusted input against a schema with the interpreted checker (no code generation). */
export function validate<T extends TSchema>(schema: T, value: unknown): Result<Static<T>, ValidationError> {
  initValidation();
  if (Check(schema, value)) return ok(value);
  const issues = Errors(schema, value).map((e) => ({ path: e.instancePath, message: e.message }));
  return err({ code: "invalid", message: issues[0]?.message ?? "invalid value", issues });
}

/** Type guard variant for hot-ish paths that only need a boolean. */
export function isValid<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  initValidation();
  return Check(schema, value);
}
