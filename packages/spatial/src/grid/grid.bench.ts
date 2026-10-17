import { StateHasher } from "@agentsim/core";
import { expect, it } from "vitest";
import { measure, recordResults, summarize } from "../../../../tools/bench/measure.ts";
import { encodeChunkRle } from "../codec/chunk-rle.ts";
import { OCCUPANCY_BLOCKED } from "./grid-space.ts";
import { buildReferenceWorld } from "../presets/reference-world.ts";

it("spatial grid benchmarks (report only)", () => {
  const g = buildReferenceWorld();
  const pyramidBuild = measure({ iterations: 5, warmup: 1, setup: () => buildReferenceWorld(), run: (w) => void w.pyramid() });

  const dirtyRebuild = measure({
    iterations: 50,
    setup: () => {
      g.pyramid();
      return g;
    },
    run: (w) => {
      w.setCell("occupancy", 1000, 1000, w.isBlocked(1000, 1000) ? 0 : OCCUPANCY_BLOCKED);
      w.pyramid();
    },
  });

  const fullHash = measure({
    iterations: 10,
    setup: () => {
      // invalidate every chunk hash so the full cost is measured
      for (let cj = 0; cj < g.chunksY; cj++) for (let ci = 0; ci < g.chunksX; ci++) g.setCell("occupancy", ci * 64, cj * 64, g.isBlocked(ci * 64, cj * 64) ? 0 : OCCUPANCY_BLOCKED);
      return new StateHasher();
    },
    run: (h) => g.hashInto(h),
  });

  // Encoded layer sizes for the reference world (ADR-0025 report).
  const vals8 = new Uint8Array(64 * 64);
  const vals16 = new Uint16Array(64 * 64);
  let rleBytes = 0;
  let uniformChunks = 0;
  for (const [layer, buf, bpv] of [[g.occupancy, vals8, 1], [g.terrainCost, vals8, 1], [g.heightDm, vals16, 2]] as const) {
    for (let cj = 0; cj < g.chunksY; cj++) {
      for (let ci = 0; ci < g.chunksX; ci++) {
        if (layer.uniformValue(ci, cj) !== null) {
          uniformChunks++;
          continue;
        }
        layer.readChunk(ci, cj, buf);
        rleBytes += encodeChunkRle(buf, bpv).length;
      }
    }
  }
  const rawBytes = 2000 * 2000 * 4; // occupancy + terrain + height (u8 + u8 + u16)

  recordResults("node.json", {
    "spatial.pyramidBuild": pyramidBuild,
    "spatial.pyramidDirtyRebuild": dirtyRebuild,
    "spatial.gridHashFull": fullHash,
    "spatial.memoryMaterialized": summarize([g.materializedBytes()], "bytes"),
    "scenario.layersRleBytes": summarize([rleBytes], "bytes"),
    "scenario.layersRawBytes": summarize([rawBytes], "bytes"),
  });
  console.log(`reference world: ${uniformChunks} uniform chunk-layers, RLE ${(rleBytes / 1024).toFixed(0)} KiB vs raw ${(rawBytes / 1024).toFixed(0)} KiB`);
  expect(rleBytes).toBeGreaterThan(0);
});
