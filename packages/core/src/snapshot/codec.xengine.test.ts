import { describe, expect, it } from "vitest";
import { CODEC_GOLDEN, encodeCodecGolden } from "./codec-golden.ts";

// Runs in Chromium and Firefox (Vitest browser project "xengine"): every engine must write the snapshot codec's bytes
// exactly as Node does, so a snapshot taken in one engine restores and hashes the same in another (ADR-0023, ADR-0035).
describe("snapshot codec (cross-engine)", () => {
  it("encodes the golden value and container to the bytes and hashes generated in Node", () => {
    expect(encodeCodecGolden()).toEqual(CODEC_GOLDEN);
  });
});
