import { describe, expect, it } from "vitest";
import { Rng } from "../numerics/rng.ts";
import { CODEC_GOLDEN, codecGoldenValue, encodeCodecGolden } from "./codec-golden.ts";
import { InOrder, SNAPSHOT_VERSION, SectionRef, SnapshotWriter, decodeValue, encodeValue, inOrder, readSnapshot, snapshotHash } from "./codec.ts";

/** Deep equality with Object.is on numbers (so -0 ≠ 0 and NaN = NaN), typed arrays by kind and element, Map/Set in order. */
function same(a: unknown, b: unknown, path = "$"): void {
  if (typeof a === "number" || typeof b === "number") {
    if (!Object.is(a, b)) throw new Error(`${path}: ${String(a)} vs ${String(b)}`);
    return;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) throw new Error(`${path}: ${String(a)} vs ${String(b)}`);
    return;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) throw new Error(`${path}: typed array kind`);
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) throw new Error(`${path}: length`);
    for (let i = 0; i < x.length; i++) same(x[i], y[i], `${path}[${i}]`);
    return;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) throw new Error(`${path}: map`);
    const ea = [...a];
    const eb = [...b];
    ea.forEach(([k, v], i) => {
      same(k, eb[i]?.[0], `${path}.key${i}`);
      same(v, eb[i]?.[1], `${path}.val${i}`);
    });
    return;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) throw new Error(`${path}: set`);
    const ea = [...a];
    const eb = [...b];
    ea.forEach((v, i) => same(v, eb[i], `${path}{${i}}`));
    return;
  }
  if (a instanceof SectionRef || b instanceof SectionRef) {
    if (!(a instanceof SectionRef) || !(b instanceof SectionRef) || a.hash !== b.hash) throw new Error(`${path}: section ref`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) throw new Error(`${path}: array`);
    a.forEach((v, i) => same(v, b[i], `${path}[${i}]`));
    return;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("\0") !== kb.join("\0")) throw new Error(`${path}: keys ${ka.join(",")} vs ${kb.join(",")}`);
  for (const k of ka) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
}

const SPECIAL_NUMBERS = [0, -0, 1, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, Number.EPSILON, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, -(2 ** 31) - 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53, 0.1 + 0.2, 1e-310];

/** A random value tree from a seeded stream: every kind the codec supports, nested a few levels. */
function randomValue(r: Rng, depth: number): unknown {
  const pick = r.intRange(0, depth > 3 ? 6 : 17);
  switch (pick) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return r.nextU32() % 2 === 0;
    case 3:
      return SPECIAL_NUMBERS[r.intRange(0, SPECIAL_NUMBERS.length - 1)];
    case 4:
      return r.intRange(-1000, 1000);
    case 5:
      return (r.nextFloat01() - 0.5) * 2 ** r.intRange(-60, 60);
    case 6:
      return randomString(r);
    case 7:
      return Array.from({ length: r.intRange(0, 5) }, () => randomValue(r, depth + 1));
    case 8: {
      const o: Record<string, unknown> = {};
      for (let i = r.intRange(0, 5); i > 0; i--) o[randomString(r)] = randomValue(r, depth + 1);
      return o;
    }
    case 9:
      return new Map(Array.from({ length: r.intRange(0, 4) }, () => [randomString(r), randomValue(r, depth + 1)] as const));
    case 10:
      return inOrder(new Map(Array.from({ length: r.intRange(0, 4) }, () => [r.intRange(0, 50), randomValue(r, depth + 1)] as const)));
    case 11:
      return new Set(Array.from({ length: r.intRange(0, 4) }, () => r.intRange(-9, 9)));
    case 12:
      return Int8Array.from({ length: r.intRange(0, 9) }, () => r.intRange(-128, 127));
    case 13:
      return Uint16Array.from({ length: r.intRange(0, 9) }, () => r.intRange(0, 0xffff));
    case 14:
      return Int32Array.from({ length: r.intRange(0, 9) }, () => r.intRange(-(2 ** 31), 2 ** 31 - 1));
    case 15:
      return Uint32Array.from({ length: r.intRange(0, 9) }, () => r.nextU32());
    case 16:
      return Float64Array.from({ length: r.intRange(0, 9) }, () => SPECIAL_NUMBERS[r.intRange(0, SPECIAL_NUMBERS.length - 1)] ?? 0);
    default:
      return inOrder(new Set(Array.from({ length: r.intRange(0, 4) }, () => randomString(r))));
  }
}

