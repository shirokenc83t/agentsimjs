import { initValidation } from "@agentsim/core";
import { beforeAll, describe, it } from "vitest";
import { expectRequestsMatchGolden } from "./request-golden.ts";

// Runs in Chromium and Firefox: the request sequence must be byte-identical to Node's (ADR-0005, ADR-0023).
describe("decision requests (cross-engine)", () => {
  beforeAll(() => initValidation());
  it("the request sequence of 200 ticks matches golden", () => expectRequestsMatchGolden());
});
