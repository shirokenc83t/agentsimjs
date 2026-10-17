/**
 * xxHash32 (ADR-0023): stream-seed derivation and the state hash. 32-bit integer operations only,
 * identical in every engine.
 */
const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number): number => ((x << r) | (x >>> (32 - r))) >>> 0;

function round(acc: number, input: number): number {
  acc = (acc + Math.imul(input, P2)) >>> 0;
  acc = rotl(acc, 13);
  return Math.imul(acc, P1) >>> 0;
}

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
}

/** xxHash32 of `bytes[0, length)` with `seed` (unsigned 32-bit result). */
export function xxHash32(bytes: Uint8Array, seed = 0, length = bytes.length): number {
  let i = 0;
  let h: number;
  if (length >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    const limit = length - 16;
    while (i <= limit) {
      v1 = round(v1, readU32(bytes, i));
      v2 = round(v2, readU32(bytes, i + 4));
      v3 = round(v3, readU32(bytes, i + 8));
      v4 = round(v4, readU32(bytes, i + 12));
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }
  h = (h + length) >>> 0;
  while (i + 4 <= length) {
    h = (h + Math.imul(readU32(bytes, i), P3)) >>> 0;
    h = Math.imul(rotl(h, 17), P4) >>> 0;
    i += 4;
  }
  while (i < length) {
    h = (h + Math.imul(bytes[i] ?? 0, P5)) >>> 0;
    h = Math.imul(rotl(h, 11), P1) >>> 0;
    i++;
  }
  h ^= h >>> 15;
  h = Math.imul(h, P2) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, P3) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** UTF-8 encoding without `TextEncoder` (the core has no DOM/Web lib). */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
