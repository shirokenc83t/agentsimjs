import { SnapshotWriter, encodeValue } from "@agentsim/core";
import { RECORDING_PRESETS, recordingProfileHash, type RunHeader, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "./adapters/memory.ts";
import { openNodeSqlDriver } from "./drivers/node-sql-driver.ts";
import type { BeliefFrame, StoragePorts } from "./ports.ts";
import { bundleFromJsonl, bundleProblem, bundleToJsonl, exportRunJsonl, importRunJsonl, readRunBundle, writeRunBundle } from "./run-bundle.ts";
import { migrate } from "./sql/migrations.ts";
import { BELIEF_MANIFEST_FORMAT_STORED } from "./sql/recording-integrity.ts";
import { createSqlPorts } from "./sql/sql-storage.ts";

// F3a M3: one run as a file, added to a database as a new run (ADR-0035 addition of 2026-10-17, item 11).

const profile = RECORDING_PRESETS["default-research"];
const scenarioDoc = (extra = 0) => ({ schemaVersion: 1, id: "demo", name: "Demo", world: { sizeCells: { x: 8, y: 8 }, extra }, zones: [], agents: [] });

const adapters: [string, () => StoragePorts][] = [
  ["memory", () => createMemoryPorts(() => 1_700_000_000_000)],
  [
    "sql",
    () => {
      const db = openNodeSqlDriver();
      migrate(db, () => 1);
      return createSqlPorts(db, () => 1_700_000_000_000);
    },
  ],
];

/** A recorded run with everything a run owns: a scenario version, inputs, records with parents and causes, a snapshot with outside sections, keyframe and deltas. */
async function recordedRun(ports: StoragePorts, runId = "run-000001", scenarioVersions = 1) {
  let version = 0;
  for (let i = 0; i < scenarioVersions; i++) {
    const s = await ports.scenarios.saveVersion(scenarioDoc(i));
    if (!s.ok) throw new Error(s.error.message);
    version = s.value.version;
  }
  const header: RunHeader = {
    runId, schemaVersion: 0, createdAtWallMs: 1_700_000_000_000, label: "demo run", status: "completed", scenarioId: "demo", scenarioVersion: version, seed: 7,
    recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile), idealAgents: ["ugv-001"],
  };
  const created = await ports.runs.create(header);
  if (!created.ok) throw new Error(created.error.message);
  await ports.runs.appendInputs(runId, [{ inputId: "inp-000001", tick: 3, agentId: "uav-001", name: "hold", params: { a: 1 } }]);
  const rec = (seq: number, extra: Partial<TraceRecord> = {}): TraceRecord => ({ id: `${runId}#${seq}`, runId, seq, simTime: seq * 0.1, wallTime: 1_700_000_000_000 + seq, source: "uav-001/actions", kind: "action", agentId: "uav-001", payload: { op: "start", seq }, ...extra });
  const records = [
    rec(0, { kind: "lifecycle", source: "uav-001/config", payload: { op: "config", beliefs: { idealized: false } } }),
    rec(1),
    rec(2, { parentId: `${runId}#1`, causeIds: [`${runId}#1`, `${runId}#0`].sort() }),
    rec(3, { source: "uav-001/body", kind: "observation", payload: { op: "pose", x: 1, y: 2, z: 0, heading: 0 } }),
    rec(4, { source: "world/sim", kind: "event", agentId: undefined as never, payload: { op: "checkpoint", tick: 4, stateHash: "deadbeef" } }),
  ].map((r) => (r.agentId === undefined ? (({ agentId: _a, ...rest }) => rest)(r) : r)) as TraceRecord[];
  const appended = await ports.trace.append(records);
  if (!appended.ok) throw new Error(appended.error.message);
  // A belief map: a group section and the manifest naming it; the snapshot refers to the manifest, the keyframe is the manifest.
  const external = new Map<string, Uint8Array>();
  const w = new SnapshotWriter({ external: (h, b) => external.set(h, b) });
  const group = w.section({ index: 0, chunks: [{ index: 0, logOdds: Int8Array.from([1, 2, 3]) }] });
  const manifest = w.section({ format: BELIEF_MANIFEST_FORMAT_STORED, groupChunks: 8, meta: {}, groups: [{ index: 0, hash: group.hash }] });
  const container = w.finish({ tick: 4, map: manifest });
  const blobs = [...external].map(([id, bytes]) => ({ id, bytes }));
  const written = await ports.snapshots.write(runId, { seq: 4, simTime: 0.4, tick: 4, bytes: container, blobs });
  if (!written.ok) throw new Error(written.error.message);
  const frames: BeliefFrame[] = [
    { agentId: "uav-001", seq: 0, tick: 4, simTime: 0.4, kind: "keyframe", chunks: [0], blobId: manifest.hash },
    { agentId: "uav-001", seq: 1, tick: 5, simTime: 0.5, kind: "delta", chunks: [0], data: encodeValue({ cells: Int32Array.from([1]), logOdds: Int8Array.from([9]) }) },
  ];
  const fa = await ports.beliefFrames.append(runId, frames);
  if (!fa.ok) throw new Error(fa.error.message);
  return { header, records, blobs, container, frames, manifestHash: manifest.hash, groupHash: group.hash };
}

