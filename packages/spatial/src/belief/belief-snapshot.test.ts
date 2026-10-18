import { Rng, SnapshotWriter, StateHasher, decodeValue, encodeValue, readSnapshot, snapshotHash } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { BeliefMap, type BeliefMapSnapshot } from "./belief-map.ts";

// F3a M1: a belief map restored from its snapshot is the map it was (ADR-0035 addition of 2026-10-17, item 8):
// the same content hash, versions and change log, and it goes on changing exactly as the original does.

const hashOf = (m: BeliefMap): string => {
  const h = new StateHasher();
  m.hashInto(h);
  return h.hex();
};

/** A stream of observations from a seeded generator: free, under, hit, contact, priors, with and without heights. */
function observe(m: BeliefMap, r: Rng, n: number): void {
  for (let k = 0; k < n; k++) {
    const i = r.intRange(0, m.sizeX - 1);
    const j = r.intRange(0, m.sizeY - 1);
    switch (r.intRange(0, 5)) {
      case 0:
        m.observeFree(i, j, r.intRange(1, 30));
        break;
      case 1:
        m.observeUnder(i, j, r.intRange(1, 40) / 4, r.intRange(1, 30));
        break;
      case 2:
        m.observeHit(i, j, r.intRange(0, 30) / 4, r.intRange(1, 30));
        break;
      case 3:
        m.observeContact(i, j, r.intRange(0, 20) / 2);
        break;
      case 4:
        m.setPrior(i, j, r.intRange(-60, 60));
        break;
      default:
        m.setPriorHeightDm(i, j, r.intRange(1, 300));
    }
  }
}

/** Everything a consumer of the map can read, in a form that compares. */
function view(m: BeliefMap) {
  return {
    hash: hashOf(m),
    version: m.version,
    planVersion: m.planVersion,
    materialized: m.materializedChunks,
    changed: m.chunksChangedSince(0),
    planChanged: m.chunksPlanChangedSince(0),
    logs: [0, 1, m.planVersion >> 1, Math.max(0, m.planVersion - 5), m.planVersion].map((v) => {
      const c = m.cellsPlanChangedSince(v);
      return c === undefined ? null : [...c];
    }),
  };
}

const roundTrip = (s: BeliefMapSnapshot): BeliefMapSnapshot => decodeValue(encodeValue(s)) as BeliefMapSnapshot;

