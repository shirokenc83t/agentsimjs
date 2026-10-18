// Snapshot codec (F3a M1; ADR-0035 addition of 2026-10-17, item 8; format proposal for an ADR-0004 dated addition).
//
// A snapshot must give back exactly the state it was taken from, and the same state must always give the same bytes
// (no wall time, no engine-dependent output): JSON loses -0, NaN and ±Infinity, and orders object keys by insertion.
// This codec writes a self-describing, tagged binary form of plain data:
//   undefined, null, booleans, numbers (an int32 as a zigzag varint, anything else as a little-endian Float64 with one
//   canonical NaN, so -0, ±Infinity and every other bit pattern survive), strings (UTF-8), arrays, plain objects (keys in
//   insertion order: the simulator hashes and traces plain data with JSON.stringify, so key order is state), Map and Set
//   (entries sorted by the bytes of their encoded keys; `inOrder()` keeps insertion order where order is state), typed
//   arrays of the eight integer and two float kinds (little-endian, length in elements) and section references.
//   Functions, symbols, bigints, class instances and cycles are refused with the path that holds them.
//
// A snapshot is a container: magic "ASNP", a format version, the root value, and content-addressed **sections** (a value
// encoded on its own and named by the 128-bit content hash of its bytes). The root refers to a section by its hash, so
// a large unchanged piece (a belief map) is stored once, however many snapshots or agents refer to it. In M1 the
// sections are stored inside the container; in M2 the writer's `external` callback hands them to the belief keyframe
// blob store instead and the container keeps only their hashes: the container's content hash (`snapshotHash`) is
// the same either way, so the split needs no format change.
import { contentHash128Bytes } from "../numerics/content-hash.ts";
import { utf8 } from "../numerics/xxhash32.ts";

/** Container format version, byte 4 of every snapshot. A reader refuses any other. */
export const SNAPSHOT_VERSION = 1;

const MAGIC = [0x41, 0x53, 0x4e, 0x50] as const; // "ASNP"
const MAX_DEPTH = 64;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const TAG = {
  undefined: 0,
  null: 1,
  false: 2,
  true: 3,
  f64: 4,
  int: 5,
  str: 6,
  array: 7,
  object: 8,
  map: 9,
  mapInOrder: 10,
  set: 11,
  setInOrder: 12,
  ref: 13,
} as const;

type Typed = ArrayBufferView & { readonly length: number; [i: number]: number };
interface TypedCtor {
  new (buffer: ArrayBuffer): Typed;
  new (length: number): Typed;
}
interface TypedKind {
  readonly tag: number;
  readonly ctor: TypedCtor;
  readonly size: number;
  /** Floats are written element by element (one canonical NaN); integers can be copied as they are on a little-endian host. */
  readonly float: boolean;
  readonly set: (view: DataView, at: number, x: number) => void;
  readonly get: (view: DataView, at: number) => number;
}

const CANONICAL_NAN_F32 = 0x7fc00000;
const CANONICAL_NAN_F64_HI = 0x7ff80000;

const KINDS: readonly TypedKind[] = [
  { tag: 16, ctor: Int8Array as unknown as TypedCtor, size: 1, float: false, set: (v, a, x) => v.setInt8(a, x), get: (v, a) => v.getInt8(a) },
  { tag: 17, ctor: Uint8Array as unknown as TypedCtor, size: 1, float: false, set: (v, a, x) => v.setUint8(a, x), get: (v, a) => v.getUint8(a) },
  { tag: 18, ctor: Uint8ClampedArray as unknown as TypedCtor, size: 1, float: false, set: (v, a, x) => v.setUint8(a, x), get: (v, a) => v.getUint8(a) },
  { tag: 19, ctor: Int16Array as unknown as TypedCtor, size: 2, float: false, set: (v, a, x) => v.setInt16(a, x, true), get: (v, a) => v.getInt16(a, true) },
  { tag: 20, ctor: Uint16Array as unknown as TypedCtor, size: 2, float: false, set: (v, a, x) => v.setUint16(a, x, true), get: (v, a) => v.getUint16(a, true) },
  { tag: 21, ctor: Int32Array as unknown as TypedCtor, size: 4, float: false, set: (v, a, x) => v.setInt32(a, x, true), get: (v, a) => v.getInt32(a, true) },
  { tag: 22, ctor: Uint32Array as unknown as TypedCtor, size: 4, float: false, set: (v, a, x) => v.setUint32(a, x, true), get: (v, a) => v.getUint32(a, true) },
  {
    tag: 23,
    ctor: Float32Array as unknown as TypedCtor,
    size: 4,
    float: true,
    set: (v, a, x) => (Number.isNaN(x) ? v.setUint32(a, CANONICAL_NAN_F32, true) : v.setFloat32(a, x, true)),
    get: (v, a) => v.getFloat32(a, true),
  },
  {
    tag: 24,
    ctor: Float64Array as unknown as TypedCtor,
    size: 8,
    float: true,
    set: (v, a, x) => {
      if (Number.isNaN(x)) {
        v.setUint32(a, 0, true);
        v.setUint32(a + 4, CANONICAL_NAN_F64_HI, true);
      } else v.setFloat64(a, x, true);
    },
    get: (v, a) => v.getFloat64(a, true),
  },
];
const KIND_BY_TAG = new Map(KINDS.map((k) => [k.tag, k]));

