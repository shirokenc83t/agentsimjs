import { expect } from "vitest";
import golden from "./golden.json";
import { computeBodiesHash, computeDetmathCases, computeDrivesHash, computeProbeHash, GOLDEN_BODIES, GOLDEN_PROBE } from "./golden-cases.ts";

/** Shared assertions for the Node and cross-engine (browser) golden tests. */
export function expectDetmathMatchesGolden(): void {
  const actual = computeDetmathCases();
  expect(actual.length).toBe(golden.detmath.length);
  const mismatches = actual.filter((c, i) => {
    const g = golden.detmath[i];
    return !g || g.fn !== c.fn || g.args.join() !== c.args.join() || g.out !== c.out;
  });
  expect(mismatches.slice(0, 10), `${mismatches.length} detmath outputs differ from golden`).toEqual([]);
}

export function expectProbeHashMatchesGolden(): void {
  expect(golden.probe.seed).toBe(GOLDEN_PROBE.seed);
  expect(computeProbeHash(golden.probe.seed, golden.probe.ticks)).toBe(golden.probe.hash);
}

export function expectBodiesHashMatchesGolden(): void {
  expect(golden.bodies.seed).toBe(GOLDEN_BODIES.seed);
  expect(computeBodiesHash(golden.bodies.seed)).toBe(golden.bodies.hash);
}

export function expectDrivesHashMatchesGolden(): void {
  expect(computeDrivesHash()).toEqual(golden.drives);
}
