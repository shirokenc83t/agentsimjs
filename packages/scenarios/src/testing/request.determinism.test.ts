import { describe, expect, it } from "vitest";
import { computeRequestHash, expectRequestsMatchGolden } from "./request-golden.ts";

describe("decision requests (ADR-0005 addition of 2026-10-11, Node)", () => {
  it("the request sequence of 200 ticks matches golden", () => expectRequestsMatchGolden());

  it("fairness: the same run under minds of every tier produces byte-identical requests", async () => {
    const base = await computeRequestHash("baseline");
    for (const tier of ["S1", "S2", "script", "external"] as const) expect(await computeRequestHash(tier), tier).toEqual(base);
  });
});