async function fileOf(ports: StoragePorts, runId: string): Promise<Uint8Array> {
  const r = await exportRunJsonl(ports, runId);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe.each(adapters)("a run as a file (%s)", (_name, make) => {
  it("is added to another database as a new run: fresh ID, importedFrom, and everything else as it was", async () => {
    const a = make();
    const src = await recordedRun(a);
    const file = await exportRunJsonl(a, "run-000001");
    if (!file.ok) throw new Error(file.error.message);
    const b = make();
    // A database that has had runs: the new run's ID is a fresh one, even after a deletion.
    await b.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "other", status: "completed" });
    await b.runs.create({ runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "gone", status: "completed" });
    await b.runs.delete("run-000002");
    const imported = await importRunJsonl(b, file.value);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value).toEqual({ runId: "run-000003", importedFrom: "run-000001" });
    const header = await b.runs.get("run-000003");
    expect(header).toMatchObject({ runId: "run-000003", importedFrom: "run-000001", label: "demo run", seed: 7, recording: "stored", idealAgents: ["ugv-001"], scenarioId: "demo", scenarioVersion: 1 });
    expect(header?.recordingProfile).toEqual(profile);
    // The other run is untouched: the file was added, not substituted.
    expect((await b.runs.list()).map((r) => r.runId)).toEqual(["run-000001", "run-000003"]);
    // Records: the same, apart from the run ID in runId, id, parentId and causeIds.
    const back = await b.trace.query({ runId: "run-000003", limit: 100 });
    expect(back.map((r) => r.seq)).toEqual(src.records.map((r) => r.seq));
    const fix = (r: TraceRecord, from: string, to: string): TraceRecord => JSON.parse(JSON.stringify(r).split(`${from}#`).join(`${to}#`).split(`"runId":"${from}"`).join(`"runId":"${to}"`)) as TraceRecord;
    expect(back).toEqual(src.records.map((r) => fix(r, "run-000001", "run-000003")));
    expect(back[2]).toMatchObject({ parentId: "run-000003#1", causeIds: ["run-000003#0", "run-000003#1"] });
    // Inputs, snapshots with their blobs, belief frames: byte for byte.
    expect(await b.runs.inputs("run-000003")).toEqual(await a.runs.inputs("run-000001"));
    const snaps = await b.snapshots.list("run-000003");
    expect(snaps.map((s) => [s.tick, s.seq])).toEqual([[4, 4]]);
    const loaded = await b.snapshots.read("run-000003", snaps[0]?.id ?? "");
    expect(loaded?.container).toEqual(src.container);
    expect([...(loaded?.blobs ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([...src.blobs].sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(await b.beliefFrames.query({ runId: "run-000003", limit: 10 })).toEqual(src.frames);
    expect((await b.snapshots.getBlob("run-000003", src.manifestHash))?.bytes).toEqual(src.blobs.find((x) => x.id === src.manifestHash)?.bytes);
  });

  it("keeps what a derived run says of itself through a file, though its parent is not in the other database", async () => {
    const a = make();
    await recordedRun(a);
    const derived = { parentRunId: "run-000001", t0S: 0.1, t1S: 0.4, startTick: 0, endTick: 4, status: "divergent" as const, checkpointsChecked: 2, divergence: { tick: 3, expected: "aaaaaaaa", actual: "bbbbbbbb" }, copies: 1 };
    const made = await a.runs.create({ runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "window", status: "completed", derived });
    if (!made.ok) throw new Error(made.error.message);
    const file = await exportRunJsonl(a, "run-000002");
    if (!file.ok) throw new Error(file.error.message);
    const b = make();
    const imported = await importRunJsonl(b, file.value);
    if (!imported.ok) throw new Error(imported.error.message);
    expect((await b.runs.get(imported.value.runId))?.derived).toEqual(derived);
    expect(imported.value.importedFrom).toBe("run-000002");
  });

  it("keeps the earliest origin when a run that was imported is exported and imported again", async () => {
    const a = make();
    await recordedRun(a);
    const b = make();
    const first = await importRunJsonl(b, await fileOf(a, "run-000001"));
    if (!first.ok) throw new Error(first.error.message);
    const c = make();
    const again = await importRunJsonl(c, await fileOf(b, first.value.runId));
    if (!again.ok) throw new Error(again.error.message);
    expect((await c.runs.get(again.value.runId))?.importedFrom).toBe("run-000001");
  });

  it("reuses the scenario version when the database has it, whatever its number; saves it when it has not; saves a new version when the content differs", async () => {
    const a = make();
    await recordedRun(a, "run-000001", 3); // the run used version 3 of the scenario
    const file = await fileOf(a, "run-000001");
    // A database without the scenario: saved, as its version 1 there; the run's reference is rewritten.
    const empty = make();
    const r1 = await importRunJsonl(empty, file);
    if (!r1.ok) throw new Error(r1.error.message);
    expect(await empty.runs.get(r1.value.runId)).toMatchObject({ scenarioId: "demo", scenarioVersion: 1 });
    expect((await empty.scenarios.get("demo", 1))?.document).toEqual(scenarioDoc(2));
    // The same database again: the version is there with the same content, so it is reused (no second copy).
    const r2 = await importRunJsonl(empty, file);
    if (!r2.ok) throw new Error(r2.error.message);
    expect(await empty.runs.get(r2.value.runId)).toMatchObject({ scenarioVersion: 1 });
    expect((await empty.scenarios.list())[0]?.versionCount).toBe(1);
    // A database whose scenario of that id differs: the run's version is saved as a new one after it.
    const other = make();
    await other.scenarios.saveVersion(scenarioDoc(99));
    const r3 = await importRunJsonl(other, file);
    if (!r3.ok) throw new Error(r3.error.message);
    expect(await other.runs.get(r3.value.runId)).toMatchObject({ scenarioVersion: 2 });
    expect((await other.scenarios.get("demo", 2))?.document).toEqual(scenarioDoc(2));
  });

  it("refuses what is not a run file, a version it does not read, and a file that does not parse", async () => {
    const p = make();
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await importRunJsonl(p, enc("not json at all\n"))).toMatchObject({ ok: false, error: { code: "not_run_file" } });
    expect(await importRunJsonl(p, enc('{"format":"something-else","version":1}\n'))).toMatchObject({ ok: false, error: { code: "not_run_file" } });
    expect(await importRunJsonl(p, enc('{"format":"agentsim-run-jsonl","version":99,"header":{}}\n'))).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(await importRunJsonl(p, enc('{"format":"agentsim-run-jsonl","version":1,"header":{"runId":"nope"}}\n'))).toMatchObject({ ok: false, error: { code: "corrupt" } });
    const a = make();
    await recordedRun(a);
    const good = new TextDecoder().decode(await fileOf(a, "run-000001"));
    expect(await importRunJsonl(p, enc(`${good}{"t":"mystery"}\n`))).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(await importRunJsonl(p, enc(`${good}{broken\n`))).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(await p.runs.list()).toEqual([]);
  });

  it("refuses a recording that is broken, as a database import does, and leaves nothing behind", async () => {
    const a = make();
    await recordedRun(a);
    const bundle = await readRunBundle(a, "run-000001");
    if (!bundle.ok) throw new Error(bundle.error.message);
    const b = bundle.value;
    const bad = (change: Partial<typeof b>) => bundleProblem({ ...b, ...change })?.code;
    expect(bundleProblem(b)).toBeUndefined();
    // Sim time going backwards within the run.
    expect(bad({ records: b.records.map((r) => (r.seq === 3 ? { ...r, simTime: 0.01 } : r)) })).toBe("non_monotonic_trace");
    // A blob that is not what its ID says.
    expect(bad({ blobs: b.blobs.map((x, i) => (i === 0 ? { ...x, bytes: Uint8Array.from([1, 2, 3]) } : x)) })).toBe("broken_recording");
    // A snapshot that refers to a section that is not in the file.
    expect(bad({ blobs: b.blobs.filter((x) => x.id !== b.blobs[0]?.id) })).toBe("broken_recording");
    // A belief frame with no blob.
    expect(bad({ frames: b.frames.map((f) => (f.kind === "keyframe" ? { ...f, blobId: "0".repeat(32) } : f)) })).toBe("broken_recording");
    // A keyframe that is not a manifest (a map stored whole).
    const whole = Uint8Array.from([5, 5, 5]);
    expect(bad({ blobs: [...b.blobs, { id: "x", bytes: whole }] })).toBe("broken_recording");
    // A record that is not of this run.
    expect(bad({ records: b.records.map((r) => (r.seq === 1 ? { ...r, id: "run-000009#1" } : r)) })).toBe("corrupt");
    const target = make();
    const refused = await writeRunBundle(target, { ...b, records: b.records.map((r) => (r.seq === 3 ? { ...r, simTime: 0.01 } : r)) });
    expect(refused).toMatchObject({ ok: false, error: { code: "non_monotonic_trace" } });
    expect(await target.runs.list()).toEqual([]);
  });

  it("removes a run whose writing failed half way: nothing stays, and its ID is not handed out again", async () => {
    const a = make();
    await recordedRun(a);
    const bundle = await readRunBundle(a, "run-000001");
    if (!bundle.ok) throw new Error(bundle.error.message);
    const target = make();
    const failing: StoragePorts = { ...target, beliefFrames: { ...target.beliefFrames, append: async () => ({ ok: false as const, error: { code: "invalid_frame" as const, message: "refused" } }) } };
    const r = await writeRunBundle(failing, bundle.value);
    expect(r).toMatchObject({ ok: false, error: { code: "write_failed" } });
    expect(await target.runs.list()).toEqual([]);
    expect(await target.runs.allocateRunId()).toBe("run-000002");
  });

  it("round-trips its own text: a bundle read back from the file is the bundle that was written", async () => {
    const a = make();
    await recordedRun(a);
    const bundle = await readRunBundle(a, "run-000001");
    if (!bundle.ok) throw new Error(bundle.error.message);
    const back = bundleFromJsonl(bundleToJsonl(bundle.value));
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.header).toEqual(bundle.value.header);
    expect(back.value.records).toEqual(bundle.value.records);
    expect(back.value.frames).toEqual(bundle.value.frames);
    expect([...back.value.blobs].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([...bundle.value.blobs].sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(back.value.snapshots).toEqual(bundle.value.snapshots);
    expect(back.value.scenario).toEqual(bundle.value.scenario);
    expect(bundleProblem(back.value)).toBeUndefined();
  });
});
