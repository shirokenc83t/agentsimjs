import { describe, expect, it } from "vitest";
import { defaultWindow, recordedUpTo, resimulateWindowToRun } from "./resim-controller.ts";
import { inlineRunner } from "./resim-inline.ts";
import { unresolvedReferences } from "./resim-window.ts";
import { recordedParent } from "./resim-test-support.ts";
import type { TraceRecord } from "@agentsim/trace";

// F3b M2: the derived run is stored through the ports, linked to its parent, with its verdict, and the parent is never changed (ADR-0004 immutability, ADR-0035 section 3).

async function everything(ports: Awaited<ReturnType<typeof recordedParent>>["ports"], runId: string): Promise<TraceRecord[]> {
  const out: TraceRecord[] = [];
  for (let after: number | undefined; ; ) {
    const page = await ports.trace.query({ runId, limit: 2000, ...(after === undefined ? {} : { afterSeq: after }) });
    out.push(...page);
    const last = page[page.length - 1];
    if (page.length < 2000 || !last) return out;
    after = last.seq;
  }
}

describe("a window re-simulated into a derived run in storage", () => {
  it("is stored as its own run, linked to its parent with its window and verdict, readable through the ports, and the parent is not changed", async () => {
    const { ports } = await recordedParent(260);
    const before = { header: await ports.runs.get("run-000001"), records: await everything(ports, "run-000001"), inputs: await ports.runs.inputs("run-000001"), snaps: await ports.snapshots.list("run-000001"), sizes: await ports.runs.sizes("run-000001") };
    const r = await resimulateWindowToRun(ports, "run-000001", { t0S: 15, t1S: 19 }, { runner: inlineRunner, nowWallMs: () => 5 });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.runId).toBe("run-000002");
    expect(r.value.derived).toMatchObject({ parentRunId: "run-000001", t0S: 15, t1S: 19, status: "matches", startTick: 149, endTick: 190 });
    expect(r.value.derived.checkpointsChecked).toBeGreaterThan(5);

    const header = await ports.runs.get("run-000002");
    expect(header?.derived).toEqual(r.value.derived);
    expect(header?.status).toBe("completed");
    expect(header?.recording).toBe("stored");
    expect((header?.recordingProfile as { name?: string } | undefined)?.name).toBe("debug-full"); // the default of a re-simulation
    expect([header?.scenarioId, header?.scenarioVersion, header?.runConfigHash]).toEqual([before.header?.scenarioId, before.header?.scenarioVersion, before.header?.runConfigHash]);
    const listed = (await ports.runs.list()).find((x) => x.runId === "run-000002");
    expect(listed?.recordCount).toBeGreaterThan(50);
    expect((await ports.snapshots.list("run-000002")).length).toBeGreaterThan(0);

    // The derived trace is a valid run of its own: its records carry its ID, in seq order and sim-time order, in the window's span.
    const mine = await everything(ports, "run-000002");
    expect(mine.every((x) => x.runId === "run-000002")).toBe(true);
    for (let i = 1; i < mine.length; i++) {
      expect((mine[i] as TraceRecord).seq).toBeGreaterThan((mine[i - 1] as TraceRecord).seq);
      expect((mine[i] as TraceRecord).simTime).toBeGreaterThanOrEqual((mine[i - 1] as TraceRecord).simTime);
    }
    expect(mine.some((x) => x.simTime >= 18.9 && x.simTime <= 19.05)).toBe(true);
    expect(mine.every((x) => x.simTime <= 19 + 1e-9)).toBe(true);

    // The parent is exactly as it was.
    expect(await ports.runs.get("run-000001")).toEqual(before.header);
    expect(await everything(ports, "run-000001")).toEqual(before.records);
    expect(await ports.runs.inputs("run-000001")).toEqual(before.inputs);
    expect(await ports.snapshots.list("run-000001")).toEqual(before.snaps);
    expect(await ports.runs.sizes("run-000001")).toEqual(before.sizes);
  }, 180_000);

  it("a derived trace is self-contained: nothing it refers to is missing, and a copy of a parent's record says which", async () => {
    const { ports } = await recordedParent(260);
    const r = await resimulateWindowToRun(ports, "run-000001", { t0S: 17, t1S: 19 }, { runner: inlineRunner });
    if (!r.ok) throw new Error(r.error.message);
    const mine = await everything(ports, r.value.runId);
    expect(unresolvedReferences(mine)).toEqual({ spaces: new Set(), queries: new Set(), records: new Set() });
    const copies = mine.filter((x) => (x.payload as { copyOf?: string } | undefined)?.copyOf !== undefined);
    expect(copies.length).toBe(r.value.derived.copies);
    for (const c of copies) expect((c.payload as { copyOf: string }).copyOf).toMatch(/^run-000001#\d+$/);
  }, 180_000);

  it("a window that cannot be reproduced is stored as divergent, with the tick and both hashes", async () => {
    const { ports } = await recordedParent(120, { storeInputs: false });
    const r = await resimulateWindowToRun(ports, "run-000001", { t0S: 0, t1S: 8 }, { runner: inlineRunner });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.derived.status).toBe("divergent");
    const d = r.value.derived.divergence;
    expect(d?.expected).not.toBe(d?.actual);
    expect((await ports.runs.get(r.value.runId))?.derived?.divergence).toEqual(d);
  }, 180_000);

  it("refuses what cannot be re-simulated, with the reason, and stores nothing", async () => {
    const { ports } = await recordedParent(120);
    await ports.runs.create({ runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "not recorded", status: "completed", recording: "none" });
    const code = async (id: string, w: { t0S: number; t1S: number }) => {
      const r = await resimulateWindowToRun(ports, id, w, { runner: inlineRunner });
      return r.ok ? "ok" : r.error.code;
    };
    expect(await code("run-000099", { t0S: 1, t1S: 2 })).toBe("unknown_run");
    expect(await code("run-000002", { t0S: 1, t1S: 2 })).toBe("run_not_recorded");
    expect(await code("run-000001", { t0S: 5, t1S: 60 })).toBe("window_not_recorded"); // recorded up to 12 s
    expect(await code("run-000001", { t0S: 5, t1S: 4 })).toBe("window_invalid");
    expect(await code("run-000001", { t0S: 0, t1S: 301 })).toBe("window_too_long");
    expect((await ports.runs.list()).map((r) => r.runId)).toEqual(["run-000001", "run-000002"]);
  }, 180_000);
});

describe("the window the palette command takes", () => {
  it("is the cursor with five seconds either side, moved to fit in what is recorded and never longer than it", () => {
    expect(defaultWindow(20, 60)).toEqual({ t0S: 15, t1S: 25 });
    expect(defaultWindow(2, 60)).toEqual({ t0S: 0, t1S: 10 }); // before the start: moved forward
    expect(defaultWindow(58, 60)).toEqual({ t0S: 50, t1S: 60 }); // after the end: moved back
    expect(defaultWindow(3, 6)).toEqual({ t0S: 0, t1S: 6 }); // a short recording: all of it
    expect(defaultWindow(1, 0)).toBeUndefined();
  });

  it("the sim time a run is recorded up to is its last checkpoint", async () => {
    const { ports } = await recordedParent(120);
    expect(await recordedUpTo(ports, "run-000001")).toBeCloseTo(12, 5);
    expect(await recordedUpTo(ports, "run-000042")).toBe(0);
  }, 120_000);
});
