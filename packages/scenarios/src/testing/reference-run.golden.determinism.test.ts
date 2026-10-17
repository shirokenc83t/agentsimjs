import { describe, it } from "vitest";
import { expectReferenceRunMatchesGolden } from "./reference-run-golden.ts";

describe("F1 reference run (Node)", { timeout: 60_000 }, () => {
  it("state hash every 100 ticks matches golden", () => expectReferenceRunMatchesGolden());
});