function randomString(r: Rng): string {
  const alphabet = ["a", "b", "z", "é", "ß", "→", "日", "😀", "\u0000", " ", "-", "0"];
  return Array.from({ length: r.intRange(0, 6) }, () => alphabet[r.intRange(0, alphabet.length - 1)]).join("");
}

/** Decoding an `inOrder` value gives a plain Map/Set; re-wrap where the input was wrapped, for comparison. */
const roundTrip = (v: unknown) => decodeValue(encodeValue(v));
const byEncoding = (a: unknown, b: unknown): number => {
  const x = encodeValue(a);
  const y = encodeValue(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
};
/** The value the codec must give back: Map and Set sorted by the bytes of their keys, except where wrapped in `inOrder`. */
const plain = (v: unknown, keepOrder = false): unknown => {
  if (v instanceof InOrder) return plain(v.value, true);
  if (v instanceof Map) {
    const entries = [...v].map(([k, x]) => [plain(k), plain(x)] as const);
    return new Map(keepOrder ? entries : entries.sort((a, b) => byEncoding(a[0], b[0])));
  }
  if (v instanceof Set) {
    const items = [...v].map((x) => plain(x));
    return new Set(keepOrder ? items : items.sort(byEncoding));
  }
  if (Array.isArray(v)) return v.map((x) => plain(x));
  if (v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof SectionRef))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};
const hasInOrder = (v: unknown): boolean => {
  if (!v || typeof v !== "object" || ArrayBuffer.isView(v)) return false;
  if (v instanceof InOrder) return true;
  if (v instanceof Map) return [...v].some(([k, x]) => hasInOrder(k) || hasInOrder(x));
  if (v instanceof Set) return [...v].some(hasInOrder);
  return Object.values(v).some(hasInOrder);
};

