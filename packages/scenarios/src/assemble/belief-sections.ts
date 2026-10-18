import type { SectionRef, SnapshotWriter } from "@agentsim/core";
import { BELIEF_MANIFEST_FORMAT, joinBeliefSnapshot, splitBeliefSnapshot, type BeliefGroup, type BeliefManifest, type BeliefMapSnapshot } from "@agentsim/spatial";

// A belief map as sections (ADR-0004 and ADR-0035 additions of 2026-10-18, second): the map is a list of fixed square groups of chunks, each group a
// content-addressed section of its own, and a manifest (the map's meta, the group size and the hash of each group's section) is the section the snapshot
// or the keyframe refers to. A snapshot and a keyframe of the same map are the same sections: a group that did not change is stored once.

/** Chunks per side of a group: chosen by measurement (F3a M3, T-027). The manifest records the size it was written with, so a reader never assumes it. */
export const BELIEF_GROUP_CHUNKS = 8;

/** Writes a map's group sections and its manifest section into `w`; returns the manifest's reference. */
export function writeBeliefSections(w: SnapshotWriter, snap: BeliefMapSnapshot, groupChunks: number = BELIEF_GROUP_CHUNKS): SectionRef {
  const { meta, groups } = splitBeliefSnapshot(snap, groupChunks);
  const manifest: BeliefManifest = {
    format: BELIEF_MANIFEST_FORMAT,
    groupChunks,
    meta,
    groups: groups.map((g) => ({ index: g.index, hash: w.section(g).hash })),
  };
  return w.section(manifest);
}

/** A decoded manifest that is what it says it is (it comes from storage, which another realm may have filled). */
export function checkBeliefManifest(v: unknown): BeliefManifest {
  const m = v as Partial<BeliefManifest> | null;
  if (!m || typeof m !== "object" || m.format !== BELIEF_MANIFEST_FORMAT) throw new RangeError("not a belief map manifest (a map stored whole, before chunk groups?)");
  if (!Number.isInteger(m.groupChunks) || (m.groupChunks as number) < 1 || !m.meta || !Array.isArray(m.groups)) throw new RangeError("malformed belief map manifest");
  for (const g of m.groups) if (!g || !Number.isInteger(g.index) || typeof g.hash !== "string") throw new RangeError("malformed belief map manifest group");
  return m as BeliefManifest;
}

/** The map a manifest and its group sections make. */
export function readBeliefSections(manifest: unknown, readGroup: (hash: string) => unknown): BeliefMapSnapshot {
  const m = checkBeliefManifest(manifest);
  const groups = m.groups.map((g) => {
    const group = readGroup(g.hash) as BeliefGroup;
    if (!group || group.index !== g.index || !Array.isArray(group.chunks)) throw new RangeError(`belief group ${g.index} (${g.hash}) is not the group its manifest names`);
    return group;
  });
  return joinBeliefSnapshot(m.meta, groups);
}
