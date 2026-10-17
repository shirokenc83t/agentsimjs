import { initValidation } from "@agentsim/core";
import { beforeAll, describe, it } from "vitest";
import { expectSummaryMatchesGolden } from "./topology-summary-golden.ts";

// Runs in Chromium and Firefox: summaries must be byte-identical to Node's (ADR-0039 §6, ADR-0023).
describe("topological layer summaries (cross-engine)", () => {
  beforeAll(() => initValidation());
  it("every agent's space summary after 200 ticks matches golden", () => expectSummaryMatchesGolden());
});