describe("snapshot codec: values", () => {
  it("round-trips the values plain JSON loses: -0, NaN, ±Infinity, extreme and subnormal floats, large integers", () => {
    for (const n of SPECIAL_NUMBERS) same(roundTrip(n), n);
    same(roundTrip({ lastRequestS: Number.NEGATIVE_INFINITY, bestDistance: Number.POSITIVE_INFINITY, z: -0 }), {
      lastRequestS: Number.NEGATIVE_INFINITY,
      bestDistance: Number.POSITIVE_INFINITY,
      z: -0,
    });
  });

  it("round-trips an Rng state with an empty spare normal (NaN) and a drawn one", () => {
    const r = Rng.fromSeed(11).derive("sensor/lidar");
    same(roundTrip(r.getState()), r.getState());
    r.normal();
    const st = r.getState();
    expect(Number.isNaN(st.spareNormal)).toBe(false);
    same(roundTrip(st), st);
    const back = Rng.fromSeed(0);
    back.setState(roundTrip(st) as ReturnType<Rng["getState"]>);
    expect(back.nextU32()).toBe(r.nextU32());
  });

  it("round-trips Float64 bit patterns of every non-NaN value exactly", () => {
    const r = Rng.fromSeed(3);
    const bits = new Uint32Array(2);
    const f = new Float64Array(bits.buffer);
    for (let i = 0; i < 2000; i++) {
      bits[0] = r.nextU32();
      bits[1] = r.nextU32();
      const v = f[0] ?? 0;
      if (Number.isNaN(v)) continue;
      const back = roundTrip(v) as number;
      const out = new Float64Array([back]);
      expect(new Uint32Array(out.buffer)).toEqual(bits);
    }
  });

  it("round-trips integer and float typed arrays by kind, with their edge values", () => {
    const cases = [
      Int8Array.from([-128, -1, 0, 1, 127]),
      Uint8Array.from([0, 1, 255]),
      Uint8ClampedArray.from([0, 128, 255]),
      Int16Array.from([-32768, 0, 32767]),
      Uint16Array.from([0, 0xfffe, 0xffff]),
      Int32Array.from([-(2 ** 31), -1, 0, 2 ** 31 - 1]),
      Uint32Array.from([0, 1, 0xffffffff]),
      Float32Array.from([-0, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 3.4028234663852886e38]),
      Float64Array.from(SPECIAL_NUMBERS),
      new Int8Array(0),
    ];
    for (const a of cases) same(roundTrip(a), a);
    // A view onto part of a larger buffer encodes only its own elements.
    const big = Uint16Array.from([1, 2, 3, 4, 5, 6]);
    same(roundTrip(big.subarray(2, 4)), Uint16Array.from([3, 4]));
  });

  it("encodes Map and Set as sorted entries, and keeps insertion order where order is state (inOrder)", () => {
    const a = new Map<string, number>([["b", 2], ["a", 1], ["c", 3]]);
    const b = new Map<string, number>([["c", 3], ["a", 1], ["b", 2]]);
    expect(encodeValue(a)).toEqual(encodeValue(b));
    expect([...(roundTrip(a) as Map<string, number>).keys()]).toEqual(["a", "b", "c"]);
    expect(encodeValue(new Set([3, 1, 2]))).toEqual(encodeValue(new Set([1, 2, 3])));

    const ordered = roundTrip(inOrder(b)) as Map<string, number>;
    expect([...ordered.keys()]).toEqual(["c", "a", "b"]);
    expect(encodeValue(inOrder(a))).not.toEqual(encodeValue(inOrder(b)));
    expect([...(roundTrip(inOrder(new Set(["z", "a"]))) as Set<string>)]).toEqual(["z", "a"]);
  });

  it("gives the same bytes for objects whose keys were inserted in a different order", () => {
    expect(encodeValue({ x: 1, y: [2, { q: 3, p: 4 }] })).toEqual(encodeValue({ y: [2, { p: 4, q: 3 }], x: 1 }));
  });

  it("keeps an own property set to undefined distinct from a missing one", () => {
    same(roundTrip({ a: undefined }), { a: undefined });
    expect(Object.keys(roundTrip({ a: undefined }) as object)).toEqual(["a"]);
    expect(encodeValue({ a: undefined })).not.toEqual(encodeValue({}));
  });

  it("round-trips random value trees (property test, 500 seeded cases) with identical bytes across calls", () => {
    for (let seed = 0; seed < 500; seed++) {
      const v = randomValue(Rng.fromSeed(seed), 0);
      const bytes = encodeValue(v);
      expect(encodeValue(v)).toEqual(bytes);
      const back = decodeValue(bytes);
      same(back, plain(v), `seed ${seed}`);
      // Decoding and encoding again gives the same bytes, wherever the input was not wrapped in inOrder.
      if (!hasInOrder(v)) expect(encodeValue(back)).toEqual(bytes);
    }
  });

  it("rejects what a snapshot must never hold: functions, symbols, bigints, class instances, cycles", () => {
    expect(() => encodeValue({ f: () => 1 })).toThrow(/\$\.f: function/);
    expect(() => encodeValue([Symbol("s")])).toThrow(/symbol/);
    expect(() => encodeValue(1n)).toThrow(/bigint/);
    class Thing {
      readonly x = 1;
    }
    expect(() => encodeValue({ t: new Thing() })).toThrow(/\$\.t: .*Thing/);
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(() => encodeValue(cyc)).toThrow(/nested deeper/);
    expect(() => encodeValue(new Date(0))).toThrow(/Date/);
  });

  it("rejects truncated or malformed bytes instead of returning a partial value", () => {
    const bytes = encodeValue({ a: [1, 2, 3], s: "text", f: Float64Array.from([1, 2]) });
    for (let n = 0; n < bytes.length; n++) expect(() => decodeValue(bytes.subarray(0, n))).toThrow(RangeError);
    expect(() => decodeValue(Uint8Array.from([0xee]))).toThrow(/unknown tag/);
    expect(() => decodeValue(Uint8Array.from([...encodeValue(1), 0]))).toThrow(/trailing/);
  });
});

