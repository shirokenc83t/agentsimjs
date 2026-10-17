import { initValidation } from "@agentsim/core";
import { beforeAll, describe, it } from "vitest";
import { expectReferenceRunMatchesGolden } from "./reference-run-golden.ts";

// Runs in Chromium and Firefox (Vitest browser project "xengine"): the whole F1 stack must reproduce
// the state hashes generated in Node (ADR-0002, ADR-0023).
describe("F1 reference run (cross-engine)", () => {
  beforeAll(() => initValidation());
  it("state hash every 100 ticks matches golden", () => expectReferenceRunMatchesGolden());
});
