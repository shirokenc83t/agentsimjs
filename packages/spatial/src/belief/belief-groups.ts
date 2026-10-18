import type { BeliefMapSnapshot } from "./belief-map.ts";

// A belief map in a keyframe or a snapshot is a list of fixed square groups of chunks (ADR-0004 and ADR-0035 additions of 2026-10-18, second):
// each group is a content-addressed section of its own, so a group that did not change since the previous keyframe is stored once, and a reader
// can take the groups nearest the view first. Pure data and index arithmetic here; the sections themselves are written where snapshots are.

/** What a map is besides its chunks: geometry, change stamps and the planning change log. Small (about 8 KiB for a 1 km² map). */
export type BeliefMapMeta = Omit<BeliefMapSnapshot, "chunks">;

export type BeliefChunk = BeliefMapSnapshot["chunks"][number];

/** The chunks of one group, ascending by chunk index. */
export interface BeliefGroup {
  /** `gy · groupsX + gx` over the groups of the map. */
  readonly index: number;
  readonly chunks: readonly BeliefChunk[];
}

/** The format name of a belief map manifest. */
export const BELIEF_MANIFEST_FORMAT = "agentsim-belief-groups-1";

/** What a keyframe or a snapshot stores of a map besides the group sections: the meta, the group size, and the hash of each group section. */
export interface BeliefManifest {
  readonly format: typeof BELIEF_MANIFEST_FORMAT;
  /** Chunks per side of a group. */
  readonly groupChunks: number;
  readonly meta: BeliefMapMeta;
  /** The non-empty groups, ascending by index, with the content hash of their section. */
  readonly groups: readonly { readonly index: number; readonly hash: string }[];
}

export interface GroupGeometry {
  readonly chunksX: number;
  readonly chunksY: number;
  readonly groupChunks: number;
  readonly groupsX: number;
  readonly groupsY: number;
}

export function groupGeometry(sizeX: number, sizeY: number, chunkSize: number, groupChunks: number): GroupGeometry {
  if (!Number.isInteger(groupChunks) || groupChunks < 1) throw new RangeError("a group is at least one chunk per side");
  const chunksX = Math.ceil(sizeX / chunkSize);
  const chunksY = Math.ceil(sizeY / chunkSize);
  return { chunksX, chunksY, groupChunks, groupsX: Math.ceil(chunksX / groupChunks), groupsY: Math.ceil(chunksY / groupChunks) };
}

/** The group a chunk lies in. */
export function groupOfChunk(g: GroupGeometry, chunkIndex: number): number {
  const ci = chunkIndex % g.chunksX;
  const cj = (chunkIndex - ci) / g.chunksX;
  return Math.floor(cj / g.groupChunks) * g.groupsX + Math.floor(ci / g.groupChunks);
}

/** The groups of a snapshot's chunks, split by position: non-empty groups only, ascending by index, chunks ascending within each. */
export function splitBeliefSnapshot(s: BeliefMapSnapshot, groupChunks: number): { readonly meta: BeliefMapMeta; readonly groups: BeliefGroup[] } {
  const { chunks, ...meta } = s;
  const g = groupGeometry(s.sizeX, s.sizeY, s.chunkSize, groupChunks);
  const byGroup = new Map<number, BeliefChunk[]>();
  for (const c of chunks) {
    const k = groupOfChunk(g, c.index);
    const list = byGroup.get(k);
    if (list) list.push(c);
    else byGroup.set(k, [c]);
  }
  const groups = [...byGroup].sort((a, b) => a[0] - b[0]).map(([index, list]) => ({ index, chunks: list.sort((a, b) => a.index - b.index) }));
  return { meta, groups };
}

/** The snapshot a meta and its groups make; the chunks come out ascending by index, whatever the order of the groups. */
export function joinBeliefSnapshot(meta: BeliefMapMeta, groups: readonly BeliefGroup[]): BeliefMapSnapshot {
  const chunks = groups.flatMap((g) => g.chunks).sort((a, b) => a.index - b.index);
  return { ...meta, chunks };
}

/**
 * Group indices ordered by how near the group is to a chunk (Chebyshev distance of the group's chunk box to it, then by index): the view's
 * groups first. Pure, so a reader and its tests agree on the order.
 */
export function groupsNearest(g: GroupGeometry, indices: readonly number[], focus: { readonly ci: number; readonly cj: number }): number[] {
  const dist = (k: number): number => {
    const gx = k % g.groupsX;
    const gy = (k - gx) / g.groupsX;
    const x0 = gx * g.groupChunks;
    const y0 = gy * g.groupChunks;
    const dx = Math.max(x0 - focus.ci, 0, focus.ci - (x0 + g.groupChunks - 1));
    const dy = Math.max(y0 - focus.cj, 0, focus.cj - (y0 + g.groupChunks - 1));
    return Math.max(dx, dy);
  };
  return [...indices].sort((a, b) => dist(a) - dist(b) || a - b);
}
