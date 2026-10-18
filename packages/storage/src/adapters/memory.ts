import { err, isValid, ok } from "@agentsim/core";
import { firstNonMonotonicRecord, formatRunId, isValidTraceRecord, RunHeader, type RunStatus, type TraceRecord } from "@agentsim/trace";
import { checkRecordFilter, checkSourceFilter, recordFilterMatches, sourceFilterMatches } from "../sql/source-filter.ts";
import type { CachedResponse, DocumentSummary, RunSummary, StoragePorts, StoredDocument, TraceQuery } from "../ports.ts";
import { checkRunRecording } from "../recording.ts";
import { checkRunReferences } from "../run-references.ts";
import { memoryRecordingStores } from "./memory-recording.ts";
import { checkRunInputs, type StoredRunInput } from "../run-inputs.ts";
import { checkRunConfigPreset, checkScenarioEnvelope } from "../scenario-envelope.ts";

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Versioned documents with tombstones (same rules as the SQL adapter's `SqlVersionedDocs`). */
function versionedDocs(nowWallMs: () => number) {
  type Entry = { -readonly [K in keyof StoredDocument]: StoredDocument[K] } & { deleted: boolean };
  /** id -> every version ever saved, in order; deleted ones are tombstones (no document). */
  const byId = new Map<string, Entry[]>();
  const live = (id: string) => (byId.get(id) ?? []).filter((v) => !v.deleted);
  return {
    list(): DocumentSummary[] {
      return [...byId.keys()]
        .sort((a, b) => (a < b ? -1 : 1))
        .flatMap((id) => {
          const l = live(id);
          const last = l[l.length - 1];
          return last ? [{ id, name: last.name, latestVersion: last.version, versionCount: l.length, updatedAtWallMs: last.createdAtWallMs }] : [];
        });
    },
    get(id: string, version?: number): StoredDocument | undefined {
      const l = live(id);
      const v = version === undefined ? l[l.length - 1] : l.find((x) => x.version === version);
      if (!v) return undefined;
      const { deleted: _deleted, ...rest } = v;
      return clone(rest);
    },
    /** Next version: highest ever used (tombstones included) + 1. */
    insert(id: string, name: string, json: string, contentHash: string): number {
      const versions = byId.get(id) ?? [];
      const version = (versions[versions.length - 1]?.version ?? 0) + 1;
      versions.push({ id, version, name, document: JSON.parse(json) as unknown, contentHash, createdAtWallMs: nowWallMs(), deleted: false });
      byId.set(id, versions);
      return version;
    },
    tombstone(id: string): number {
      const l = live(id);
      for (const v of l) {
        v.deleted = true;
        v.document = null;
      }
      return l.length;
    },
  };
}

/**
 * In-memory implementation of the storage ports, for unit tests and as a non-persistent fallback.
 * Values are JSON round-tripped so callers observe the same semantics as the SQL adapters.
 */
export function createMemoryPorts(nowWallMs: () => number = Date.now): StoragePorts {
  const runs = new Map<string, RunHeader>();
  const records = new Map<string, TraceRecord[]>();
  const inputs = new Map<string, StoredRunInput[]>();
  const cache = new Map<string, CachedResponse>();
  const userData = new Map<string, unknown>();
  const udKey = (ns: string, k: string) => `${ns}\u0000${k}`;
  const scenarios = versionedDocs(nowWallMs);
  const runConfigs = versionedDocs(nowWallMs);
  const recording = memoryRecordingStores((runId) => runs.has(runId));
  /** Run IDs of deleted runs: never handed out again. */
  const deleted = new Set<string>();

  return {
    snapshots: recording.snapshots,
    beliefFrames: recording.beliefFrames,
    scenarios: {
      list: async () => scenarios.list(),
      get: async (id, version) => scenarios.get(id, version),
      async saveVersion(document) {
        const env = checkScenarioEnvelope(document);
        if (!env.ok) return env;
        return ok({ id: env.value.id, version: scenarios.insert(env.value.id, env.value.name, env.value.json, env.value.contentHash) });
      },
      async delete(id) {
        if ([...runs.values()].some((r) => r.scenarioId === id)) {
          return err({ code: "scenario_in_use" as const, message: `scenario ${id} is referenced by stored runs` });
        }
        return scenarios.tombstone(id) === 0 ? err({ code: "unknown_scenario" as const, message: `unknown scenario ${id}` }) : ok(undefined);
      },
    },
    runConfigs: {
      list: async () => runConfigs.list(),
      get: async (id, version) => runConfigs.get(id, version),
      async saveVersion(preset) {
        const env = checkRunConfigPreset(preset);
        if (!env.ok) return env;
        return ok({ id: env.value.id, version: runConfigs.insert(env.value.id, env.value.name, env.value.json, env.value.contentHash) });
      },
      async delete(id) {
        return runConfigs.tombstone(id) === 0 ? err({ code: "unknown_run_config" as const, message: `unknown run configuration ${id}` }) : ok(undefined);
      },
    },
    trace: {
      async append(batch) {
        for (const r of batch) {
          if (!isValidTraceRecord(r)) return err({ code: "invalid_record" as const, message: "invalid trace record" });
        }
        // All-or-nothing, like a transaction.
        const staged = new Map<string, TraceRecord[]>();
        for (const r of batch) {
          if (!runs.has(r.runId)) return err({ code: "unknown_run" as const, message: `unknown run ${r.runId}` });
          const list = staged.get(r.runId) ?? [...(records.get(r.runId) ?? [])];
          if (list.some((x) => x.seq === r.seq || x.id === r.id)) {
            return err({ code: "duplicate_seq" as const, message: `duplicate record ${r.runId}#${r.seq}` });
          }
          const copy = clone(r);
          if (copy.causeIds) copy.causeIds = [...new Set(copy.causeIds)].sort();
          if (copy.causeIds?.length === 0) delete copy.causeIds;
          list.push(copy);
          staged.set(r.runId, list);
        }
        for (const [runId, list] of staged) {
          if (firstNonMonotonicRecord(list)) return err({ code: "non_monotonic_time" as const, message: `records of ${runId} would break seq/sim-time order` });
        }
        for (const [k, v] of staged) records.set(k, v.sort((a, b) => a.seq - b.seq));
        return ok(undefined);
      },
      async flush() {},
      async query(q: TraceQuery) {
        checkSourceFilter(q.source);
        checkRecordFilter(q);
        const after = q.afterSeq ?? -1;
        const limit = Math.max(0, Math.min(q.limit, 10_000));
        const from = q.simTime?.from ?? Number.NEGATIVE_INFINITY;
        const to = q.simTime?.to ?? Number.POSITIVE_INFINITY;
        const inWindow = (t: number) => t >= from && t <= to; // NaN bounds match nothing, like the SQL mapping
        return clone(
          (records.get(q.runId) ?? []).filter((r) => r.seq > after && inWindow(r.simTime) && sourceFilterMatches(q.source, r.source) && recordFilterMatches(q, r)).slice(0, limit),
        );
      },
      async count(runId) {
        return records.get(runId)?.length ?? 0;
      },
    },
    runs: {
      async allocateRunId() {
        let max = 0;
        for (const id of [...runs.keys(), ...deleted]) max = Math.max(max, Number(id.slice(4)));
        return formatRunId(max + 1);
      },
      async create(header) {
        if (!isValid(RunHeader, header)) return err({ code: "invalid_header" as const, message: "invalid run header" });
        const refs = checkRunReferences(header);
        if (!refs.ok) return refs;
        const recorded = checkRunRecording(header);
        if (!recorded.ok) return recorded;
        if (runs.has(header.runId)) return err({ code: "duplicate_run" as const, message: `run ${header.runId} exists` });
        if (header.scenarioId !== undefined && !scenarios.get(header.scenarioId, header.scenarioVersion)) {
          return err({ code: "scenario_version_not_found" as const, message: `scenario ${header.scenarioId} v${header.scenarioVersion ?? "?"} not found` });
        }
        runs.set(header.runId, clone(header));
        return ok(undefined);
      },
      async get(runId) {
        return clone(runs.get(runId));
      },
      async list(): Promise<RunSummary[]> {
        return [...runs.values()]
          .sort((a, b) => (a.runId < b.runId ? -1 : 1))
          .map((r) => ({ ...clone(r), recordCount: records.get(r.runId)?.length ?? 0 }));
      },
      async setStatus(runId: string, status: RunStatus) {
        const r = runs.get(runId);
        if (!r) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
        runs.set(runId, { ...r, status });
        return ok(undefined);
      },
      async sizes(runId) {
        if (!runs.has(runId)) return undefined;
        const payloadBytes = (records.get(runId) ?? []).map((r) => JSON.stringify(r.payload ?? null).length);
        return { records: { count: payloadBytes.length, bytes: payloadBytes.reduce((a, b) => a + b, 0) }, ...recording.sizesOf(runId) };
      },
      async delete(runId) {
        if (!runs.has(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
        runs.delete(runId);
        records.delete(runId);
        inputs.delete(runId);
        recording.forget(runId);
        deleted.add(runId);
        return ok(undefined);
      },
      async appendInputs(runId, batch) {
        if (!runs.has(runId)) return err({ code: "unknown_run" as const, message: `unknown run ${runId}` });
        const existing = inputs.get(runId) ?? [];
        const checked = checkRunInputs(existing, batch);
        if (!checked.ok) return checked;
        inputs.set(runId, [...existing, ...clone(checked.value)]);
        return ok(undefined);
      },
      async inputs(runId) {
        return clone(inputs.get(runId) ?? []);
      },
    },
    cache: {
      async get(key) {
        return clone(cache.get(key));
      },
      async put(key, entry) {
        cache.set(key, clone({ ...entry, value: entry.value ?? null }));
      },
    },
    userData: {
      async get(ns, k) {
        return clone(userData.get(udKey(ns, k)));
      },
      async set(ns, k, v) {
        userData.set(udKey(ns, k), clone(v ?? null));
      },
      async delete(ns, k) {
        userData.delete(udKey(ns, k));
      },
      async keys(ns) {
        const prefix = `${ns}\u0000`;
        return [...userData.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
      },
    },
  };
}