describe("BeliefMap snapshot and restore (F3a M1)", () => {
  it("a restored map equals the original and goes on changing exactly as it does (seeded workloads, through the codec)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = Rng.fromSeed(seed);
      const a = new BeliefMap(96, 80, 16);
      observe(a, r, 400 + 500 * seed);
      const b = new BeliefMap(96, 80, 16);
      b.restore(roundTrip(a.snapshot()));
      expect(view(b), `seed ${seed} right after the restore`).toEqual(view(a));
      const ra = Rng.fromSeed(seed + 100);
      const rb = Rng.fromSeed(seed + 100);
      for (let step = 0; step < 4; step++) {
        observe(a, ra, 700);
        observe(b, rb, 700);
        expect(view(b), `seed ${seed} after ${(step + 1) * 700} more observations`).toEqual(view(a));
      }
      expect(encodeValue(b.snapshot())).toEqual(encodeValue(a.snapshot()));
    }
  });

  it("keeps the change log across a wrap (more than 32,768 planning changes) and its first valid version", () => {
    const a = new BeliefMap(64, 64, 16);
    for (let n = 0; n < 80_000; n++) {
      const cell = (n >> 1) % 4096; // each cell: occupied, then back to unknown, over and over
      const i = cell % 64;
      const j = cell >> 6;
      if (n % 2 === 0) a.observeContact(i, j, 0);
      else a.observeFree(i, j, 100); // a planning-relevant flip each time
    }
    expect(a.planVersion).toBeGreaterThan(32_768);
    expect(a.cellsPlanChangedSince(0)).toBeUndefined(); // the log no longer reaches version 0
    const b = new BeliefMap(64, 64, 16);
    b.restore(roundTrip(a.snapshot()));
    expect(view(b)).toEqual(view(a));
    expect(b.cellsPlanChangedSince(0)).toBeUndefined();
    const recent = a.planVersion - 100;
    expect([...(b.cellsPlanChangedSince(recent) ?? [])]).toEqual([...(a.cellsPlanChangedSince(recent) ?? [])]);
    expect(b.snapshot().logFirst).toBe(a.snapshot().logFirst);
  });

  it("replaces what the map held: restoring over a map with observations does not merge", () => {
    const a = new BeliefMap(64, 64, 16);
    a.observeHit(3, 3, 1, 50);
    const used = new BeliefMap(64, 64, 16);
    observe(used, Rng.fromSeed(9), 2000);
    used.restore(a.snapshot());
    expect(view(used)).toEqual(view(a));
    expect(used.materializedChunks).toBe(a.materializedChunks);
  });

  it("two snapshots of the same unchanged map give the same section bytes and hash; a change gives another", () => {
    const m = new BeliefMap(128, 128, 32);
    observe(m, Rng.fromSeed(21), 3000);
    const section = (map: BeliefMap) => {
      const w = new SnapshotWriter();
      const ref = w.section(map.snapshot());
      return { ref, container: w.finish({ belief: ref }), bytes: encodeValue(map.snapshot()) };
    };
    const first = section(m);
    const again = section(m); // taken later, nothing changed in between
    expect(again.ref.hash).toBe(first.ref.hash);
    expect(again.bytes).toEqual(first.bytes);
    const clone = new BeliefMap(128, 128, 32);
    clone.restore(m.snapshot());
    expect(section(clone).ref.hash).toBe(first.ref.hash); // a restored map snapshots to the same section
    observe(m, Rng.fromSeed(22), 5);
    expect(section(m).ref.hash).not.toBe(first.ref.hash);
    // As a section the map can live outside the container (M2: belief keyframe blobs) with the same snapshot hash.
    const external = new Map<string, Uint8Array>();
    const w = new SnapshotWriter({ external: (h, b) => external.set(h, b) });
    const ref = w.section(clone.snapshot());
    const bytes = w.finish({ belief: ref });
    expect(snapshotHash(bytes)).toBe(snapshotHash(first.container));
    const back = readSnapshot(bytes, { resolve: (h) => external.get(h) });
    const b2 = new BeliefMap(128, 128, 32);
    b2.restore(back.section(ref) as BeliefMapSnapshot);
    expect(view(b2)).toEqual(view(clone));
  });

  it("refuses a snapshot of another geometry, one with a repeated chunk, and one with the wrong chunk size", () => {
    const a = new BeliefMap(64, 64, 16);
    a.observeHit(3, 3, 1, 50);
    const s = a.snapshot();
    expect(() => new BeliefMap(64, 64, 32).restore(s)).toThrow(/belief snapshot is 64 × 64 in chunks of 16/);
    expect(() => new BeliefMap(32, 64, 16).restore(s)).toThrow(/belief snapshot is 64 × 64/);
    const first = s.chunks[0];
    if (!first) throw new Error("a chunk was expected");
    expect(() => new BeliefMap(64, 64, 16).restore({ ...s, chunks: [first, first] })).toThrow(/out of range or repeated/);
    expect(() => new BeliefMap(64, 64, 16).restore({ ...s, chunks: [{ ...first, logOdds: new Int8Array(3) }] })).toThrow(/wrong size/);
  });

  it("an empty map restores to an empty map", () => {
    const a = new BeliefMap(64, 64, 16);
    const b = new BeliefMap(64, 64, 16);
    b.observeFree(1, 1, 5);
    b.restore(a.snapshot());
    expect(view(b)).toEqual(view(a));
    expect(b.snapshot().chunks).toEqual([]);
  });

  it("chunksSnapshot gives the content of the named chunks, and applying it to a copy of an older state gives the newer state (belief deltas)", () => {
    const r = Rng.fromSeed(31);
    const live = new BeliefMap(96, 80, 16);
    observe(live, r, 800);
    const replay = new BeliefMap(96, 80, 16);
    replay.restore(roundTrip(live.snapshot())); // a keyframe
    for (let step = 0; step < 12; step++) {
      const before = live.version;
      observe(live, r, 40 + step * 7);
      const changed = live.chunksChangedSince(before);
      const delta = decodeValue(encodeValue({ chunks: live.chunksSnapshot(changed) })) as { chunks: ReturnType<BeliefMap["chunksSnapshot"]> };
      replay.applyChunks(delta.chunks);
      expect(hashOf(replay), `after delta ${step}`).toBe(hashOf(live));
    }
    expect(replay.materializedChunks).toBe(live.materializedChunks);
  });

  it("chunksSnapshot copies (later changes do not reach it), refuses a chunk out of range, and is empty for no chunks", () => {
    const m = new BeliefMap(64, 64, 16);
    m.observeHit(3, 3, 1, 50);
    const [first] = m.chunksSnapshot([0]);
    const before = first?.logOdds.slice();
    m.observeFree(3, 3, 100);
    expect(first?.logOdds).toEqual(before);
    expect(m.chunksSnapshot([])).toEqual([]);
    expect(m.materializedIndices()).toEqual([0]);
    m.observeFree(40, 3, 5);
    expect(m.materializedIndices()).toEqual([0, 2]);
    expect(m.chunksSnapshot([5])).toEqual([]); // not materialized: nothing to say
    expect(() => m.chunksSnapshot([16])).toThrow(/out of range/);
  });

  it("applyChunks refuses an entry out of range or of the wrong size, and leaves the map as it was", () => {
    const m = new BeliefMap(64, 64, 16);
    m.observeHit(3, 3, 1, 50);
    const h = hashOf(m);
    expect(() => m.applyChunks([{ index: 99, logOdds: new Int8Array(256), knownMinDm: undefined, knownMaxDm: undefined }])).toThrow(/out of range/);
    expect(() => m.applyChunks([{ index: 1, logOdds: new Int8Array(3), knownMinDm: undefined, knownMaxDm: undefined }])).toThrow(/wrong size/);
    expect(hashOf(m)).toBe(h);
  });
});