/** Reference to a section of the snapshot that holds it, by the content hash of the section's bytes (32 hex digits). */
export class SectionRef {
  constructor(readonly hash: string) {
    if (!/^[0-9a-f]{32}$/.test(hash)) throw new RangeError(`section hash must be 32 lowercase hex digits: ${hash}`);
  }
}

/** A Map or Set whose insertion order is state (it drives event order, for example): encoded in that order. */
export class InOrder<T extends Map<unknown, unknown> | Set<unknown>> {
  readonly inOrder = true as const;
  constructor(readonly value: T) {}
}
export function inOrder<T extends Map<unknown, unknown> | Set<unknown>>(value: T): InOrder<T> {
  return new InOrder(value);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, "0");
  return s;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return a.length - b.length;
}

class ByteWriter {
  protected buf = new Uint8Array(1024);
  protected view = new DataView(this.buf.buffer);
  protected len = 0;

  protected ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  /** Unsigned LEB128 of an integer below 2^32. */
  varint(n: number): void {
    this.ensure(5);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Encoder extends ByteWriter {
  /** Section references met, in order of appearance. */
  readonly refs: string[] = [];

  constructor(private readonly path: (string | number)[] = []) {
    super();
  }

  private where(): string {
    return `$${this.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`;
  }

  private fail(what: string): never {
    throw new TypeError(`${this.where()}: ${what}`);
  }

  value(v: unknown): void {
    switch (typeof v) {
      case "undefined":
        this.u8(TAG.undefined);
        return;
      case "boolean":
        this.u8(v ? TAG.true : TAG.false);
        return;
      case "number":
        this.number(v);
        return;
      case "string":
        this.u8(TAG.str);
        this.string(v);
        return;
      case "object":
        this.object(v);
        return;
      default:
        this.fail(`${typeof v} cannot be part of a snapshot`);
    }
  }

  private number(v: number): void {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) {
      this.u8(TAG.int);
      this.varint(((v << 1) ^ (v >> 31)) >>> 0);
      return;
    }
    this.u8(TAG.f64);
    this.ensure(8);
    if (Number.isNaN(v)) {
      this.view.setUint32(this.len, 0, true);
      this.view.setUint32(this.len + 4, CANONICAL_NAN_F64_HI, true);
    } else this.view.setFloat64(this.len, v, true);
    this.len += 8;
  }

  string(s: string): void {
    const b = utf8(s);
    this.varint(b.length);
    this.bytes(b);
  }

  private object(v: object | null): void {
    if (v === null) {
      this.u8(TAG.null);
      return;
    }
    if (ArrayBuffer.isView(v)) {
      this.typed(v);
      return;
    }
    if (v instanceof SectionRef) {
      this.u8(TAG.ref);
      this.bytes(hexToBytes(v.hash));
      this.refs.push(v.hash);
      return;
    }
    if (this.path.length >= MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH} levels (a cycle?)`);
    if (Array.isArray(v)) {
      this.u8(TAG.array);
      this.varint(v.length);
      for (let i = 0; i < v.length; i++) {
        this.path.push(i);
        this.value(v[i]);
        this.path.pop();
      }
      return;
    }
    if (v instanceof InOrder) {
      this.collection(v.value, true);
      return;
    }
    if (v instanceof Map || v instanceof Set) {
      this.collection(v, false);
      return;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (v as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      this.fail(`class instance ${name} cannot be part of a snapshot (capture its fields as plain data)`);
    }
    // Key order is state: the simulator hashes and traces plain data with JSON.stringify (events, requests, results), whose
    // output follows insertion order, and fixes that order in code. A restored object must keep it, so keys are written
    // in insertion order (the order the language defines: integer-like keys ascending, then the others as inserted).
    const keys = Object.keys(v);
    this.u8(TAG.object);
    this.varint(keys.length);
    for (const k of keys) {
      this.string(k);
      this.path.push(k);
      this.value((v as Record<string, unknown>)[k]);
      this.path.pop();
    }
  }

  private collection(c: unknown, ordered: boolean): void {
    if (c instanceof Map) {
      this.u8(ordered ? TAG.mapInOrder : TAG.map);
      this.varint(c.size);
      const entries = [...c];
      const keys = ordered ? undefined : this.sortedKeyBytes(entries.map((e) => e[0]));
      const order = keys ? keys.order : entries.map((_, i) => i);
      order.forEach((idx, n) => {
        const entry = entries[idx];
        if (!entry) return;
        this.path.push(`{${n}}`);
        if (keys) this.bytes(keys.bytes[idx] ?? new Uint8Array(0));
        else this.value(entry[0]);
        this.value(entry[1]);
        this.path.pop();
      });
      return;
    }
    if (c instanceof Set) {
      this.u8(ordered ? TAG.setInOrder : TAG.set);
      this.varint(c.size);
      const items = [...c];
      const keys = ordered ? undefined : this.sortedKeyBytes(items);
      const order = keys ? keys.order : items.map((_, i) => i);
      order.forEach((idx, n) => {
        this.path.push(`{${n}}`);
        if (keys) this.bytes(keys.bytes[idx] ?? new Uint8Array(0));
        else this.value(items[idx]);
        this.path.pop();
      });
      return;
    }
    this.fail("inOrder() wraps a Map or a Set");
  }

  /** Encodes each key on its own and orders them by their bytes; two keys with the same bytes would leave the order ambiguous. */
  private sortedKeyBytes(keys: readonly unknown[]): { bytes: Uint8Array[]; order: number[] } {
    const bytes = keys.map((k, i) => {
      const e = new Encoder([...this.path, `{key ${i}}`]);
      e.value(k);
      this.refs.push(...e.refs);
      return e.finish();
    });
    const order = keys.map((_, i) => i).sort((a, b) => compareBytes(bytes[a] ?? new Uint8Array(0), bytes[b] ?? new Uint8Array(0)));
    for (let i = 1; i < order.length; i++) {
      if (compareBytes(bytes[order[i - 1] ?? 0] ?? new Uint8Array(0), bytes[order[i] ?? 0] ?? new Uint8Array(0)) === 0) this.fail("two Map or Set keys encode to the same bytes (use primitive keys)");
    }
    return { bytes, order };
  }

  private typed(v: ArrayBufferView): void {
    const kind = KINDS.find((k) => v instanceof (k.ctor as unknown as new () => object));
    if (!kind) this.fail(`unsupported typed array ${Object.prototype.toString.call(v)}`);
    const a = v as Typed;
    this.u8(kind.tag);
    this.varint(a.length);
    this.ensure(a.byteLength);
    if (!kind.float && (kind.size === 1 || LITTLE_ENDIAN)) {
      this.buf.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), this.len);
    } else {
      for (let i = 0; i < a.length; i++) kind.set(this.view, this.len + i * kind.size, a[i] ?? 0);
    }
    this.len += a.byteLength;
  }
}

class Reader {
  pos = 0;
  private readonly view: DataView;

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  need(n: number): void {
    if (n > this.remaining) throw new RangeError(`snapshot data truncated at byte ${this.pos} (needs ${n}, ${this.remaining} left)`);
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++] ?? 0;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new RangeError("snapshot varint longer than 5 bytes");
  }

  take(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  string(): string {
    return decodeUtf8(this.take(this.varint()));
  }

  /** A count of elements that each take at least one byte: a larger count than the bytes left is corrupt data. */
  count(): number {
    const n = this.varint();
    if (n > this.remaining) throw new RangeError(`snapshot count ${n} exceeds the ${this.remaining} bytes left`);
    return n;
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError(`snapshot value nested deeper than ${MAX_DEPTH} levels`);
    const tag = this.u8();
    switch (tag) {
      case TAG.undefined:
        return undefined;
      case TAG.null:
        return null;
      case TAG.false:
        return false;
      case TAG.true:
        return true;
      case TAG.f64:
        return this.f64();
      case TAG.int: {
        const z = this.varint();
        return (z >>> 1) ^ -(z & 1);
      }
      case TAG.str:
        return this.string();
      case TAG.array: {
        const n = this.count();
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(this.value(depth + 1));
        return out;
      }
      case TAG.object: {
        const n = this.count();
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const k = this.string();
          const v = this.value(depth + 1);
          if (k === "__proto__") Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
          else out[k] = v;
        }
        return out;
      }
      case TAG.map:
      case TAG.mapInOrder: {
        const n = this.count();
        const out = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) {
          const k = this.value(depth + 1);
          out.set(k, this.value(depth + 1));
        }
        return out;
      }
      case TAG.set:
      case TAG.setInOrder: {
        const n = this.count();
        const out = new Set<unknown>();
        for (let i = 0; i < n; i++) out.add(this.value(depth + 1));
        return out;
      }
      case TAG.ref:
        return new SectionRef(bytesToHex(this.take(16)));
      default: {
        const kind = KIND_BY_TAG.get(tag);
        if (!kind) throw new RangeError(`unknown tag 0x${tag.toString(16)} at byte ${this.pos - 1}`);
        return this.typed(kind);
      }
    }
  }

  private typed(kind: TypedKind): Typed {
    const length = this.varint();
    const byteLength = length * kind.size;
    if (byteLength > this.remaining) throw new RangeError(`snapshot typed array of ${length} elements exceeds the ${this.remaining} bytes left`);
    const src = this.take(byteLength);
    const buffer = new ArrayBuffer(byteLength);
    new Uint8Array(buffer).set(src);
    if (kind.size === 1 || LITTLE_ENDIAN) return new kind.ctor(buffer);
    const out = new kind.ctor(length);
    const view = new DataView(buffer);
    for (let i = 0; i < length; i++) out[i] = kind.get(view, i * kind.size);
    return out;
  }
}

/** UTF-8 decoding without `TextDecoder` (the core has no DOM/Web lib); accepts what `utf8()` writes, lone surrogates included. */
function decodeUtf8(b: Uint8Array): string {
  const units: number[] = [];
  let out = "";
  const flush = () => {
    out += String.fromCharCode(...units);
    units.length = 0;
  };
  const bad = (): never => {
    throw new RangeError("snapshot string is not valid UTF-8");
  };
  for (let i = 0; i < b.length; ) {
    const c = b[i] ?? 0;
    let cp: number;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c >= 0xc2 && c <= 0xdf) {
      const c1 = b[i + 1] ?? 0;
      if ((c1 & 0xc0) !== 0x80) bad();
      cp = ((c & 0x1f) << 6) | (c1 & 0x3f);
      i += 2;
    } else if (c >= 0xe0 && c <= 0xef) {
      const c1 = b[i + 1] ?? 0;
      const c2 = b[i + 2] ?? 0;
      if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) bad();
      cp = ((c & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
      if (cp < 0x800) bad();
      i += 3;
    } else if (c >= 0xf0 && c <= 0xf4) {
      const c1 = b[i + 1] ?? 0;
      const c2 = b[i + 2] ?? 0;
      const c3 = b[i + 3] ?? 0;
      if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) bad();
      cp = ((c & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) bad();
      i += 4;
    } else {
      cp = bad();
    }
    if (cp > 0xffff) {
      const s = cp - 0x10000;
      units.push(0xd800 + (s >> 10), 0xdc00 + (s & 0x3ff));
    } else units.push(cp);
    if (units.length >= 4096) flush();
  }
  flush();
  return out;
}

/** The bytes of one value (no container): what a section holds, and what `decodeValue` reads. Same value, same bytes. */
export function encodeValue(value: unknown): Uint8Array {
  const e = new Encoder();
  e.value(value);
  return e.finish();
}

/** Reads a value written by `encodeValue`; truncated, malformed or trailing data throws a RangeError. */
export function decodeValue(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const v = r.value(0);
  if (r.remaining !== 0) throw new RangeError(`snapshot value has ${r.remaining} trailing bytes`);
  return v;
}

export interface SnapshotWriterOptions {
  /**
   * Called once per new section with its hash and bytes; the container then holds only the hash (M2: the belief keyframe
   * blob store). Without it the section bytes are inside the container.
   */
  readonly external?: (hash: string, bytes: Uint8Array) => void;
}

/** Builds a snapshot: `section()` for each large piece that should be stored once, then `finish()` with the root value. */
export class SnapshotWriter {
  private readonly sections = new Map<string, Uint8Array>();

  constructor(private readonly options: SnapshotWriterOptions = {}) {}

  /** Stores `value` as a section (once per distinct content) and returns the reference to put in the root. */
  section(value: unknown): SectionRef {
    const e = new Encoder();
    e.value(value);
    if (e.refs.length > 0) throw new TypeError("a section cannot refer to another section");
    const bytes = e.finish();
    const hash = contentHash128Bytes(bytes);
    if (!this.sections.has(hash)) {
      this.sections.set(hash, bytes);
      this.options.external?.(hash, bytes);
    }
    return new SectionRef(hash);
  }

  /** The container bytes. Every section reference of `root` must name a section of this writer. */
  finish(root: unknown): Uint8Array {
    const e = new Encoder();
    e.value(root);
    for (const hash of e.refs) if (!this.sections.has(hash)) throw new TypeError(`unknown section ${hash}: the root refers to a section this writer did not store`);
    const rootBytes = e.finish();
    const w = new ByteWriter();
    for (const m of MAGIC) w.u8(m);
    w.u8(SNAPSHOT_VERSION);
    w.u32(rootBytes.length);
    w.bytes(rootBytes);
    const hashes = [...this.sections.keys()].sort();
    w.u32(hashes.length);
    for (const hash of hashes) {
      const bytes = this.sections.get(hash) ?? new Uint8Array(0);
      const inline = this.options.external === undefined;
      w.bytes(hexToBytes(hash));
      w.u8(inline ? 1 : 0);
      w.u32(bytes.length);
      if (inline) w.bytes(bytes);
    }
    return w.finish();
  }
}

export interface SnapshotSection {
  readonly hash: string;
  readonly length: number;
  /** Undefined when the section is stored outside the container. */
  readonly bytes: Uint8Array | undefined;
}

export interface ReadSnapshot {
  readonly version: number;
  /** The root value; `SectionRef`s in it name sections. */
  readonly root: unknown;
  readonly sections: readonly SnapshotSection[];
  /** Decodes a section: from the container, or from `resolve` when it is stored outside. Its content hash is checked. */
  section(ref: SectionRef): unknown;
}

export interface ReadSnapshotOptions {
  readonly resolve?: (hash: string) => Uint8Array | undefined;
}

interface Container {
  readonly version: number;
  readonly rootBytes: Uint8Array;
  readonly sections: readonly SnapshotSection[];
}

function parseContainer(bytes: Uint8Array): Container {
  if (bytes.length < MAGIC.length + 1 || MAGIC.some((m, i) => bytes[i] !== m)) throw new RangeError("not a snapshot (bad magic)");
  const r = new Reader(bytes);
  r.take(MAGIC.length);
  const version = r.u8();
  if (version !== SNAPSHOT_VERSION) throw new RangeError(`unsupported snapshot version ${version} (this build reads ${SNAPSHOT_VERSION})`);
  const rootBytes = r.take(r.u32());
  const count = r.u32();
  if (count * 13 > r.remaining) throw new RangeError("snapshot section table exceeds the bytes left");
  const sections: SnapshotSection[] = [];
  for (let i = 0; i < count; i++) {
    const hash = bytesToHex(r.take(16));
    const inline = r.u8() === 1;
    const length = r.u32();
    sections.push({ hash, length, bytes: inline ? r.take(length) : undefined });
  }
  if (r.remaining !== 0) throw new RangeError(`snapshot has ${r.remaining} trailing bytes`);
  return { version, rootBytes, sections };
}

/** Opens a snapshot container. `section()` decodes lazily, so opening a snapshot does not decode the large pieces. */
export function readSnapshot(bytes: Uint8Array, options: ReadSnapshotOptions = {}): ReadSnapshot {
  const c = parseContainer(bytes);
  const byHash = new Map(c.sections.map((s) => [s.hash, s]));
  return {
    version: c.version,
    root: decodeValue(c.rootBytes),
    sections: c.sections,
    section(ref: SectionRef): unknown {
      const entry = byHash.get(ref.hash);
      if (!entry) throw new RangeError(`unknown section ${ref.hash}`);
      const data = entry.bytes ?? options.resolve?.(ref.hash);
      if (!data) throw new RangeError(`section ${ref.hash} is not inline and no resolver supplied it`);
      if (data.length !== entry.length || contentHash128Bytes(data) !== ref.hash) throw new RangeError(`section ${ref.hash}: content hash does not match its bytes`);
      return decodeValue(data);
    },
  };
}

/**
 * Content hash (32 hex digits) of a snapshot: of its format version, root bytes and the (hash, length) of each section, so
 * it is the same whether the sections are inside the container or stored outside it. This is the hash a checkpoint
 * record carries next to the state hash (ADR-0035 item 8). It does not read section bytes: a section is checked
 * against its own hash when it is read.
 */
export function snapshotHash(bytes: Uint8Array): string {
  const c = parseContainer(bytes);
  const w = new ByteWriter();
  w.u8(c.version);
  w.u32(c.rootBytes.length);
  w.bytes(c.rootBytes);
  for (const s of c.sections) {
    w.bytes(hexToBytes(s.hash));
    w.u32(s.length);
  }
  return contentHash128Bytes(w.finish());
}
