import { StateHasher } from "@agentsim/core";
import { canonicalJson, f1DemoScenario, f2DiscoveryScenario, f2PriorReferenceScenario, f2TwentyAgentsScenario, loadScenario, resolveRunConfig, type ScenarioDocument } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { ScenarioDraft } from "./model.ts";

const open = (doc: ScenarioDocument): ScenarioDraft => {
  const r = ScenarioDraft.fromDocument(doc);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const gridHash = (d: ScenarioDraft) => {
  const h = new StateHasher();
  d.grid.hashInto(h);
  return h.hex();
};

describe("scenario editor: objects and priors are carried through losslessly", () => {
  it.each([
    ["F1 demo", f1DemoScenario],
    ["F2 discovery (with an object)", f2DiscoveryScenario],
    ["F2 20 agents", f2TwentyAgentsScenario],
    ["F2 prior map (1 km², a prior with all its layers and confidence)", f2PriorReferenceScenario],
  ])("%s: document → editor → document is identical when nothing is edited", (_name, make) => {
    const doc = make();
    const d = open(doc);
    expect(canonicalJson(d.toDocument())).toBe(canonicalJson(doc));
    // Viewing a prior (decoding it for the overlay) is not an edit either.
    for (const p of doc.priors ?? []) d.priorKnowledge(p.id);
    expect(canonicalJson(d.toDocument())).toBe(canonicalJson(doc));
  }, 120000);
});

describe("scenario editor: objects", () => {
  it("are placed with fresh ids, moved, edited and deleted; the document carries them", () => {
    const d = open(f2DiscoveryScenario());
    expect(d.objects.map((o) => o.id)).toEqual(["marker-1"]);
    const k = d.addObject(20.123, 30.456);
    expect(d.objects[k]).toMatchObject({ id: "marker-2", kind: "marker", position: { xM: 20.12, yM: 30.46 } });
    d.moveObject(k, 25, 26);
    d.updateObject(k, (o) => ({ ...o, label: "Beacon", size: { radiusM: 1, heightM: 2 } }));
    expect(d.objectNear(25.2, 26, 1)).toBe(k);
    expect(d.toDocument().objects?.map((o) => o.id)).toEqual(["marker-1", "marker-2"]);
    d.deleteObject(k);
    expect(d.toDocument().objects).toHaveLength(1);
  });

  it("an id in the agent-ID form, a duplicate, and a position outside the map are refused with the loader's codes", () => {
    const d = open(f2DiscoveryScenario());
    expect(d.validateExtras()).toEqual({ ok: true });
    const k = d.addObject(10, 10);
    d.updateObject(k, (o) => ({ ...o, id: "ugv-001" }));
    expect(d.validateExtras()).toMatchObject({ ok: false, error: { code: "object_id_reserved", path: "/objects/1/id" } });
    d.updateObject(k, (o) => ({ ...o, id: "marker-1" }));
    expect(d.validateExtras()).toMatchObject({ ok: false, error: { code: "object_id_duplicate" } });
    d.updateObject(k, (o) => ({ ...o, id: "marker-2", position: { xM: 5000, yM: 5 } }));
    expect(d.validateExtras()).toMatchObject({ ok: false, error: { code: "object_out_of_bounds" } });
    d.updateObject(k, (o) => ({ ...o, position: { xM: 5, yM: 5 } }));
    expect(d.validateExtras()).toEqual({ ok: true });
  });
});

describe("scenario editor: priors", () => {
  it("a prior made from the world knows it all; hide and flip brushes edit the prior only, never the world; undo; the document round-trips", () => {
    const d = open(f2DiscoveryScenario());
    const world = gridHash(d);
    expect(d.createPriorFromWorld("survey", 0.8, "stale survey")).toEqual({ ok: true });
    expect(d.priorSummaries()).toEqual([expect.objectContaining({ id: "survey", confidence: 0.8, knownPct: 100, wrongPct: 0, edited: true })]);
    // Hide a disc, flip another: only the prior changes.
    expect(d.beginPriorStroke("survey", 20, 20, { value: "unknown", radiusCells: 3 })).toBeGreaterThan(20);
    d.endPriorStroke("survey");
    expect(d.beginPriorStroke("survey", 10, 40, { value: "flip", radiusCells: 2 })).toBeGreaterThan(5);
    d.endPriorStroke("survey");
    expect(gridHash(d)).toBe(world);
    const s = d.priorSummaries()[0];
    expect(s?.knownPct).toBeLessThan(100);
    expect(s?.wrongPct).toBeGreaterThan(0);
    // Dirty chunks are reported once, for the view.
    expect(d.drainPriorDirty("survey").length).toBeGreaterThan(0);
    expect(d.drainPriorDirty("survey")).toEqual([]);
    // Undo restores the cells of the last stroke.
    const wrong = s?.wrongPct ?? 0;
    expect(d.undoPrior("survey")).toBe(true);
    expect(d.priorSummaries()[0]?.wrongPct).toBeLessThan(wrong);
    // Saved and reopened: the same knowledge, and the document is valid.
    const doc = d.toDocument();
    expect(doc.priors?.map((p) => p.id)).toEqual(["survey"]);
    expect(open(doc).priorKnowledge("survey")).toEqual(d.priorKnowledge("survey"));
    expect(d.validateExtras()).toEqual({ ok: true });
    expect(gridHash(d)).toBe(world);
  });

  it("an edited prior has a new content hash, which changes effectiveConfigHash for runs that use it; an untouched one does not", () => {
    const doc0 = (() => {
      const d = open(f2DiscoveryScenario());
      d.createPriorFromWorld("survey", 0.8);
      return d.toDocument();
    })();
    const config = { schemaVersion: 0 as const, scenario: { id: doc0.id, version: 1 }, beliefs: { default: { init: "unknown" as const }, byAgent: { rover: { init: { prior: "survey" } } } } };
    const resolve = (doc: ScenarioDocument) => {
      const l = loadScenario(doc);
      if (!l.ok) throw new Error(l.error.message);
      const r = resolveRunConfig(config, { loaded: l.value, version: 1 });
      if (!r.ok) throw new Error(r.error.message);
      return { hash: r.value.effectiveConfigHash, prior: l.value.priorHashes["survey"] };
    };
    const a = resolve(doc0);
    const untouched = open(doc0);
    untouched.priorKnowledge("survey");
    expect(resolve(untouched.toDocument())).toEqual(a);
    const edited = open(doc0);
    edited.beginPriorStroke("survey", 30, 30, { value: "unknown", radiusCells: 4 });
    edited.endPriorStroke("survey");
    const b = resolve(edited.toDocument());
    expect(b.prior).not.toBe(a.prior);
    expect(b.hash).not.toBe(a.hash);
  });

  it("creating a prior refuses a duplicate id, a bad id, a bad confidence, and more than the limit, with stable codes", () => {
    const d = open(f2DiscoveryScenario());
    expect(d.createPriorFromWorld("survey", 0.5)).toEqual({ ok: true });
    expect(d.createPriorFromWorld("survey", 0.5)).toMatchObject({ ok: false, code: "prior_id_duplicate" });
    expect(d.createPriorFromWorld("Bad Id", 0.5)).toMatchObject({ ok: false, code: "invalid_id" });
    expect(d.createPriorFromWorld("other", 0)).toMatchObject({ ok: false, code: "invalid_confidence" });
    for (let k = 0; k < 7; k++) expect(d.createPriorFromWorld(`p${k}`, 1)).toEqual({ ok: true });
    expect(d.createPriorFromWorld("p9", 1)).toMatchObject({ ok: false, code: "too_many_priors" });
  });

  it("the loader's prior codes surface in the draft's validation: a chunk outside the map, and an encoding over the size limit", () => {
    const made = open(f2DiscoveryScenario());
    made.createPriorFromWorld("survey", 0.5);
    const d = open(made.toDocument()); // an unedited prior passes through as written (its layers are the document's)
    const p = d.priors[0];
    if (!p) throw new Error("no prior");
    d.priors = [{ ...p, layers: { knowledge: { chunks: [{ ci: 99, cj: 0, fill: 1 }] } } }];
    expect(d.validateExtras()).toMatchObject({ ok: false, error: { code: "prior_size_mismatch" } });
    d.priors = [{ ...p, layers: { knowledge: { chunks: Array.from({ length: 200_000 }, () => ({ ci: 0, cj: 0, fill: 1 })) } } }];
    expect(d.validateExtras()).toMatchObject({ ok: false, error: { code: "prior_too_large" } });
  });
});
