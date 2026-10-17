import { StateHasher } from "@agentsim/core";
import { it } from "vitest";
import { measure, recordResults } from "../../../../tools/bench/measure.ts";
import { BeliefMap } from "./belief-map.ts";

// F2 M2b: belief maps enter the state hash, which is taken every tick. Worst case for the hash: 20 agents that
// have each observed the whole 1 km² reference world (2,000² cells, 1,024 chunks of 64², with height arrays),
// and whose lidar changes 9 chunks per tick. Cached per-chunk hashes keep this to the changed chunks. Report only.
it("belief maps in the state hash: 20 fully explored 1 km² maps, 9 chunks changed per agent per tick", () => {
  const n = 2000;
  const maps: BeliefMap[] = [];
  for (let a = 0; a < 20; a++) {
    const m = new BeliefMap(n, n, 64);
    for (let j = 0; j < n; j += 8) for (let i = 0; i < n; i += 8) m.observeHit(i, j, 1, 30); // every chunk, with heights
    maps.push(m);
  }
  const h = new StateHasher();
  for (const m of maps) m.hashInto(h); // fills the caches, as the first tick of a run would
  let tick = 0;
  const r = measure({
    iterations: 100,
    warmup: 10,
    setup: () => {
      tick++;
      // 3 × 3 chunks around a moving point per agent: what one lidar reading touches.
      for (const [a, m] of maps.entries()) {
        const ci = (tick + a * 7) % 30;
        for (let dj = 0; dj < 3; dj++) for (let di = 0; di < 3; di++) m.observeFree((ci + di) * 64 + 3, (ci + dj) * 64 + 5 + (tick % 10), 20);
      }
      return new StateHasher();
    },
    run: (hasher) => {
      for (const m of maps) m.hashInto(hasher);
    },
  });
  recordResults("node.json", { "sim.beliefHash20Explored": r });
});
