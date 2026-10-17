import { utf8, xxHash32 } from "./xxhash32.ts";

/**
 * Content hash of a stored document's JSON text: xxHash32 of its UTF-8 bytes as 8 hex digits. Storage records it
 * per version (ADR-0025) and the sim worker computes it for presets it builds, so the lab can tell whether a
 * preset is already stored without serializing the document on the main thread.
 */
/**
 * A 64-bit content hash (two xxHash32 passes with different seeds) as 16 hex digits, for references that must not
 * collide in practice (deduplicated trace payloads): 32 bits would collide in about 1 % of runs with 10,000 distinct
 * payloads.
 */
export function contentHash64(json: string): string {
  const bytes = utf8(json);
  return xxHash32(bytes, 0).toString(16).padStart(8, "0") + xxHash32(bytes, 0x9e3779b1).toString(16).padStart(8, "0");
}

export function contentHash(json: string): string {
  return xxHash32(utf8(json), 0).toString(16).padStart(8, "0");
}