describe("snapshot codec: container and content-addressed sections", () => {
  const beliefLike = (seed: number) => {
    const r = Rng.fromSeed(seed);
    return {
      sizeX: 256,
      sizeY: 256,
      chunkSize: 64,
      version: 41,
      chunks: inOrder(new Map([[3, { logOdds: Int8Array.from({ length: 4096 }, () => r.intRange(-100, 100)), knownMinDm: undefined, knownMaxDm: undefined }]])),
    };
  };

  it("writes a versioned container, and reads back the root and its sections", () => {
    const w = new SnapshotWriter();
    const ref = w.section(beliefLike(1));
    const bytes = w.finish({ tick: 120, agents: { "ugv-001": { belief: ref } } });
    const s = readSnapshot(bytes);
    expect(s.version).toBe(SNAPSHOT_VERSION);
    const root = s.root as { tick: number; agents: Record<string, { belief: SectionRef }> };
    expect(root.tick).toBe(120);
    const back = root.agents["ugv-001"]?.belief;
    expect(back).toBeInstanceOf(SectionRef);
    expect(back?.hash).toBe(ref.hash);
    same(s.section(back as SectionRef), plain(beliefLike(1)));
    expect(s.sections.map((x) => x.hash)).toEqual([ref.hash]);
  });

  it("gives the same section bytes and hash for an unchanged belief map in two snapshots, and a new hash when it changes", () => {
    const a = new SnapshotWriter();
    const refA = a.section(beliefLike(7));
    const snapA = readSnapshot(a.finish({ tick: 600, belief: refA }));
    const b = new SnapshotWriter();
    const refB = b.section(beliefLike(7));
    const snapB = readSnapshot(b.finish({ tick: 1200, belief: refB }));
    expect(refB.hash).toBe(refA.hash);
    expect(snapB.sections[0]?.bytes).toEqual(snapA.sections[0]?.bytes);
    const changed = beliefLike(7);
    changed.version = 42;
    expect(new SnapshotWriter().section(changed).hash).not.toBe(refA.hash);
  });

  it("stores one section for identical maps of two agents", () => {
    const w = new SnapshotWriter();
    const r1 = w.section(beliefLike(5));
    const r2 = w.section(beliefLike(5));
    expect(r2.hash).toBe(r1.hash);
    expect(readSnapshot(w.finish({ a: r1, b: r2 })).sections).toHaveLength(1);
  });

  it("can leave sections outside the container (M2 belief keyframe blobs) with no format change and the same snapshot hash", () => {
    const value = (w: SnapshotWriter) => w.finish({ tick: 30, maps: [w.section(beliefLike(1)), w.section(beliefLike(2))] });
    const inline = value(new SnapshotWriter());
    const blobs = new Map<string, Uint8Array>();
    const external = value(new SnapshotWriter({ external: (hash, bytes) => blobs.set(hash, bytes) }));
    expect(external.length).toBeLessThan(inline.length / 4);
    expect(blobs.size).toBe(2);
    expect(snapshotHash(external)).toBe(snapshotHash(inline));

    const s = readSnapshot(external, { resolve: (hash) => blobs.get(hash) });
    const root = s.root as { maps: SectionRef[] };
    same(s.section(root.maps[1] as SectionRef), plain(beliefLike(2)));
    expect(() => readSnapshot(external).section(root.maps[0] as SectionRef)).toThrow(/not inline and no resolver/);
    expect(() => readSnapshot(external, { resolve: () => Uint8Array.from([1, 2]) }).section(root.maps[0] as SectionRef)).toThrow(/content hash/);
  });

  it("refuses a section reference the snapshot does not contain, and foreign or newer containers", () => {
    const w = new SnapshotWriter();
    expect(() => w.finish({ ref: new SectionRef("00000000deadbeef") })).toThrow(/unknown section/);
    expect(() => readSnapshot(Uint8Array.from([1, 2, 3, 4, 5, 6]))).toThrow(/not a snapshot/);
    const bytes = new SnapshotWriter().finish({});
    const newer = bytes.slice();
    newer[4] = SNAPSHOT_VERSION + 1;
    expect(() => readSnapshot(newer)).toThrow(/version/);
  });
});

describe("snapshot codec: golden bytes (also checked in Chromium and Firefox)", () => {
  it("encodes the golden value to the golden hashes", () => {
    expect(encodeCodecGolden()).toEqual(CODEC_GOLDEN);
  });

  it("the golden value decodes back to itself", () => {
    same(decodeValue(encodeValue(codecGoldenValue())), plain(codecGoldenValue()));
  });
});
