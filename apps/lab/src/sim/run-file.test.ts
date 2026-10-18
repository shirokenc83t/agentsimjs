import { createMemoryPorts, exportRunJsonl, importRunJsonl, readRunBundle, writeRunBundle, type StoragePorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { beliefAt } from "../workers/replay-module.ts";
import { openReplaySource, type ReplayRunSource } from "./replay-run-source.ts";
import { cursorPort, recorded, replayOver } from "./replay-test-support.ts";

// F3a M3 (T-025, acceptance 1): a recorded run exported as a file and added to a database again replays as the same run: the same records (modulo the run ID),
// the poses at sampled ticks, the belief maps and the checkpoint hashes.

async function replayOf(ports: StoragePorts, runId: string, cursorS: number): Promise<{ src: ReplayRunSource; cursor: ReturnType<typeof cursorPort> }> {
  const cursor = cursorPort();
  const r = await openReplaySource({ runId, ports, replay: replayOver(ports), cursor: cursor.port, refreshMs: 0 });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  cursor.set(cursorS);
  await r.value.settled();
  return { src: r.value, cursor };
}

const strip = (s: string, id: string) => s.split(id).join("run-X");

describe("a recorded run exported and imported replays as the same run", () => {
  it("through a JSON-lines file: the records, the poses at sampled ticks, the checkpoints and the belief maps are the same", async () => {
    const { ports, t } = await recorded(120);
    const file = await exportRunJsonl(ports, "run-000001");
    if (!file.ok) throw new Error(file.error.message);
    const into = createMemoryPorts();
    const imported = await importRunJsonl(into, file.value);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value).toEqual({ runId: "run-000001", importedFrom: "run-000001" }); // an empty database: the first ID is free

    // Into the same database: the original stays, the new run has a fresh ID.
    const again = await importRunJsonl(ports, file.value);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toEqual({ runId: "run-000002", importedFrom: "run-000001" });
    expect((await ports.runs.list()).map((r) => r.runId)).toEqual(["run-000001", "run-000002"]);

    // The same sequence of records, modulo the run ID.
    const a = await ports.trace.query({ runId: "run-000001", limit: 10_000 });
    const b = await ports.trace.query({ runId: "run-000002", limit: 10_000 });
    expect(b.length).toBe(a.length);
    expect(strip(JSON.stringify(b), "run-000002")).toBe(strip(JSON.stringify(a), "run-000001"));
    // The checkpoint hashes are in those records and equal: the run is reproducible from what was stored.
    const checkpoints = (rs: typeof a) => rs.filter((r) => r.kind === "event" && (r.payload as { op?: string }).op === "checkpoint").map((r) => (r.payload as { stateHash: string }).stateHash);
    expect(checkpoints(b)).toEqual(checkpoints(a));
    expect(checkpoints(a).length).toBeGreaterThan(0);

    // Poses at sampled ticks and the status at them: the same through the replay source.
    const ids = t.world.entityIds;
    for (const tick of [0, 1, 30, 77, 120]) {
      const left = await replayOf(ports, "run-000001", tick * 0.1);
      const right = await replayOf(ports, "run-000002", tick * 0.1);
      ids.forEach((id, i) => expect([...right.src.poses.sample(0).subarray(i * 4, i * 4 + 4)], `${id} at tick ${tick}`).toEqual([...left.src.poses.sample(0).subarray(i * 4, i * 4 + 4)]));
      expect(right.src.snapshot().agentStatus).toEqual(left.src.snapshot().agentStatus);
      expect(right.src.records().map((r) => r.seq)).toEqual(left.src.records().map((r) => r.seq));
      left.src.dispose();
      right.src.dispose();
    }
    // The belief map of the rover at the last tick: the same bytes.
    const x = await beliefAt(ports, "run-000001", t.driver, 120);
    const y = await beliefAt(ports, "run-000002", t.driver, 120);
    if (!x.ok || !y.ok) throw new Error("a belief read failed");
    expect(y.value.coords).toEqual(x.value.coords);
    expect(y.value.data).toEqual(x.value.data);
    expect(y.value.deltasApplied).toBe(x.value.deltasApplied);
    // And the world.
    const w1 = await replayOver(ports).world("run-000001");
    const w2 = await replayOver(ports).world("run-000002");
    expect(w1.ok && w2.ok && w2.value.data.length === w1.value.data.length).toBe(true);
  });

  it("a bundle written to another database and read back is the bundle that was written (what a per-run SQLite file goes through)", async () => {
    const { ports } = await recorded(60);
    const bundle = await readRunBundle(ports, "run-000001");
    if (!bundle.ok) throw new Error(bundle.error.message);
    // The in-memory ports of another database: the bundle is written, read back, and is the bundle that was written (modulo the IDs the write rewrote).
    const other = createMemoryPorts();
    const written = await writeRunBundle(other, bundle.value);
    if (!written.ok) throw new Error(written.error.message);
    const back = await readRunBundle(other, written.value.runId);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.frames).toEqual(bundle.value.frames);
    expect(back.value.snapshots).toEqual(bundle.value.snapshots);
    expect(back.value.records.length).toBe(bundle.value.records.length);
    expect(back.value.header.importedFrom).toBe("run-000001");
  });
});
