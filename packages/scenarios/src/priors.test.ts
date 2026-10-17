import { BELIEF_FREE, BELIEF_OCCUPIED, BELIEF_UNKNOWN, encodeChunkRle } from "@agentsim/spatial";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { assembleRun } from "./assemble/assemble.ts";
import { loadScenario, scenarioAgents } from "./load.ts";
import { resolveRunConfig } from "./run-config/resolve.ts";
import type { RunConfigDocument } from "./run-config/schema.ts";
import { SCENARIO_LIMITS, type PriorSpec, type ScenarioDocument } from "./schema.ts";
import { parseScenarioValue, type ScenarioErrorCode } from "./validate.ts";

const CS = 16;

/** 32 × 32 m at 1 m (2 × 2 chunks of 16); a UGV and a UAV. */
function doc(priors?: PriorSpec[]): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "priors",
    name: "Priors",
    defaultSeed: 3,
    world: { resolutionM: 1, sizeCells: { x: 32, y: 32 }, chunkSize: CS, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [],
    agents: [
      { kind: "ugv", key: "rover", start: { xM: 4, yM: 4 } },
      { kind: "uav", key: "scout", start: { xM: 6, yM: 6 } },
    ],
    ...(priors ? { priors } : {}),
  };
}

/** A prior with one chunk (0, 0): a wall at i = 10 for j < 16 (occupied, 4 m), everything else in the chunk free. */
function wallPrior(id = "survey", confidence = 1): PriorSpec {
  const k = new Uint8Array(CS * CS).fill(1);
  const h = new Uint16Array(CS * CS);
  for (let j = 0; j < CS; j++) {
    k[j * CS + 10] = 2;
    h[j * CS + 10] = 40;
  }
  return {
    id,
    description: "survey from before the works",
    confidence,
    layers: { knowledge: { chunks: [{ ci: 0, cj: 0, rle: encodeChunkRle(k, 1) }] }, heightDm: { chunks: [{ ci: 0, cj: 0, rle: encodeChunkRle(h, 2) }] } },
  };
}

function expectCode(r: { ok: boolean; error?: { code: string } }, code: ScenarioErrorCode) {
  expect(r.ok ? null : r.error?.code).toBe(code);
}

function build(d: ScenarioDocument, runConfig: Partial<RunConfigDocument>) {
  const loaded = loadScenario(d);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: d.id, version: 1 }, ...runConfig }, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 10_000);
  return { ...assembleRun(loaded.value, resolved.value, trace, { dtS: 0.1 }), resolved: resolved.value };
}

