import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { decodeChunkRle, encodeChunkRle, fromBase64, toBase64 } from "./chunk-rle.ts";

const CELLS = 64 * 64;

describe("chunk RLE codec (ADR-0025)", () => {
  it("round-trips base64 against known vectors", () => {
    for (const [s, b64] of [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foobar", "Zm9vYmFy"]] as const) {
      const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
      expect(toBase64(bytes)).toBe(b64);
      expect(Array.from(fromBase64(b64) ?? [])).toEqual(Array.from(bytes));
    }
    expect(fromBase64("Zm9")).toBeNull();
    expect(fromBase64("Z!9v")).toBeNull();
  });

  it("round-trips uniform, sparse and noisy chunks (8- and 16-bit)", () => {
    const rng = Rng.fromSeed(3).derive("rle");
    const sparse = new Uint8Array(CELLS);
    for (let k = 0; k < 40; k++) sparse[rng.intRange(0, CELLS - 1)] = 1;
    const noisy16 = Uint16Array.from({ length: CELLS }, () => rng.intRange(0, 65535));
    const runs = Uint8Array.from({ length: CELLS }, (_, k) => (k >> 9) * 30);
    for (const [vals, bpv] of [[new Uint8Array(CELLS).fill(10), 1], [sparse, 1], [runs, 1], [noisy16, 2]] as const) {
      const enc = encodeChunkRle(vals, bpv);
      const dec = decodeChunkRle(enc, CELLS, bpv);
      expect(dec.ok).toBe(true);
      if (dec.ok) expect(Array.from(dec.value)).toEqual(Array.from(vals));
    }
    expect(encodeChunkRle(new Uint8Array(CELLS), 1).length).toBeLessThan(12); // one run
  });

  it.each([
    ["not base64", "%%%%", "bad_base64"],
    ["truncated varint", toBase64(Uint8Array.from([0x80])), "bad_varint"],
    ["endless varint", toBase64(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0])), "bad_varint"],
    ["zero-length run", toBase64(Uint8Array.from([0, 1])), "zero_run"],
    ["run past the chunk", toBase64(Uint8Array.from([0x81, 0x40, 1])), "run_overflow"],
    ["too few cells", toBase64(Uint8Array.from([10, 1])), "run_underflow"],
    ["missing value byte", toBase64(Uint8Array.from([0x80, 0x20])), "trailing_bytes"],
    ["oversized input", "A".repeat(1_000_000), "run_overflow"],
  ])("rejects %s", (_name, encoded, code) => {
    const r = decodeChunkRle(encoded, CELLS, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});
