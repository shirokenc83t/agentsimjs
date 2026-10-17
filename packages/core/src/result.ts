/** Typed result used at every boundary (CLAUDE.md: exceptions only for programmer errors). */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

/** A failure with a stable, machine-readable code. */
export interface CodedError<C extends string = string> {
  readonly code: C;
  readonly message: string;
  readonly details?: unknown;
}
