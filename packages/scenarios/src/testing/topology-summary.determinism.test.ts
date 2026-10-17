import { describe, it } from "vitest";
import { expectSummaryMatchesGolden } from "./topology-summary-golden.ts";

describe("topological layer summaries (ADR-0039 §6, Node)", () => {
  it("every agent's space summary after 200 ticks matches golden", () => expectSummaryMatchesGolden());
});
