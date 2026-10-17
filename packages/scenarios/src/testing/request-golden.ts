import { runLockstep, type Brain, type BrainTier, type DecisionEnvelope, type DecisionRequest } from "@agentsim/core";
import { expect } from "vitest";
import { hash32Hex } from "../canonical.ts";
import golden from "./request.golden.json";
import { buildReferenceRun } from "./reference-run.ts";

export const REQUEST_TICKS = 200;

/** Records every request and answers by a fixed rule (explore when idle, else idle), whatever its own tier. */
class Recorder implements Brain {
  readonly requests: DecisionRequest[] = [];
  constructor(
    readonly id: string,
    readonly tier: BrainTier,
  ) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    return Promise.resolve({ decision: req.self.running === null ? { kind: "action", name: "explore", params: {} } : { kind: "idle" } });
  }
}

/** The F1 reference run with `unknown` beliefs, an object to find and a recording mind on each agent. */
async function runRequests(tier: BrainTier): Promise<DecisionRequest[]> {
  const minds = { rover: new Recorder("m-rover", tier), low: new Recorder("m-low", tier), scout: new Recorder("m-scout", tier) };
  const run = buildReferenceRun({
    runConfig: { beliefs: { default: { init: "unknown" } } },
    scripts: {},
    brains: minds,
    objects: [{ id: "marker-1", kind: "marker", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } }],
  });
  await runLockstep(run.world, run.scheduler, REQUEST_TICKS);
  return [...minds.rover.requests, ...minds.low.requests, ...minds.scout.requests];
}

/**
 * ADR-0005 fairness and determinism: the sequence of decision requests of a 200-tick run, serialized exactly as a
 * provider adapter would see it (key order is part of the contract: no sorting). Covers rounding and number
 * serialization of the values minds see. Identical in Node, Chromium and Firefox.
 */
export async function computeRequestHash(tier: BrainTier = "baseline"): Promise<{ readonly hash: string; readonly requests: number; readonly bytes: number }> {
  const reqs = await runRequests(tier);
  const text = reqs.map((r) => JSON.stringify(r)).join("\n");
  // A meaningful golden: several requests per agent, with beliefs, frontiers and events in them.
  if (reqs.length < 6 || !reqs.some((r) => r.space.frontiers.length > 0) || !reqs.some((r) => r.beliefs.entities.length > 0) || !reqs.some((r) => r.events.length > 1)) throw new Error("requests are trivial");
  return { hash: hash32Hex(text), requests: reqs.length, bytes: text.length };
}

export async function expectRequestsMatchGolden(): Promise<void> {
  expect(golden.ticks).toBe(REQUEST_TICKS);
  const r = await computeRequestHash();
  expect(r.hash).toBe(golden.requestHash);
  expect(r.requests).toBe(golden.requests);
}
