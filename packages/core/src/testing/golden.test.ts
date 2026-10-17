import { describe, it } from "vitest";
import { expectBodiesHashMatchesGolden, expectDetmathMatchesGolden, expectDrivesHashMatchesGolden, expectProbeHashMatchesGolden } from "./golden-check.ts";

// Node (V8) half of the cross-engine determinism check (ADR-0023); see golden.xengine.test.ts.
describe("golden determinism (Node)", () => {
  it("detmath outputs match the golden bits", () => expectDetmathMatchesGolden());
  it("probe world state hash after 10k ticks matches golden", () => expectProbeHashMatchesGolden());
  it("UGV pure pursuit, UAV and battery state hash matches golden", () => expectBodiesHashMatchesGolden());
  it("differential (rotation in place, reverse) and Ackermann (cusp) drive hashes match golden", () => expectDrivesHashMatchesGolden());
});
