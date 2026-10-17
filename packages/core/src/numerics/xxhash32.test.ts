import { describe, expect, it } from "vitest";
import { utf8, xxHash32 } from "./xxhash32.ts";

describe("xxHash32", () => {
  // Reference vectors from the xxHash specification / reference implementation.
  it.each([
    ["", 0, 0x02cc5d05],
    ["a", 0, 0x550d7456],
    ["abc", 0, 0x32d153ff],
    ["Nobody inspects the spammish repetition", 0, 0xe2293b2f],
  ])("hash(%j, %d)", (s, seed, expected) => {
    expect(xxHash32(utf8(s), seed)).toBe(expected);
  });

  it("depends on the seed and on every byte", () => {
    const a = utf8("abcdefghijklmnopqrstuvwxyz");
    expect(xxHash32(a, 1)).not.toBe(xxHash32(a, 0));
    const b = a.slice();
    b[13] = (b[13] ?? 0) ^ 1;
    expect(xxHash32(b, 0)).not.toBe(xxHash32(a, 0));
  });

  // Expected bytes are fixed (the core has no DOM/Node lib, so no TextEncoder here).
  it.each([
    ["", []],
    ["abc", [0x61, 0x62, 0x63]],
    ["à", [0xc3, 0xa0]],
    ["€", [0xe2, 0x82, 0xac]],
    ["𝄞", [0xf0, 0x9d, 0x84, 0x9e]],
    ["a/1", [0x61, 0x2f, 0x31]],
  ] as const)("encodes %j as UTF-8", (s, bytes) => {
    expect(Array.from(utf8(s))).toEqual(bytes);
  });
});
