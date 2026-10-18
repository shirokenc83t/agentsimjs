import type { TraceRecord } from "./trace-record.ts";

// API keys are never recorded, in any channel (CLAUDE.md; ADR-0035 §1 and addition item 5). A record's payload is data from the
// simulator and its minds; before a record leaves the producer, any value under a key that names a credential, and any string that
// has the shape of a provider key, is replaced.

export const REDACTED = "[redacted]";

/** Keys whose value is a credential: api key, secret, password, authorization, access/auth/bearer/refresh token. */
const SECRET_KEY = /^(api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|authorization|(access|auth|bearer|refresh|session)[-_]?token)$/i;
/** A provider key as it appears in a text: `sk-` followed by a long run of key characters (Anthropic, OpenAI and the like). */
const KEY_SHAPE = /\bsk-[A-Za-z0-9_-]{16,}/g;
const MAX_DEPTH = 64;

function scrub(v: unknown, depth: number): unknown {
  if (typeof v === "string") return v.includes("sk-") ? v.replace(KEY_SHAPE, REDACTED) : v;
  if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = scrub(x, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const y = SECRET_KEY.test(k) && x !== null && x !== undefined ? REDACTED : scrub(x, depth + 1);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** The record with credentials replaced, or the same object when it holds none. Never changes its input. */
export function redactSecrets(r: TraceRecord): TraceRecord {
  const payload = scrub(r.payload, 0);
  return payload === r.payload ? r : { ...r, payload };
}
