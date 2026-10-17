import { describe, it } from "vitest";
import { expectBodiesHashMatchesGolden, expectDetmathMatchesGolden, expectDrivesHashMatchesGolden, expectProbeHashMatchesGolden } from "./golden-check.ts";

// Runs in Chromium and Firefox (Vitest browser project "xengine"): every engine must reproduce the
// golden bits and state hash generated in Node (ADR-0023).
describe("golden determinism (cross-engine)", () => {
  it("detmath outputs match the golden bits", () => expectDetmathMatchesGolden());
  it("probe world state hash after 10k ticks matches golden", () => expectProbeHashMatchesGolden());
  it("UGV pure pursuit, UAV and battery state hash matches golden", () => expectBodiesHashMatchesGolden());
  it("differential (rotation in place, reverse) and Ackermann (cusp) drive hashes match golden", () => expectDrivesHashMatchesGolden());
});
