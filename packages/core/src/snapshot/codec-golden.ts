// Golden bytes of the snapshot codec (ADR-0023 spirit: every engine must produce the bytes Node produces). The value
// below touches every tag of the format; `CODEC_GOLDEN` was generated in Node and is checked in Node
// (`codec.test.ts`) and in Chromium and Firefox (`codec.xengine.test.ts`). A change here means the format changed:
// bump `SNAPSHOT_VERSION` and say so in the report.
import { contentHash64Bytes } from "../numerics/content-hash.ts";
import { SnapshotWriter, SectionRef, encodeValue, inOrder, snapshotHash } from "./codec.ts";

/** A value with every kind the codec writes, with the numbers plain JSON loses. */
export function codecGoldenValue(): unknown {
  const bits = new Uint32Array([0x00000001, 0x7ff00000, 0xdeadbeef, 0x80000000]);
  return {
    nothing: undefined,
    nil: null,
    flags: [true, false],
    ints: [0, 1, -1, 63, 64, -64, -65, 300, -300, 2147483647, -2147483648],
    floats: [-0, 0.5, 0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MIN_VALUE, Number.MAX_VALUE, 2147483648, -2147483649, 9007199254740992],
    text: ["", "a", "é", "→", "日本語", "😀", "\u0000"],
    nested: { z: [[], {}, [[1]]], a: { b: { c: "deep" } } },
    map: new Map<string, unknown>([["b", 2], ["a", 1], ["ab", [3]]]),
    mapInOrder: inOrder(new Map<number, string>([[9, "x"], [2, "y"], [5, "z"]])),
    set: new Set([30, 10, 20]),
    setInOrder: inOrder(new Set(["z", "a", "m"])),
    i8: Int8Array.from([-128, -1, 0, 1, 127]),
    u8: Uint8Array.from([0, 1, 254, 255]),
    u8c: Uint8ClampedArray.from([0, 128, 255]),
    i16: Int16Array.from([-32768, -1, 0, 32767]),
    u16: Uint16Array.from([0, 1, 65534, 65535]),
    i32: Int32Array.from([-2147483648, -1, 0, 2147483647]),
    u32: Uint32Array.from([0, 1, 4294967295]),
    f32: Float32Array.from([-0, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 3.4028234663852886e38, 1e-45]),
    f64: new Float64Array(bits.buffer),
    empty: new Int8Array(0),
  };
}

/** The golden checks: value bytes, and a container with two sections, inline and with the sections stored outside. */
export function encodeCodecGolden(): { value: { length: number; hash: string }; snapshot: { length: number; hash: string; sections: string[] }; external: { length: number; hash: string } } {
  const value = encodeValue(codecGoldenValue());
  const build = (external: boolean): { bytes: Uint8Array; sections: string[] } => {
    const sections: string[] = [];
    const w = new SnapshotWriter(external ? { external: () => undefined } : {});
    const a = w.section({ chunk: Int8Array.from([1, -2, 3]), version: 7 });
    const b = w.section(codecGoldenValue());
    sections.push(a.hash, b.hash);
    return { bytes: w.finish({ tick: 600, maps: [a, b, a], again: new SectionRef(a.hash) }), sections };
  };
  const inline = build(false);
  const external = build(true);
  return {
    value: { length: value.length, hash: contentHash64Bytes(value) },
    snapshot: { length: inline.bytes.length, hash: snapshotHash(inline.bytes), sections: inline.sections },
    external: { length: external.bytes.length, hash: snapshotHash(external.bytes) },
  };
}

export const CODEC_GOLDEN = {
  // Regenerated in F3a M1 when object keys went from sorted to insertion order (the format was not in use yet).
  value: { length: 497, hash: "20b3a30e85df43cf" },
  snapshot: { length: 618, hash: "4e78a6014aefabbd", sections: ["1a1b26e2bb691418", "20b3a30e85df43cf"] },
  // Same hash as the inline container: the sections' place does not change the snapshot's content hash.
  external: { length: 98, hash: "4e78a6014aefabbd" },
};
