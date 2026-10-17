import { err, ok, type CodedError, type Result } from "@agentsim/core";

/**
 * Per-chunk layer encoding for scenario documents (ADR-0025): base64 of RLE pairs
 * (`LEB128 run length`, value as `bytesPerValue` little-endian bytes). Decoding is untrusted input: every
 * run is bounds-checked, runs must sum to exactly the chunk's cell count, and nothing may be left over.
 */
export type ChunkCodecError = CodedError<"bad_base64" | "bad_varint" | "run_overflow" | "run_underflow" | "trailing_bytes" | "zero_run">;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      if (ch === 61 /* = */ && i + k >= s.length - pad) {
        n <<= 6;
        continue;
      }
      const v = ch < 128 ? (B64_INDEX[ch] ?? -1) : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Encodes `values` (one chunk, row-major) as base64 RLE. */
export function encodeChunkRle(values: ArrayLike<number>, bytesPerValue: 1 | 2): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i] ?? 0;
    let run = 1;
    while (i + run < values.length && values[i + run] === v) run++;
    let r = run;
    while (r >= 0x80) {
      bytes.push((r & 0x7f) | 0x80);
      r >>>= 7;
    }
    bytes.push(r);
    bytes.push(v & 0xff);
    if (bytesPerValue === 2) bytes.push((v >>> 8) & 0xff);
    i += run;
  }
  return toBase64(Uint8Array.from(bytes));
}

/** Decodes base64 RLE into exactly `cellCount` values; rejects malformed or oversized input. */
export function decodeChunkRle(encoded: string, cellCount: number, bytesPerValue: 1 | 2): Result<Uint8Array | Uint16Array, ChunkCodecError> {
  // Each pair needs at least 2 bytes, so a valid chunk never exceeds ~cellCount × (2 + bytesPerValue) bytes.
  if (encoded.length > Math.ceil((cellCount * (3 + bytesPerValue)) / 3) * 4 + 4) {
    return err({ code: "run_overflow", message: "encoded chunk is larger than any valid encoding" });
  }
  const bytes = fromBase64(encoded);
  if (!bytes) return err({ code: "bad_base64", message: "invalid base64" });
  const out = bytesPerValue === 1 ? new Uint8Array(cellCount) : new Uint16Array(cellCount);
  let p = 0;
  let filled = 0;
  while (p < bytes.length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      if (p >= bytes.length || shift > 28) return err({ code: "bad_varint", message: `bad run length at byte ${p}` });
      const b = bytes[p++] ?? 0;
      run += (b & 0x7f) * (1 << shift); // shift ≤ 28: exact
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (run === 0) return err({ code: "zero_run", message: `zero-length run at byte ${p}` });
    if (p + bytesPerValue > bytes.length) return err({ code: "trailing_bytes", message: "truncated value" });
    const v = bytesPerValue === 1 ? (bytes[p] ?? 0) : (bytes[p] ?? 0) | ((bytes[p + 1] ?? 0) << 8);
    p += bytesPerValue;
    if (filled + run > cellCount) return err({ code: "run_overflow", message: `runs exceed ${cellCount} cells` });
    out.fill(v, filled, filled + run);
    filled += run;
  }
  if (filled !== cellCount) return err({ code: "run_underflow", message: `runs cover ${filled} of ${cellCount} cells` });
  return ok(out);
}
