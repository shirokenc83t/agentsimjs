import { StateHasher, decodeValue } from "@agentsim/core";
import { BeliefMap, type BeliefCellDelta, type BeliefMapSnapshot } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { framesOf, profileOf, setup } from "./run-recording-harness.ts";

// F3a M2: replay reads a recorded run from storage alone (ADR-0035 addition of 2026-10-17, item 9; ADR-0019 and ADR-0029 additions of that
// date). The belief map at any tick is the last keyframe at or before it plus the deltas from it; a pose is a sample. What is rebuilt must
// equal what the live run had at that tick.

const hashOf = (m: BeliefMap): string => {
  const h = new StateHasher();
  m.hashInto(h);
  return h.hex();
};

type Frame = ReturnType<typeof framesOf>[number];

/** The map of `agentId` at `tick` from the frames and blobs of a recording: the last keyframe at or before it, then the deltas up to it. */
function rebuild(like: BeliefMap, agentId: string, tick: number, frames: readonly Frame[], blobs: ReadonlyMap<string, Uint8Array>): BeliefMap {
  const mine = frames.filter((f) => f.agentId === agentId && f.tick <= tick).sort((a, b) => a.seq - b.seq);
  const last = [...mine].reverse().find((f) => f.kind === "keyframe");
  if (!last) throw new Error(`no keyframe of ${agentId} at or before tick ${tick}`);
  const bytes = blobs.get(last.blobId ?? "");
  if (!bytes) throw new Error("keyframe blob missing");
  const map = new BeliefMap(like.sizeX, like.sizeY, like.chunkSize);
  map.restore(decodeValue(bytes) as BeliefMapSnapshot);
  for (const d of mine.filter((f) => f.kind === "delta" && f.seq > last.seq)) map.applyCellDelta(decodeValue(d.data ?? new Uint8Array()) as BeliefCellDelta);
  return map;
}

describe("a belief map rebuilt from keyframe and deltas is the live map", () => {
  it("at the keyframe's tick, the tick after it, and the last tick before the next keyframe, for the agent that explores", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 6 } } })));
    const id = t.driver;
    t.explore(id);
    const live = new Map<number, string>();
    const belief = t.world.recordingTarget().run.sensing.belief(id);
    live.set(0, hashOf(belief));
    for (let i = 1; i <= 200; i++) {
      t.step(1);
      live.set(i, hashOf(belief));
    }
    const frames = framesOf(t.items);
    const blobs = new Map(t.items.flatMap((i) => i.blobs.map((b) => [b.id, b.bytes] as const)));
    const keyframes = frames.filter((f) => f.agentId === id && f.kind === "keyframe").map((f) => f.tick);
    expect(keyframes).toEqual([0, 60, 120, 180]);
    // A keyframe tick, the tick after it, and the last tick before the next keyframe.
    for (const tick of [60, 61, 119, 120, 121, 179, 200, 33, 1]) {
      const rebuilt = rebuild(belief, id, tick, frames, blobs);
      expect(hashOf(rebuilt), `tick ${tick}`).toBe(live.get(tick));
    }
    // Chunks that the keyframe did not have were first made by deltas, and the rebuild is exact all the same.
    const first = decodeValue(blobs.get(frames.find((f) => f.agentId === id && f.kind === "keyframe")?.blobId ?? "") ?? new Uint8Array()) as BeliefMapSnapshot;
    expect(first.chunks.length).toBeLessThan(belief.materializedChunks);
    // The map really changed over the run (the check is not about an empty map).
    expect(live.get(0)).not.toBe(live.get(200));
    expect(belief.materializedChunks).toBeGreaterThan(0);
  });

  it("never needs more than the span of one keyframe interval: the deltas a rebuild reads are those since the last keyframe", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 6 } } })));
    t.explore(t.driver);
    t.step(200);
    const frames = framesOf(t.items).filter((f) => f.agentId === t.driver).sort((a, b) => a.seq - b.seq);
    let sinceKeyframe = 0;
    let longest = 0;
    for (const f of frames) {
      sinceKeyframe = f.kind === "keyframe" ? 0 : sinceKeyframe + 1;
      longest = Math.max(longest, sinceKeyframe);
    }
    expect(longest).toBeLessThanOrEqual(60); // at most one delta per tick of a 6 s interval at 10 Hz
  });
});

describe("poses at sampled ticks equal the live state", () => {
  it("every pose sample is the agent's state at its tick", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, poses: { rateHz: 10 } } })));
    const id = t.driver;
    t.explore(id);
    const agent = t.world.recordingTarget().run.agents.find((a) => a.id === id);
    const live = new Map<number, { x: number; y: number; heading: number }>();
    for (let i = 1; i <= 60; i++) {
      t.step(1);
      if (agent) live.set(i, { x: agent.state.x, y: agent.state.y, heading: agent.state.heading });
    }
    const samples = t.records().filter((r) => r.kind === "observation" && r.source === `${id}/body` && r.simTime > 0);
    expect(samples.length).toBeGreaterThanOrEqual(60);
    for (const r of samples) {
      const tick = Math.round(r.simTime * 10);
      const p = r.payload as { x: number; y: number; heading: number };
      expect(live.get(tick), `tick ${tick}`).toBeDefined();
      expect([p.x, p.y, p.heading]).toEqual([live.get(tick)?.x, live.get(tick)?.y, live.get(tick)?.heading]);
    }
  });
});
