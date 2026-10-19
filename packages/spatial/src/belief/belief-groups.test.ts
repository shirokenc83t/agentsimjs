import { describe, expect, it } from "vitest";
import { BELIEF_MANIFEST_FORMAT, groupGeometry, groupOfChunk, groupsNearest, joinBeliefSnapshot, splitBeliefSnapshot } from "./belief-groups.ts";
import { BeliefMap } from "./belief-map.ts";

function observed(): BeliefMap {
  const m = new BeliefMap(200, 130, 16); // 13 × 9 chunks
  for (let i = 0; i < 200; i += 7) {
    for (let j = 0; j < 130; j += 5) {
      if ((i + j) % 3 === 0) m.observeFree(i, j, 3);
      else m.observeHit(i, j, 1, 5);
    }
  }
  return m;
}

describe("belief map groups", () => {
  it("name the group of a chunk by position, over a map that is not a multiple of the group", () => {
    const g = groupGeometry(200, 130, 16, 4);
    expect([g.chunksX, g.chunksY, g.groupsX, g.groupsY]).toEqual([13, 9, 4, 3]);
    expect(groupOfChunk(g, 0)).toBe(0);
    expect(groupOfChunk(g, 3)).toBe(0);
    expect(groupOfChunk(g, 4)).toBe(1);
    expect(groupOfChunk(g, 12)).toBe(3);
    expect(groupOfChunk(g, 4 * 13)).toBe(4); // chunk (0, 4)
    expect(groupOfChunk(g, 8 * 13 + 12)).toBe(11);
    expect(() => groupGeometry(10, 10, 4, 0)).toThrow();
  });

  it.each([1, 2, 4, 8, 16])("split and join give back the snapshot exactly, for groups of %i chunks", (n) => {
    const map = observed();
    const snap = map.snapshot();
    const { meta, groups } = splitBeliefSnapshot(snap, n);
    expect(groups.map((x) => x.index)).toEqual([...groups.map((x) => x.index)].sort((a, b) => a - b));
    expect(groups.every((x) => x.chunks.length > 0)).toBe(true);
    expect(groups.reduce((a, x) => a + x.chunks.length, 0)).toBe(snap.chunks.length);
    // Shuffled groups still join in chunk order.
    expect(joinBeliefSnapshot(meta, [...groups].reverse())).toEqual(snap);
    const restored = new BeliefMap(200, 130, 16);
    restored.restore(joinBeliefSnapshot(meta, groups));
    expect(restored.snapshot()).toEqual(snap);
  });

  it("orders groups by the distance of their chunk box to the focus, then by index", () => {
    const g = groupGeometry(200, 130, 16, 4);
    const all = Array.from({ length: g.groupsX * g.groupsY }, (_, i) => i);
    expect(groupsNearest(g, all, { ci: 0, cj: 0 }).slice(0, 4)).toEqual([0, 1, 4, 5]);
    expect(groupsNearest(g, all, { ci: 12, cj: 8 })[0]).toBe(11);
    expect(groupsNearest(g, [11, 0, 5], { ci: 5, cj: 5 })).toEqual([5, 0, 11]);
    expect(BELIEF_MANIFEST_FORMAT).toBe("agentsim-belief-groups-1");
  });

  it("applies a cell delta only to the chunks a reader asked for", () => {
    const live = observed();
    live.trackCellChanges();
    live.takeCellDelta();
    live.observeFree(3, 3, 3);
    live.observeFree(190, 120, 3);
    const taken = live.takeCellDelta();
    if (!taken) throw new Error("no delta");
    const target = new BeliefMap(200, 130, 16);
    target.restore(observed().snapshot());
    const before = target.snapshot();
    target.applyCellDelta(taken.delta, (k) => k === 0); // only chunk 0 (cell 3, 3)
    const after = target.snapshot();
    const changed = after.chunks.filter((c, i) => JSON.stringify([...c.logOdds]) !== JSON.stringify([...(before.chunks[i]?.logOdds ?? [])])).map((c) => c.index);
    expect(changed).toEqual([0]);
  });
});
