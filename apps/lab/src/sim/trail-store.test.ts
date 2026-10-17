import { TRAIL_MAX_POINTS } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { TrailStore } from "./trail-store.ts";

const msg = (agents: number[], points: number[], replace?: { agents: number[]; offsets: number[]; points: number[] }) => ({
  agents: Uint16Array.from(agents),
  points: Float32Array.from(points),
  ...(replace ? { replace: { agents: Uint16Array.from(replace.agents), offsets: Uint32Array.from(replace.offsets), points: Float32Array.from(replace.points) } } : {}),
});

describe("TrailStore (main thread, bounded)", () => {
  it("appends points per agent into a preallocated buffer; the path is a view, never a copy", () => {
    const s = new TrailStore(2);
    s.apply(msg([0, 1, 0], [1, 2, 3, 10, 20, 30, 4, 5, 6]));
    expect(Array.from(s.path(0).points)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.path(0)).toMatchObject({ count: 2, version: 0 });
    expect(Array.from(s.path(1).points)).toEqual([10, 20, 30]);
    expect(s.path(0).points.buffer.byteLength).toBe(TRAIL_MAX_POINTS * 3 * 4);
  });

  it("a replace supersedes the agent's points, bumps its version, then the message's appends follow", () => {
    const s = new TrailStore(2);
    s.apply(msg([0, 0, 1], [1, 1, 1, 2, 2, 2, 9, 9, 9]));
    s.apply(msg([1], [8, 8, 8], { agents: [0], offsets: [0, 1], points: [7, 7, 7] }));
    expect(Array.from(s.path(0).points)).toEqual([7, 7, 7]);
    expect(s.path(0)).toMatchObject({ count: 1, version: 1 });
    expect(Array.from(s.path(1).points)).toEqual([9, 9, 9, 8, 8, 8]);
    expect(s.path(1).version).toBe(0);
  });

  it("ignores agent indices it does not know and never grows past TRAIL_MAX_POINTS", () => {
    const s = new TrailStore(1);
    s.apply(msg([5], [1, 1, 1]));
    const n = TRAIL_MAX_POINTS + 10;
    s.apply(msg(new Array<number>(n).fill(0), new Array<number>(n * 3).fill(1)));
    expect(s.path(0).count).toBe(TRAIL_MAX_POINTS);
  });
});
