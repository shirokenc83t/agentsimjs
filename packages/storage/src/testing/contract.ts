import { parseSourceFilter, type RunHeader, type TraceRecord } from "@agentsim/trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoragePorts } from "../ports.ts";
import { describeRecordingContract } from "./recording-contract.ts";

/**
 * Shared contract suite for every StoragePorts implementation (CLAUDE.md: contract tests per port).
 * Run against: in-memory, SQL over node:sqlite, and the browser storage worker client.
 */
export interface ContractHarness {
  readonly ports: StoragePorts;
  dispose(): Promise<void>;
}

const header = (runId: string, extra: Partial<RunHeader> = {}): RunHeader => ({
  runId, schemaVersion: 0, createdAtWallMs: 1_700_000_000_000, label: `label ${runId}`, status: "running", ...extra,
});
const rec = (runId: string, seq: number, extra: Partial<TraceRecord> = {}): TraceRecord => ({
  id: `${runId}#${seq}`, runId, seq, simTime: seq * 0.1, wallTime: 1_700_000_000_000 + seq, source: "world/sim", kind: "event",
  payload: { seq, nested: { ok: true, list: [1, "two", null] } }, ...extra,
});

export function describeStorageContract(name: string, create: () => Promise<ContractHarness>): void {
  describe(`storage contract: ${name}`, () => {
    let h: ContractHarness;
    beforeEach(async () => {
      h = await create();
    });
    afterEach(async () => {
      await h.dispose();
    });

    describe("RunStore", () => {
      it("allocates sequential run IDs that are never reused", async () => {
        expect(await h.ports.runs.allocateRunId()).toBe("run-000001");
        expect((await h.ports.runs.create(header("run-000001"))).ok).toBe(true);
        expect(await h.ports.runs.allocateRunId()).toBe("run-000002");
        expect((await h.ports.runs.create(header("run-000005"))).ok).toBe(true);
        expect(await h.ports.runs.allocateRunId()).toBe("run-000006");
      });

      it("creates, gets, lists and updates runs", async () => {
        await h.ports.runs.create(header("run-000002", { seed: 42, scenario: "empty" }));
        await h.ports.runs.create(header("run-000001"));
        expect(await h.ports.runs.get("run-000002")).toEqual(header("run-000002", { seed: 42, scenario: "empty" }));
        expect(await h.ports.runs.get("run-999999")).toBeUndefined();
        expect((await h.ports.runs.setStatus("run-000001", "completed")).ok).toBe(true);
        const list = await h.ports.runs.list();
        expect(list.map((r) => [r.runId, r.status, r.recordCount])).toEqual([
          ["run-000001", "completed", 0],
          ["run-000002", "running", 0],
        ]);
      });

      it("rejects duplicates, invalid headers and unknown runs with stable codes", async () => {
        await h.ports.runs.create(header("run-000001"));
        const dup = await h.ports.runs.create(header("run-000001"));
        expect(dup.ok ? null : dup.error.code).toBe("duplicate_run");
        const bad = await h.ports.runs.create({ ...header("run-000003"), runId: "nope" });
        expect(bad.ok ? null : bad.error.code).toBe("invalid_header");
        const unk = await h.ports.runs.setStatus("run-000009", "aborted");
        expect(unk.ok ? null : unk.error.code).toBe("unknown_run");
      });

      const input = (n: number, tick: number, params: unknown = { xM: n, yM: 2.5 }) => ({
        inputId: `inp-${String(n).padStart(6, "0")}`,
        tick,
        agentId: "ugv-001",
        name: "goTo",
        params,
      });

      it("stores run inputs append-only, in input order, with an exact round trip of their params", async () => {
        await h.ports.runs.create(header("run-000001"));
        expect((await h.ports.runs.appendInputs("run-000001", [input(1, 6), input(2, 6)])).ok).toBe(true);
        expect((await h.ports.runs.appendInputs("run-000001", [input(3, 40, { xM: 1.25, yM: 0, nested: [1, "a", null] })])).ok).toBe(true);
        expect(await h.ports.runs.inputs("run-000001")).toEqual([input(1, 6), input(2, 6), input(3, 40, { xM: 1.25, yM: 0, nested: [1, "a", null] })]);
        expect(await h.ports.runs.inputs("run-000002")).toEqual([]);
      });

      it("rejects run inputs for unknown runs, invalid, duplicate or out-of-order inputs, all or nothing", async () => {
        await h.ports.runs.create(header("run-000001"));
        const code = async (runId: string, batch: unknown[]) => {
          const r = await h.ports.runs.appendInputs(runId, batch as never);
          return r.ok ? null : r.error.code;
        };
        expect(await code("run-000009", [input(1, 1)])).toBe("unknown_run");
        expect(await code("run-000001", [{ ...input(1, 1), tick: 0 }])).toBe("invalid_input");
        expect(await code("run-000001", [{ ...input(1, 1), inputId: "inp-1" }])).toBe("invalid_input");
        expect(await code("run-000001", [{ ...input(1, 1), extra: true }])).toBe("invalid_input");
        expect(await code("run-000001", [input(1, 5)])).toBe(null);
        expect(await code("run-000001", [input(2, 6), input(1, 7)])).toBe("duplicate_input");
        expect(await code("run-000001", [input(3, 4)])).toBe("non_monotonic_input");
        // A rejected batch leaves nothing behind.
        expect((await h.ports.runs.inputs("run-000001")).map((i) => i.inputId)).toEqual(["inp-000001"]);
      });
    });

    describe("TraceStore", () => {
      it("appends and pages records in seq order with exact round trip", async () => {
        await h.ports.runs.create(header("run-000001"));
        const batch = [rec("run-000001", 2), rec("run-000001", 0, { agentId: "uav-001", tier: "S2", parentId: "x" }), rec("run-000001", 1, { causeIds: ["b", "a", "a"] })];
        expect((await h.ports.trace.append(batch)).ok).toBe(true);
        await h.ports.trace.flush();
        expect(await h.ports.trace.count("run-000001")).toBe(3);
        const all = await h.ports.trace.query({ runId: "run-000001", limit: 10 });
        expect(all.map((r) => r.seq)).toEqual([0, 1, 2]);
        expect(all[0]).toEqual(rec("run-000001", 0, { agentId: "uav-001", tier: "S2", parentId: "x" }));
        expect(all[1]?.causeIds).toEqual(["a", "b"]);
        const page = await h.ports.trace.query({ runId: "run-000001", afterSeq: 0, limit: 1 });
        expect(page.map((r) => r.seq)).toEqual([1]);
        expect((await h.ports.runs.list())[0]?.recordCount).toBe(3);
      });

      it("rejects invalid, duplicate and orphan records atomically", async () => {
        await h.ports.runs.create(header("run-000001"));
        await h.ports.trace.append([rec("run-000001", 0)]);
        const dup = await h.ports.trace.append([rec("run-000001", 1), rec("run-000001", 0)]);
        expect(dup.ok ? null : dup.error.code).toBe("duplicate_seq");
        expect(await h.ports.trace.count("run-000001")).toBe(1); // nothing from the failed batch
        const orphan = await h.ports.trace.append([rec("run-000042", 0)]);
        expect(orphan.ok ? null : orphan.error.code).toBe("unknown_run");
        const invalid = await h.ports.trace.append([{ ...rec("run-000001", 5), kind: "telepathy" } as unknown as TraceRecord]);
        expect(invalid.ok ? null : invalid.error.code).toBe("invalid_record");
      });

      it("rejects records without a valid source (ADR-0031)", async () => {
        await h.ports.runs.create(header("run-000001"));
        for (const source of ["uav-001/mind", "world/planner", "uav-001", "x' OR '1'='1/sim"]) {
          const r = await h.ports.trace.append([rec("run-000001", 0, { source })]);
          expect(r.ok ? null : r.error.code, source).toBe("invalid_record");
        }
        const { source: _s, ...noSource } = rec("run-000001", 0);
        const r = await h.ports.trace.append([noSource as TraceRecord]);
        expect(r.ok ? null : r.error.code).toBe("invalid_record");
        expect(await h.ports.trace.count("run-000001")).toBe(0);
      });

      it("filters by source: exact, owner/*, */component, OR lists and negation (ADR-0031)", async () => {
        await h.ports.runs.create(header("run-000001"));
        const sources = ["uav-001/planner", "uav-001/body", "uav-002/planner", "uav-002/reflexes", "world/sim", "grp-001/policy", "clean-tasks#17/protocol"];
        // Subject and emitter differ for the world/sim record: it is about uav-001.
        await h.ports.trace.append(sources.map((source, seq) => rec("run-000001", seq, { source, ...(source === "world/sim" ? { agentId: "uav-001" } : {}) })));
        const q = async (source?: { include?: string; exclude?: string }) => {
          const parse = (v: string | undefined) => {
            if (v === undefined) return undefined;
            const p = parseSourceFilter(v);
            if (!p.ok) throw new Error(p.error.message);
            return p.value;
          };
          const include = parse(source?.include);
          const exclude = parse(source?.exclude);
          const recs = await h.ports.trace.query({ runId: "run-000001", limit: 100, source: { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) } });
          return recs.map((r) => r.source);
        };
        expect(await q({ include: "uav-001/planner" })).toEqual(["uav-001/planner"]);
        expect(await q({ include: "uav-001/*" })).toEqual(["uav-001/planner", "uav-001/body"]);
        expect(await q({ include: "*/planner" })).toEqual(["uav-001/planner", "uav-002/planner"]);
        expect(await q({ include: "uav-002/*,world/sim" })).toEqual(["uav-002/planner", "uav-002/reflexes", "world/sim"]);
        expect(await q({ exclude: "*/planner" })).toEqual(["uav-001/body", "uav-002/reflexes", "world/sim", "grp-001/policy", "clean-tasks#17/protocol"]);
        expect(await q({ include: "uav-001/*", exclude: "*/body" })).toEqual(["uav-001/planner"]);
        expect(await q({ include: "clean-tasks#17/protocol" })).toEqual(["clean-tasks#17/protocol"]);
        // The combined string round-trips exactly.
        expect(await q()).toEqual(sources);
      });

      it("keeps seq order equal to sim-time order within a run (ADR-0031 amendment)", async () => {
        await h.ports.runs.create(header("run-000001"));
        await h.ports.runs.create(header("run-000002"));
        await h.ports.trace.append([rec("run-000001", 0, { simTime: 1 }), rec("run-000001", 1, { simTime: 2 })]);
        // Backwards within a batch, against stored records, and filling a gap with a wrong time.
        for (const batch of [
          [rec("run-000001", 2, { simTime: 3 }), rec("run-000001", 3, { simTime: 2.5 })],
          [rec("run-000001", 2, { simTime: 1.5 })],
        ]) {
          const r = await h.ports.trace.append(batch);
          expect(r.ok ? null : r.error.code).toBe("non_monotonic_time");
        }
        await h.ports.trace.append([rec("run-000001", 5, { simTime: 5 })]);
        const gap = await h.ports.trace.append([rec("run-000001", 3, { simTime: 6 })]);
        expect(gap.ok ? null : gap.error.code).toBe("non_monotonic_time");
        // Equal times are fine, gaps with consistent times are fine, and runs are independent.
        expect((await h.ports.trace.append([rec("run-000001", 3, { simTime: 2 }), rec("run-000001", 4, { simTime: 5 })])).ok).toBe(true);
        expect((await h.ports.trace.append([rec("run-000002", 0, { simTime: 0 })])).ok).toBe(true);
        expect(await h.ports.trace.count("run-000001")).toBe(5);
      });

      it("maps a sim-time window to the run's records, combined with source filters and paging", async () => {
        await h.ports.runs.create(header("run-000001"));
        const owners = ["uav-001", "uav-002"];
        // Three records per tick (0.1 s), two owners.
        await h.ports.trace.append(
          Array.from({ length: 30 }, (_, seq) => rec("run-000001", seq, { simTime: Math.floor(seq / 3) / 10, source: `${owners[seq % 2] ?? "uav-001"}/planner` })),
        );
        const window = await h.ports.trace.query({ runId: "run-000001", limit: 100, simTime: { from: 0.2, to: 0.4 } });
        expect(window.map((r) => r.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
        const p = parseSourceFilter("uav-002/*");
        if (!p.ok) throw new Error("filter");
        const filtered = await h.ports.trace.query({ runId: "run-000001", limit: 2, afterSeq: 7, simTime: { from: 0.2, to: 0.4 }, source: { include: p.value } });
        expect(filtered.map((r) => r.seq)).toEqual([9, 11]);
        expect(await h.ports.trace.query({ runId: "run-000001", limit: 100, simTime: { from: 5, to: 6 } })).toEqual([]);
        expect(await h.ports.trace.query({ runId: "run-000001", limit: 100, simTime: { from: 0.4, to: 0.2 } })).toEqual([]);
        expect((await h.ports.trace.query({ runId: "run-000001", limit: 100, simTime: { to: 0.05 } })).map((r) => r.seq)).toEqual([0, 1, 2]);
      });

      it("rejects malformed source patterns that bypass the parser", async () => {
        await h.ports.runs.create(header("run-000001"));
        const evil = [{ owner: "x' OR '1'='1", component: null }, { owner: null, component: null }, { owner: "uav-001", component: "drop" }] as const;
        for (const p of evil) {
          await expect(h.ports.trace.query({ runId: "run-000001", limit: 10, source: { include: [p as never] } })).rejects.toThrow();
        }
      });

      it("handles a large batch", async () => {
        await h.ports.runs.create(header("run-000001"));
        const many = Array.from({ length: 2000 }, (_, i) => rec("run-000001", i));
        expect((await h.ports.trace.append(many)).ok).toBe(true);
        await h.ports.trace.flush();
        expect(await h.ports.trace.count("run-000001")).toBe(2000);
      });
    });

    describe("ResponseCache", () => {
      it("stores and returns JSON values by key", async () => {
        expect(await h.ports.cache.get("k")).toBeUndefined();
        await h.ports.cache.put("k", { model: "m", value: { text: "hi", n: [1, 2] }, createdAtWallMs: 5 });
        expect(await h.ports.cache.get("k")).toEqual({ model: "m", value: { text: "hi", n: [1, 2] }, createdAtWallMs: 5 });
        await h.ports.cache.put("k", { model: "m2", value: null, createdAtWallMs: 6 });
        expect((await h.ports.cache.get("k"))?.model).toBe("m2");
      });
    });

    describe("ScenarioStore", () => {
      const scenario = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
        schemaVersion: 0, id, name, world: { layers: { occupancy: { chunks: [{ ci: 0, cj: 0, rle: "gCAB" }] } } }, zones: [], agents: [], ...extra,
      });

      it("saves numbered versions, lists the latest per id and gets any version", async () => {
        expect(await h.ports.scenarios.list()).toEqual([]);
        expect(await h.ports.scenarios.saveVersion(scenario("beta", "Beta"))).toEqual({ ok: true, value: { id: "beta", version: 1 } });
        expect(await h.ports.scenarios.saveVersion(scenario("alpha", "Alpha"))).toEqual({ ok: true, value: { id: "alpha", version: 1 } });
        expect(await h.ports.scenarios.saveVersion(scenario("alpha", "Alpha 2", { defaultSeed: 9 }))).toEqual({ ok: true, value: { id: "alpha", version: 2 } });
        const list = await h.ports.scenarios.list();
        expect(list.map((s) => [s.id, s.name, s.latestVersion, s.versionCount])).toEqual([
          ["alpha", "Alpha 2", 2, 2],
          ["beta", "Beta", 1, 1],
        ]);
        const latest = await h.ports.scenarios.get("alpha");
        expect(latest?.version).toBe(2);
        expect(latest?.document).toEqual(scenario("alpha", "Alpha 2", { defaultSeed: 9 }));
        expect(typeof latest?.createdAtWallMs).toBe("number");
        expect(list[0]?.updatedAtWallMs).toBe(latest?.createdAtWallMs);
        expect((await h.ports.scenarios.get("alpha", 1))?.name).toBe("Alpha");
        expect(await h.ports.scenarios.get("alpha", 3)).toBeUndefined();
        expect(await h.ports.scenarios.get("gamma")).toBeUndefined();
      });

      it("rejects documents without a valid envelope and stores nothing", async () => {
        for (const bad of [null, [], "x", 5, { id: "a", name: "A" }, scenario("Bad Id", "x"), scenario("a", ""), scenario("a", "n".repeat(201))]) {
          const r = await h.ports.scenarios.saveVersion(bad);
          expect(r.ok ? null : r.error.code, JSON.stringify(bad)).toBe("invalid_document");
        }
        expect(await h.ports.scenarios.list()).toEqual([]);
      });

      it("deletes every version of a scenario", async () => {
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.saveVersion(scenario("beta", "B"));
        expect((await h.ports.scenarios.delete("alpha")).ok).toBe(true);
        expect((await h.ports.scenarios.list()).map((s) => s.id)).toEqual(["beta"]);
        expect(await h.ports.scenarios.get("alpha", 1)).toBeUndefined();
        expect(await h.ports.scenarios.get("alpha")).toBeUndefined();
        const r = await h.ports.scenarios.delete("alpha");
        expect(r.ok ? null : r.error.code).toBe("unknown_scenario");
      });

      it("never reuses a version: deletion leaves a tombstone and saving continues from the highest version ever used", async () => {
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.delete("alpha");
        expect(await h.ports.scenarios.saveVersion(scenario("alpha", "A again"))).toEqual({ ok: true, value: { id: "alpha", version: 3 } });
        expect((await h.ports.scenarios.list()).map((s) => [s.id, s.latestVersion, s.versionCount])).toEqual([["alpha", 3, 1]]);
        expect(await h.ports.scenarios.get("alpha", 2)).toBeUndefined();
        expect((await h.ports.scenarios.get("alpha"))?.version).toBe(3);
      });

      it("records a content hash per version", async () => {
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.saveVersion(scenario("alpha", "A"));
        await h.ports.scenarios.saveVersion(scenario("alpha", "B"));
        const [v1, v2, v3] = await Promise.all([1, 2, 3].map((v) => h.ports.scenarios.get("alpha", v)));
        expect(v1?.contentHash).toMatch(/^[0-9a-f]{8}$/);
        expect(v2?.contentHash).toBe(v1?.contentHash);
        expect(v3?.contentHash).not.toBe(v1?.contentHash);
      });
    });

    describe("RunConfigStore", () => {
      const cfg = (seed: number) => ({ schemaVersion: 0, scenario: { id: "alpha", version: 1 }, seed });

      it("saves numbered presets, lists the latest per id and gets any version", async () => {
        expect(await h.ports.runConfigs.list()).toEqual([]);
        expect(await h.ports.runConfigs.saveVersion({ id: "fast", name: "Fast A*", document: cfg(1) })).toEqual({ ok: true, value: { id: "fast", version: 1 } });
        expect(await h.ports.runConfigs.saveVersion({ id: "fast", name: "Fast A* v2", document: cfg(2) })).toEqual({ ok: true, value: { id: "fast", version: 2 } });
        expect(await h.ports.runConfigs.saveVersion({ id: "baseline", name: "Baseline", document: cfg(3) })).toEqual({ ok: true, value: { id: "baseline", version: 1 } });
        expect((await h.ports.runConfigs.list()).map((s) => [s.id, s.name, s.latestVersion, s.versionCount])).toEqual([
          ["baseline", "Baseline", 1, 1],
          ["fast", "Fast A* v2", 2, 2],
        ]);
        expect((await h.ports.runConfigs.get("fast", 1))?.document).toEqual(cfg(1));
        expect((await h.ports.runConfigs.get("fast"))?.contentHash).toMatch(/^[0-9a-f]{8}$/);
      });

      it("rejects invalid envelopes", async () => {
        for (const bad of [
          { id: "Bad", name: "x", document: cfg(1) },
          { id: "ok", name: "", document: cfg(1) },
          { id: "ok", name: "x", document: [] },
          { id: "ok", name: "x", document: { scenario: {} } },
          { id: "ok", name: "x", document: { schemaVersion: 0, pad: "x".repeat(1024 * 1024) } },
        ]) {
          const r = await h.ports.runConfigs.saveVersion(bad);
          expect(r.ok, JSON.stringify(bad).slice(0, 60)).toBe(false);
        }
        expect(await h.ports.runConfigs.list()).toEqual([]);
      });

      it("never reuses a version after deletion", async () => {
        await h.ports.runConfigs.saveVersion({ id: "fast", name: "F", document: cfg(1) });
        expect((await h.ports.runConfigs.delete("fast")).ok).toBe(true);
        expect(await h.ports.runConfigs.get("fast")).toBeUndefined();
        expect(await h.ports.runConfigs.saveVersion({ id: "fast", name: "F", document: cfg(1) })).toEqual({ ok: true, value: { id: "fast", version: 2 } });
        const r = await h.ports.runConfigs.delete("nope");
        expect(r.ok ? null : r.error.code).toBe("unknown_run_config");
      });
    });

    describe("runs and scenarios (ADR-0028)", () => {
      const scenario = { schemaVersion: 0, id: "alpha", name: "Alpha" };
      const ref = { scenarioId: "alpha", scenarioVersion: 1, runConfig: { schemaVersion: 0, scenario: { id: "alpha", version: 1 } }, runConfigHash: "0a1b2c3d", effectiveConfigHash: "deadbeef", simulatorVersion: "0.0.0+abc1234" };

      it("records the scenario version, run configuration and hashes of a run", async () => {
        await h.ports.scenarios.saveVersion(scenario);
        expect((await h.ports.runs.create(header("run-000001", ref))).ok).toBe(true);
        expect(await h.ports.runs.get("run-000001")).toEqual(header("run-000001", ref));
      });

      it("records the agents with ideal beliefs as resolved at run start (ADR-0028 addition of 2026-10-10)", async () => {
        await h.ports.scenarios.saveVersion(scenario);
        const ideal = { ...ref, idealAgents: ["ugv-001", "uav-002"] };
        expect((await h.ports.runs.create(header("run-000001", ideal))).ok).toBe(true);
        expect((await h.ports.runs.get("run-000001"))?.idealAgents).toEqual(["ugv-001", "uav-002"]);
        expect((await h.ports.runs.create(header("run-000002", { ...ref, idealAgents: [] }))).ok).toBe(true);
        expect((await h.ports.runs.get("run-000002"))?.idealAgents).toEqual([]);
        // Runs recorded without the field (no scenario, or stored before schema v6) have none.
        expect((await h.ports.runs.create(header("run-000003", ref))).ok).toBe(true);
        expect((await h.ports.runs.get("run-000003"))?.idealAgents).toBeUndefined();
      });

      it("a run can only reference an existing scenario version", async () => {
        const missing = await h.ports.runs.create(header("run-000001", ref));
        expect(missing.ok ? null : missing.error.code).toBe("scenario_version_not_found");
        await h.ports.scenarios.saveVersion(scenario);
        const wrong = await h.ports.runs.create(header("run-000001", { ...ref, scenarioVersion: 2 }));
        expect(wrong.ok ? null : wrong.error.code).toBe("scenario_version_not_found");
        const noVersion = await h.ports.runs.create(header("run-000001", { scenarioId: "alpha" }));
        expect(noVersion.ok ? null : noVersion.error.code).toBe("invalid_header");
      });

      it("a scenario referenced by a run cannot be deleted", async () => {
        await h.ports.scenarios.saveVersion(scenario);
        await h.ports.scenarios.saveVersion({ ...scenario, name: "Alpha 2" });
        await h.ports.scenarios.saveVersion({ ...scenario, id: "beta" });
        await h.ports.runs.create(header("run-000001", ref));
        const r = await h.ports.scenarios.delete("alpha");
        expect(r.ok ? null : r.error.code).toBe("scenario_in_use");
        expect((await h.ports.scenarios.get("alpha", 1))?.version).toBe(1);
        expect((await h.ports.scenarios.delete("beta")).ok).toBe(true);
      });
    });

    describe("UserDataStore", () => {
      it("gets, sets, deletes and lists keys per namespace", async () => {
        await h.ports.userData.set("layout", "scene", { panels: ["a"] });
        await h.ports.userData.set("layout", "data", { panels: [] });
        await h.ports.userData.set("other", "x", 1);
        expect(await h.ports.userData.get("layout", "scene")).toEqual({ panels: ["a"] });
        expect(await h.ports.userData.keys("layout")).toEqual(["data", "scene"]);
        await h.ports.userData.delete("layout", "scene");
        expect(await h.ports.userData.get("layout", "scene")).toBeUndefined();
        expect(await h.ports.userData.keys("layout")).toEqual(["data"]);
      });
    });

    describeRecordingContract(() => h.ports);
  });
}
