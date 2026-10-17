import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSURE_STATE } from "../../packages/scenarios/src/assemble/snapshot-inventory.ts";

// F3a M1: state kept in closures cannot be found by walking objects, so the inventory lists it by a token of its
// source (packages/scenarios/src/assemble/snapshot-inventory.ts, CLOSURE_STATE). A closure that was removed or renamed
// must be looked at: either its state became explicit (update the inventory) or it moved. Runs from the repository root.
describe("snapshot inventory: closure state", () => {
  it("finds each listed closure in its source file", () => {
    const gone = CLOSURE_STATE.filter((c) => !readFileSync(join("packages", c.file), "utf8").includes(c.token)).map((c) => `${c.where} (${c.file}: ${c.token})`);
    expect(gone).toEqual([]);
  });
});