describe("scenario prior maps (ADR-0025 addition of 2026-10-09)", () => {
  it("validates: duplicate ids, chunks outside the world, duplicate chunks, knowledge values, size limit", () => {
    expect(parseScenarioValue(doc([wallPrior()])).ok).toBe(true);
    expectCode(parseScenarioValue(doc([wallPrior("a"), wallPrior("a")])), "prior_id_duplicate");
    const outside = wallPrior();
    expectCode(parseScenarioValue(doc([{ ...outside, layers: { knowledge: { chunks: [{ ci: 2, cj: 0, fill: 1 }] } } }])), "prior_size_mismatch");
    expectCode(parseScenarioValue(doc([{ ...outside, layers: { knowledge: { chunks: [{ ci: 0, cj: 0, fill: 1 }, { ci: 0, cj: 0, fill: 2 }] } } }])), "duplicate_chunk");
    expectCode(parseScenarioValue(doc([{ ...outside, layers: { knowledge: { chunks: [{ ci: 0, cj: 0, fill: 3 }] } } }])), "invalid_document");
    const nine = Array.from({ length: SCENARIO_LIMITS.maxPriors + 1 }, (_, k) => wallPrior(`p${k}`));
    expectCode(parseScenarioValue(doc(nine)), "invalid_document");
    expectCode(parseScenarioValue(doc([{ ...wallPrior(), confidence: 0 }])), "invalid_document");
  });

  it("rejects a prior over 4 MiB encoded", () => {
    // 1024 chunks of a 512 × 512 world, each a distinct maximal RLE string: well over the limit.
    const big: ScenarioDocument = { ...doc(), world: { ...doc().world, sizeCells: { x: 512, y: 512 } } };
    const rle = "A".repeat(8000);
    const chunks = Array.from({ length: 1024 }, (_, n) => ({ ci: n % 32, cj: Math.floor(n / 32), rle }));
    expectCode(parseScenarioValue({ ...big, priors: [{ id: "big", confidence: 1, layers: { knowledge: { chunks } } }] }), "prior_too_large");
  });

  it("decoding is checked: RLE errors and knowledge values above 2 in RLE chunks", () => {
    expectCode(loadScenario(doc([{ ...wallPrior(), layers: { knowledge: { chunks: [{ ci: 0, cj: 0, rle: "AAAA" }] } } }])), "layer_decode_failed");
    const bad = new Uint8Array(CS * CS).fill(3);
    expectCode(loadScenario(doc([{ ...wallPrior(), layers: { knowledge: { chunks: [{ ci: 0, cj: 0, rle: encodeChunkRle(bad, 1) }] } } }])), "layer_value_out_of_range");
  });

  it("loads to a dense map: absent chunks unknown, heights where given", () => {
    const loaded = loadScenario(doc([wallPrior()]));
    if (!loaded.ok) throw new Error(loaded.error.message);
    const p = loaded.value.priors[0];
    expect(p?.knowledge[3 * 32 + 10]).toBe(2);
    expect(p?.heightDm?.[3 * 32 + 10]).toBe(40);
    expect(p?.knowledge[3 * 32 + 9]).toBe(1);
    expect(p?.knowledge[20 * 32 + 20]).toBe(0); // chunk (1, 1) absent
    expect(p?.terrainCost).toBeUndefined();
  });

  it("run config: an unknown prior id fails with prior_not_found; the prior's content enters effectiveConfigHash", () => {
    const view = scenarioAgents(doc([wallPrior()]));
    const r = (d: ScenarioDocument, prior: string) =>
      resolveRunConfig({ schemaVersion: 0, scenario: { id: "priors", version: 1 }, beliefs: { byAgent: { rover: { init: { prior } } } } }, { loaded: scenarioAgents(d), version: 1 });
    expect(r(doc([wallPrior()]), "nope")).toMatchObject({ ok: false, error: { code: "prior_not_found" } });
    expect(r(doc([wallPrior()]), "toString")).toMatchObject({ ok: false, error: { code: "prior_not_found" } }); // not an inherited property
    const a = r(doc([wallPrior()]), "survey");
    const b = r(doc([wallPrior("survey", 0.5)]), "survey");
    if (!a.ok || !b.ok) throw new Error("resolve");
    expect(a.value.runConfigHash).toBe(b.value.runConfigHash); // the run configuration is the same document
    expect(a.value.effectiveConfigHash).not.toBe(b.value.effectiveConfigHash); // what the simulator used is not
    expect(a.value.agents.find((x) => x.key === "rover")?.beliefs.priorHash).toBe(view.priorHashes?.["survey"]);
  });

  it("a prior agent starts with exactly the prior's cells; unknown and ideal agents do not", () => {
    const run = build(doc([wallPrior("survey", 0.5)]), { beliefs: { byAgent: { rover: { init: { prior: "survey" } } }, byKind: { uav: { init: "unknown" } } } });
    const rover = run.agents.find((a) => a.key === "rover");
    const scout = run.agents.find((a) => a.key === "scout");
    if (!rover || !scout) throw new Error("agents");
    const b = run.sensing.belief(rover.id);
    expect(b.state(10, 3)).toBe(BELIEF_OCCUPIED);
    expect(b.logOdds(10, 3)).toBe(30);
    expect(b.knownMaxM(10, 3)).toBe(4);
    expect(b.state(9, 3)).toBe(BELIEF_FREE);
    expect(b.state(20, 20)).toBe(BELIEF_UNKNOWN);
    expect(run.sensing.belief(scout.id).materializedChunks).toBe(0);
  });
});
