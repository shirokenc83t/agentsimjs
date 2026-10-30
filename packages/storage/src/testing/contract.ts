import { parseSourceFilter, type RunHeader, type TraceRecord } from "@agentsim/trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoragePorts } from "../ports.ts";
import { poseWindowQuery } from "../replay-queries.ts";
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

      it("stores a derived run with its parent, window and verdict, and refuses one that is inconsistent or has no stored parent", async () => {
        const derived = { parentRunId: "run-000001", t0S: 5, t1S: 8, startTick: 49, endTick: 80, status: "matches" as const, checkpointsChecked: 4, copies: 2 };
        expect((await h.ports.runs.create(header("run-000001"))).ok).toBe(true);
        expect((await h.ports.runs.create(header("run-000002", { derived }))).ok).toBe(true);
        expect((await h.ports.runs.get("run-000002"))?.derived).toEqual(derived);
        const diverged = { ...derived, status: "divergent" as const, divergence: { tick: 60, expected: "aaaaaaaa", actual: "bbbbbbbb" } };
        expect((await h.ports.runs.create(header("run-000003", { derived: diverged }))).ok).toBe(true);
        expect((await h.ports.runs.list()).find((r) => r.runId === "run-000003")?.derived).toEqual(diverged);
        const code = async (id: string, d: unknown) => {
          const r = await h.ports.runs.create(header(id, { derived: d as never }));
          return r.ok ? "ok" : r.error.code;
        };
        expect(await code("run-000004", { ...derived, parentRunId: "run-000099" })).toBe("parent_run_not_found");
        expect(await code("run-000004", { ...derived, parentRunId: "run-000004" })).toBe("invalid_header");
        expect(await code("run-000004", { ...derived, t1S: 1 })).toBe("invalid_header");
        expect(await code("run-000004", { ...derived, status: "divergent" })).toBe("invalid_header"); // divergent without its divergence
        expect(await code("run-000004", { ...derived, divergence: diverged.divergence })).toBe("invalid_header"); // a divergence on a run that matches
        expect(await code("run-000004", { ...diverged, divergence: { ...diverged.divergence, tick: 500 } })).toBe("invalid_header"); // outside its ticks
        expect(await code("run-000004", { ...derived, extra: 1 })).toBe("invalid_header");
        expect(await h.ports.runs.get("run-000004")).toBeUndefined();
        // Imported from another database, a derived run names a parent that is not here.
        expect((await h.ports.runs.create(header("run-000005", { derived: { ...derived, parentRunId: "run-000042" }, importedFrom: "run-000007" }))).ok).toBe(true);
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

      // F3a M3: replay reads one agent's records, or one kind of record, or the pose samples of a window, paged by seq.
      it("filters by agent, kinds and payload op, combined with a window and paging, in seq order", async () => {
        await h.ports.runs.create(header("run-000001"));
        const agents = ["uav-001", "uav-002", "ugv-001"];
        const kinds = ["action", "observation", "event"] as const;
        await h.ports.trace.append(
          Array.from({ length: 36 }, (_, seq) => {
            const agentId = agents[seq % 3] as string;
            const kind = kinds[Math.floor(seq / 3) % 3] as (typeof kinds)[number];
            return rec("run-000001", seq, { simTime: Math.floor(seq / 3) / 10, kind, agentId, source: `${agentId}/body`, payload: { op: kind === "observation" && seq % 2 === 0 ? "pose" : "other", seq } });
          }),
        );
        const seqs = async (q: Record<string, unknown>) => (await h.ports.trace.query({ runId: "run-000001", limit: 100, ...q })).map((r) => r.seq);
        expect(await seqs({ agentId: "uav-002" })).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
        expect(await seqs({ agentId: "uav-002", afterSeq: 10, limit: 3 })).toEqual([13, 16, 19]);
        expect(await seqs({ kinds: ["action"] })).toEqual([0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28, 29]);
        expect(await seqs({ kinds: ["action", "event"], agentId: "ugv-001" })).toEqual([2, 8, 11, 17, 20, 26, 29, 35]);
        expect(await seqs({ agentId: "uav-001", kinds: ["observation"], simTime: { from: 0.3, to: 0.5 } })).toEqual([12]);
        expect(await seqs({ kinds: ["observation"], op: "pose" })).toEqual([4, 12, 14, 22, 30, 32]);
        expect(await seqs({ agentId: "nobody" })).toEqual([]);
        expect(await seqs({ kinds: [] })).toEqual([]);
        await expect(h.ports.trace.query({ runId: "run-000001", limit: 10, kinds: Array.from({ length: 40 }, (_, i) => `k${i}`) })).rejects.toThrow();
        await expect(h.ports.trace.query({ runId: "run-000001", limit: 10, agentId: 5 as never })).rejects.toThrow();
      });

      it("answers a pose window: the pose samples of one agent or all, between two sim times, in seq order", async () => {
        await h.ports.runs.create(header("run-000001"));
        // Per tick (0.1 s): a pose sample and an action record of each of two agents; every third tick also an event of the world.
        const records: TraceRecord[] = [];
        for (let tick = 0; tick < 10; tick++) {
          for (const a of ["uav-001", "ugv-001"]) {
            records.push(rec("run-000001", records.length, { simTime: tick / 10, kind: "observation", agentId: a, source: `${a}/body`, payload: { op: "pose", x: tick } }));
            records.push(rec("run-000001", records.length, { simTime: tick / 10, kind: "action", agentId: a, source: `${a}/actions`, payload: { op: "start" } }));
          }
          if (tick % 3 === 0) records.push(rec("run-000001", records.length, { simTime: tick / 10, kind: "observation", agentId: "uav-001", source: "uav-001/body", payload: { op: "other" } }));
        }
        await h.ports.trace.append(records);
        const all = await h.ports.trace.query(poseWindowQuery({ runId: "run-000001", from: 0.3, to: 0.5, limit: 100 }));
        expect(all.map((r) => [r.agentId, (r.payload as { x: number }).x])).toEqual([["uav-001", 3], ["ugv-001", 3], ["uav-001", 4], ["ugv-001", 4], ["uav-001", 5], ["ugv-001", 5]]);
        expect(all.every((r) => r.kind === "observation" && (r.payload as { op: string }).op === "pose")).toBe(true);
        const one = await h.ports.trace.query(poseWindowQuery({ runId: "run-000001", from: 0.3, to: 0.5, agentId: "ugv-001", limit: 100 }));
        expect(one.map((r) => (r.payload as { x: number }).x)).toEqual([3, 4, 5]);
        const page = await h.ports.trace.query(poseWindowQuery({ runId: "run-000001", from: 0, to: 1, agentId: "uav-001", afterSeq: one[0]?.seq ?? 0, limit: 2 }));
        expect(page.length).toBe(2);
        expect(page.every((r) => r.agentId === "uav-001" && r.seq > (one[0]?.seq ?? 0))).toBe(true);
        expect(await h.ports.trace.query(poseWindowQuery({ runId: "run-000001", from: 5, to: 6, limit: 10 }))).toEqual([]);
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

    describe("ResponseCache columns (schema v14)", () => {
      it("keeps what a model call left: provider kind, tools hash, outcome, usage and latency, and entries without them still read as before", async () => {
        await h.ports.cache.put("old", { model: "m", value: { text: "x" }, createdAtWallMs: 1 });
        expect(await h.ports.cache.get("old")).toEqual({ model: "m", value: { text: "x" }, createdAtWallMs: 1 });
        const entry = { model: "llama", value: { message: { content: "go" } }, createdAtWallMs: 7, providerKind: "openai-compatible", toolsHash: "ab12cd34", outcome: "ok" as const, usage: { inputTokens: 12, outputTokens: 3 }, latencyMs: 840 };
        await h.ports.cache.put("new", entry);
        expect(await h.ports.cache.get("new")).toEqual(entry);
        await h.ports.cache.put("slow", { model: "llama", value: null, createdAtWallMs: 8, outcome: "timeout", latencyMs: 60000 });
        expect(await h.ports.cache.get("slow")).toEqual({ model: "llama", value: null, createdAtWallMs: 8, outcome: "timeout", latencyMs: 60000 });
      });
    });

    describe("the header's minds fields (schema v15)", () => {
      it("keeps where the answers came from and the first tick that missed the cache (set once), and refuses an unknown run", async () => {
        await h.ports.runs.create(header("run-000001", { mindsRunMode: "replay-then-live" }));
        expect((await h.ports.runs.get("run-000001"))?.mindsRunMode).toBe("replay-then-live");
        expect((await h.ports.runs.get("run-000001"))?.notReproducibleFromTick).toBeUndefined();
        expect((await h.ports.runs.markNotReproducible("run-000001", 40)).ok).toBe(true);
        expect((await h.ports.runs.markNotReproducible("run-000001", 90)).ok).toBe(true);
        expect((await h.ports.runs.get("run-000001"))?.notReproducibleFromTick).toBe(40);
        expect((await h.ports.runs.list())[0]?.notReproducibleFromTick).toBe(40);
        const unk = await h.ports.runs.markNotReproducible("run-000009", 1);
        expect(unk.ok ? null : unk.error.code).toBe("unknown_run");
      });
    });

    describe.each(["mindProfiles", "promptTemplates"] as const)("%s (the library, schema v14)", (port) => {
      const doc = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Name of ${id}`, document: { schemaVersion: 1, kind: "x", ...extra } });

      it("saves numbered versions that are never changed, lists the latest per id, gets any version, and never reuses a deleted number", async () => {
        const lib = h.ports[port];
        expect(await lib.list()).toEqual([]);
        expect(await lib.saveVersion(doc("scout"))).toEqual({ ok: true, value: { id: "scout", version: 1 } });
        expect(await lib.saveVersion(doc("scout", { n: 2 }))).toEqual({ ok: true, value: { id: "scout", version: 2 } });
        expect(await lib.saveVersion(doc("alpha"))).toEqual({ ok: true, value: { id: "alpha", version: 1 } });
        expect((await lib.list()).map((s) => [s.id, s.latestVersion, s.versionCount])).toEqual([["alpha", 1, 1], ["scout", 2, 2]]);
        expect((await lib.get("scout"))?.document).toEqual({ schemaVersion: 1, kind: "x", n: 2 });
        expect((await lib.get("scout", 1))?.document).toEqual({ schemaVersion: 1, kind: "x" });
        expect(await lib.get("scout", 3)).toBeUndefined();
        expect((await lib.delete("scout")).ok).toBe(true);
        expect(await lib.get("scout")).toBeUndefined();
        expect(await lib.saveVersion(doc("scout"))).toEqual({ ok: true, value: { id: "scout", version: 3 } });
      });

      it("refuses a document without an id, a name and a schemaVersion, and a delete of what is not there", async () => {
        const lib = h.ports[port];
        expect((await lib.saveVersion({ id: "Bad Id", name: "x", document: { schemaVersion: 1 } })).ok).toBe(false);
        expect((await lib.saveVersion({ id: "ok", name: "x", document: {} })).ok).toBe(false);
        expect((await lib.delete("nothing")).ok).toBe(false);
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
