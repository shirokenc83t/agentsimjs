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
  return contentHash64Bytes(utf8(json));
}

/** The same 64-bit hash of raw bytes. */
export function contentHash64Bytes(bytes: Uint8Array): string {
  return xxHash32(bytes, 0).toString(16).padStart(8, "0") + xxHash32(bytes, 0x9e3779b1).toString(16).padStart(8, "0");
}

/**
 * A 128-bit content hash of raw bytes: four xxHash32 passes with distinct seeds, as 32 hex digits. Names snapshot
 * sections and containers (ADR-0004 addition of 2026-10-18): a collision would silently share two different sections.
 */
export function contentHash128Bytes(bytes: Uint8Array): string {
  let out = "";
  for (const seed of HASH128_SEEDS) out += xxHash32(bytes, seed).toString(16).padStart(8, "0");
  return out;
}

const HASH128_SEEDS = [0, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d] as const;

export function contentHash(json: string): string {
  return xxHash32(utf8(json), 0).toString(16).padStart(8, "0");
}
