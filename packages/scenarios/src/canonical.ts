import { utf8, xxHash32 } from "@agentsim/core";

/**
 * Canonical JSON: object keys sorted, `undefined` dropped, no whitespace. Number formatting is fixed by
 * ECMAScript (shortest round-trip), so the text, and its hash, are identical across engines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** xxHash32 of the UTF-8 text, as 8 hex digits. */
export function hash32Hex(text: string): string {
  return xxHash32(utf8(text), 0).toString(16).padStart(8, "0");
}
