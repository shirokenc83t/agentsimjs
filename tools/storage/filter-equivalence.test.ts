import { createMemoryPorts, createSqlPorts, LiveSubscriptions, migrate, type LiveBatch, type SqlDriver, type StoragePorts, type StoredMetricSample } from "../../packages/storage/src/index.ts";
import { recordingProfileHash, RECORDING_PRESETS, type MetricSample, type TraceRecord } from "../../packages/trace/src/index.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../../packages/storage/src/drivers/node-sql-driver.ts";
import { profileOf, setup } from "../../apps/lab/src/sim/run-recording-harness.ts";

// ADR-0035 section 5: one filter, two backends. On a recorded F2 run (records of every channel, and metric samples) the records and samples a live subscription delivers
// (display sampling aside) are exactly what the SQL backend returns for the same filter, and what the in-memory adapter returns. Any difference is a stop of the phase.

const RUN = "run-000001";
const PAGE = 10_000;

interface Fixture {
  readonly records: TraceRecord[];
  readonly samples: StoredMetricSample[];
}

let fixture: Fixture;
let sql: StoragePorts;
let memory: StoragePorts;
/** Every statement the SQL ports ran, with its bound parameters. */
const statements: { sql: string; params: unknown[] }[] = [];

function spied(driver: SqlDriver): SqlDriver {
  const log = (sqlText: string, params?: readonly unknown[]) => statements.push({ sql: sqlText, params: [...(params ?? [])] });
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if ((prop === "all" || prop === "get" || prop === "run") && typeof v === "function") {
        return (sqlText: string, params?: readonly unknown[]) => {
          log(sqlText, params);
          return (v as (a: string, b?: readonly unknown[]) => unknown).call(target, sqlText, params);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function store(ports: StoragePorts, f: Fixture): Promise<void> {
  const profile = RECORDING_PRESETS["default-research"];
  const created = await ports.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "fixture", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) });
  if (!created.ok) throw new Error(created.error.message);
  for (let i = 0; i < f.records.length; i += 2000) {
    const a = await ports.trace.append(f.records.slice(i, i + 2000));
    if (!a.ok) throw new Error(a.error.message);
  }
  for (let i = 0; i < f.samples.length; i += 5000) {
    const a = await ports.metrics.append(RUN, f.samples.slice(i, i + 5000));
    if (!a.ok) throw new Error(a.error.message);
  }
}

/**
 * Records of the shapes the F2 run does not make yet (a tier, a group, a detector, a parent, causes): the columns they use are in the schema and in the filter language, so
 * the backends are held to the same answer on them too. They continue the run: later seqs and times, valid sources.
 */
function withReferences(base: readonly TraceRecord[]): TraceRecord[] {
  const last = base[base.length - 1] as TraceRecord;
  const out: TraceRecord[] = [];
  let seq = last.seq + 1;
  const time = last.simTime;
  const push = (r: Omit<TraceRecord, "id" | "runId" | "seq" | "simTime" | "wallTime">) => out.push({ id: `${RUN}#${seq}`, runId: RUN, seq: seq++, simTime: time + out.length * 0.01, wallTime: 1, ...r } as TraceRecord);
  for (let i = 0; i < 30; i++) {
    const first = seq;
    push({ source: i % 2 === 0 ? "uav-001/s1" : "ugv-001/s2", kind: "thought", agentId: i % 2 === 0 ? "uav-001" : "ugv-001", tier: i % 2 === 0 ? "S1" : "S2", payload: { op: "decision", i, note: `Decision ${i}` } });
    push({ source: "world/sim", kind: "detector", agentId: "ugv-001", parentId: `${RUN}#${first}`, causeIds: [`${RUN}#${first}`], payload: { detector: i % 3 === 0 ? "stuck" : "late-decision", status: i % 2 === 0 ? "failed" : "ok" } });
    push({ source: "grp-001/policy", kind: "group", groupId: "grp-001", causeIds: [`${RUN}#${first}`, `${RUN}#${first + 1}`], payload: { op: "rule", rule: `r${i}` } });
  }
  return out;
}

beforeAll(async () => {
  const t = setup(profileOf("default-research", (p) => ({ ...p, checkpoints: { everyTicks: 20, snapshotEveryS: 5 } })));
  t.explore();
  t.step(400); // 40 s of the F2 discovery run: three agents, a rover that explores, beliefs, checkpoints, snapshots, the observer's reports
  const samples = t.items.flatMap((i) => (i.type === "metrics" ? [...i.samples] : []));
  const stored = [...samples].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.tick - b.tick));
  fixture = { records: [...t.records(), ...withReferences(t.records())], samples: stored };
  const driver = openNodeSqlDriver();
  migrate(driver, () => 1);
  sql = createSqlPorts(spied(driver), () => 1);
  memory = createMemoryPorts(() => 1);
  await store(sql, fixture);
  await store(memory, fixture);
  statements.length = 0;
}, 120_000);

// ---- the three backends over records ------------------------------------------------------------------------------------

async function viaPorts(ports: StoragePorts, filter: string): Promise<number[]> {
  const out: number[] = [];
  for (let after = -1; ; ) {
    const page = await ports.trace.query({ runId: RUN, afterSeq: after, limit: PAGE, filter });
    out.push(...page.map((r) => r.seq));
    if (page.length < PAGE) return out;
    after = (page[page.length - 1] as TraceRecord).seq;
  }
}

/** The records a live subscription delivers when the stored records are offered as the worker gets them (in batches), with no display cap. */
function viaLive(filter: string): number[] {
  const out: LiveBatch[] = [];
  let now = 0;
  const live = new LiveSubscriptions({ emit: (b) => out.push(b), now: () => now, setTimer: () => 0, clearTimer: () => undefined, maxPerBatch: Number.MAX_SAFE_INTEGER });
  const r = live.subscribe("v", RUN, filter);
  if (!r.ok) throw new Error(r.error.message);
  for (let i = 0; i < fixture.records.length; i += 37) live.offerRecords(fixture.records.slice(i, i + 37));
  live.flushNow();
  now += 1;
  return out.flatMap((b) => b.records.map((x) => x.seq));
}

describe("a record filter selects the same records live, in SQL and in memory", () => {
  /** The `cause:` and `parent:` terms use numbers that exist in the fixture. */
  const refs = () => {
    const withParent = fixture.records.find((r) => r.parentId !== undefined);
    const withCause = fixture.records.find((r) => (r.causeIds?.length ?? 0) > 0);
    if (!withParent || !withCause) throw new Error("the fixture has no record with a parent or causes");
    return { parent: Number(withParent.parentId?.split("#")[1]), cause: Number(withCause.causeIds?.[0]?.split("#")[1]) };
  };

  const FILTERS = [
    "",
    "kind:event",
    "kind:action,observation",
    "-kind:snapshot",
    "kind:event -agent:ugv-001",
    "agent:ugv-001",
    "agent:ugv-001,uav-001",
    "-agent:ugv-001",
    "source:*/body",
    "source:ugv-001/*",
    "source:ugv-001/body,*/planner",
    "source:world/sim -kind:event",
    "-source:*/body",
    "t:5..10",
    "t:>20",
    "t:>=20 t:<=21",
    "t:<1,>39",
    "t:12.5",
    "t:2..3,30..31 kind:observation",
    "text:explore",
    "text:EXPLORE",
    'text:"op\\":\\"checkpoint"',
    "text:pose -agent:uav-001",
    "text:%",
    "text:_",
    "kind:thought text:request",
    "tier:S1",
    "-tier:S1",
    "group:grp-001",
    "-group:grp-001",
    "detector:late-decision",
    "detector:late-decision,stuck status:failed",
    "-detector:stuck kind:detector",
    "tier:S2",
    "tier:S1,S2 -kind:event",
    "status:failed",
    "-status:failed kind:action",
    "kind:action agent:ugv-001 t:1..40 -source:*/reflexes text:start",
  ];

  for (const filter of FILTERS) {
    it(`"${filter}"`, async () => {
      const a = await viaPorts(sql, filter);
      const b = await viaPorts(memory, filter);
      const c = viaLive(filter);
      expect(b, "memory against SQL").toEqual(a);
      expect(c, "live against SQL").toEqual(a);
    });
  }

  it("cause: and parent: refer to records of the run, the same in all three", async () => {
    const { parent, cause } = refs();
    for (const filter of [`parent:#${parent}`, `cause:#${cause}`, `cause:#${cause},#${cause + 1}`, `-parent:#${parent}`, `-cause:#${cause} kind:action`, `parent:#${parent} cause:#${cause}`]) {
      const a = await viaPorts(sql, filter);
      expect(await viaPorts(memory, filter), filter).toEqual(a);
      expect(viaLive(filter), filter).toEqual(a);
    }
  });

  it("the battery selects something and not everything: it is not agreeing on emptiness", async () => {
    const all = fixture.records.length;
    expect(all).toBeGreaterThan(500);
    const counts = new Map<string, number>();
    for (const f of FILTERS) counts.set(f, (await viaPorts(sql, f)).length);
    expect(counts.get("")).toBe(all);
    for (const f of ["kind:event", "agent:ugv-001", "source:*/body", "t:5..10", "text:explore", "-agent:ugv-001", "-kind:snapshot", "kind:action agent:ugv-001 t:1..40 -source:*/reflexes text:start"]) {
      expect(counts.get(f) ?? 0, f).toBeGreaterThan(0);
    }
    expect(counts.get("kind:event") ?? 0).toBeLessThan(all);
    // A negation and its term partition the records (a record without an agent is on the negated side).
    expect((counts.get("agent:ugv-001") ?? 0) + (counts.get("-agent:ugv-001") ?? 0)).toBe(all);
    expect((counts.get("tier:S1") ?? 0) + (counts.get("-tier:S1") ?? 0)).toBe(all);
    const { parent, cause } = refs();
    expect((await viaPorts(sql, `parent:#${parent}`)).length).toBeGreaterThan(0);
    expect((await viaPorts(sql, `cause:#${cause}`)).length).toBeGreaterThan(0);
    // The fixture has records without an agent, with a parent, and with causes: the null cases are in play.
    expect(fixture.records.some((r) => r.agentId === undefined)).toBe(true);
    for (const f of ["tier:S1", "tier:S2", "group:grp-001", "detector:late-decision", "detector:late-decision,stuck status:failed", "-detector:stuck kind:detector", "-status:failed kind:action"]) expect(counts.get(f) ?? 0, f).toBeGreaterThan(0);
    expect((counts.get("group:grp-001") ?? 0) + (counts.get("-group:grp-001") ?? 0)).toBe(all);
  });

  it("a filter combines with the other fields of a query, and with paging", async () => {
    const all = await viaPorts(sql, "kind:event");
    const some = await sql.trace.query({ runId: RUN, filter: "kind:event", agentId: "ugv-001", limit: PAGE });
    const same = await memory.trace.query({ runId: RUN, filter: "kind:event", agentId: "ugv-001", limit: PAGE });
    expect(same).toEqual(some);
    expect(some.every((r) => r.kind === "event" && r.agentId === "ugv-001")).toBe(true);
    expect(some.length).toBeLessThan(all.length);
    const paged: number[] = [];
    for (let after = -1; ; ) {
      const page = await sql.trace.query({ runId: RUN, afterSeq: after, limit: 7, filter: "kind:event" });
      paged.push(...page.map((r) => r.seq));
      if (page.length < 7) break;
      after = (page[page.length - 1] as TraceRecord).seq;
    }
    expect(paged).toEqual(all);
    // A time window and a filter, through the seq range the window maps to.
    const win = await sql.trace.query({ runId: RUN, simTime: { from: 5, to: 10 }, filter: "kind:event", limit: PAGE });
    expect(win.map((r) => r.seq)).toEqual((await viaPorts(sql, "kind:event t:5..10")));
  });
});

// ---- metric samples ---------------------------------------------------------------------------------------------------------------

async function samplesViaPorts(ports: StoragePorts, filter: string): Promise<string[]> {
  const out: StoredMetricSample[] = [];
  for (let after: StoredMetricSample | undefined; ; ) {
    const page = await ports.metrics.query({ runId: RUN, ...(after === undefined ? {} : { after: { source: after.source, name: after.name, tick: after.tick } }), filter, limit: 4000 });
    out.push(...page);
    if (page.length < 4000) break;
    after = page[page.length - 1];
  }
  return out.map((s) => `${s.source}|${s.name}|${s.tick}`);
}

function samplesViaLive(filter: string): string[] {
  const out: LiveBatch[] = [];
  const live = new LiveSubscriptions({ emit: (b) => out.push(b), now: () => 0, setTimer: () => 0, clearTimer: () => undefined, maxPerBatch: Number.MAX_SAFE_INTEGER });
  const r = live.subscribe("v", RUN, filter);
  if (!r.ok) throw new Error(r.error.message);
  const all = fixture.samples as MetricSample[];
  for (let i = 0; i < all.length; i += 53) live.offerSamples(RUN, all.slice(i, i + 53));
  live.flushNow();
  // The SQL order is (source, name, tick); the live order is the order they were stored in.
  return out.flatMap((b) => b.samples.map((s) => `${s.source}|${s.name}|${s.tick}`)).sort();
}

describe("a metric filter selects the same samples live, in SQL and in memory", () => {
  const FILTERS = [
    "metric:agent.soc",
    "metric:agent.soc source:ugv-001/body",
    "metric:agent.soc source:*/body",
    "metric:agent.soc source:ugv-001/*",
    "metric:sim.tickMs,sim.senseMs",
    "metric:sim.tickMs source:world/sim",
    "metric:agent.soc agent:ugv-001 t:>1",
    "metric:agent.speedMps -source:ugv-001/body",
    "metric:agent.soc,agent.speedMps t:5..10",
    "metric:belief.unknownPct",
    "metric:belief.falseFreePct,belief.entityMeanErrM agent:uav-001",
    "metric:storage.backlogRecords source:world/storage",
    "metric:storage.backlogBytes -t:<5",
    "metric:agent.soc t:2.5",
  ];

  for (const filter of FILTERS) {
    it(`"${filter}"`, async () => {
      const a = await samplesViaPorts(sql, filter);
      expect(await samplesViaPorts(memory, filter), "memory against SQL").toEqual(a);
      expect(samplesViaLive(filter), "live against SQL").toEqual([...a].sort());
    });
  }

  it("the battery selects something and not everything", async () => {
    const all = fixture.samples.length;
    expect(all).toBeGreaterThan(100);
    const n = async (f: string) => (await samplesViaPorts(sql, f)).length;
    for (const f of ["metric:agent.soc", "metric:agent.soc source:*/body", "metric:sim.tickMs", "metric:belief.unknownPct", "metric:agent.soc agent:ugv-001 t:>1"]) expect(await n(f), f).toBeGreaterThan(0);
    expect(await n("metric:agent.soc")).toBeLessThan(all);
    expect((await n("metric:agent.speedMps -source:ugv-001/body")) + (await n("metric:agent.speedMps source:ugv-001/body"))).toBe(await n("metric:agent.speedMps"));
  });

  it("a metric filter is refused by the records query and a record filter by the metrics query, in every backend", async () => {
    for (const ports of [sql, memory]) {
      await expect(ports.trace.query({ runId: RUN, limit: 1, filter: "metric:agent.soc" })).rejects.toThrow(/samples/);
      await expect(ports.metrics.query({ runId: RUN, limit: 1, filter: "kind:event" })).rejects.toThrow(/trace records/);
    }
  });
});

// ---- injection --------------------------------------------------------------------------------------------------------------------------

describe("filters never reach SQL as text", () => {
  it("what the parser refuses never reaches the database, in the records query or the metrics query", async () => {
    statements.length = 0;
    const evil = ["kind:event'; DROP TABLE trace_records; --", "agent:uav-001' OR '1'='1", "source:uav-001/planner'--", "metric:agent.soc;--", "cause:#1; DELETE FROM runs", "t:1; DROP TABLE metrics", "tier:S1) OR (1=1", "detector:x\"y", "status:a;b"];
    for (const f of evil) {
      await expect(sql.trace.query({ runId: RUN, limit: 5, filter: f }), f).rejects.toThrow(/invalid filter/);
      await expect(sql.metrics.query({ runId: RUN, limit: 5, filter: f }), f).rejects.toThrow(/invalid filter/);
    }
    expect(statements).toEqual([]);
    expect(await sql.trace.count(RUN)).toBe(fixture.records.length);
  });

  it("free text is bound as a parameter: no value of a filter is in the statement's text, and the tables are untouched", async () => {
    const text = "'; DROP TABLE trace_records; --";
    statements.length = 0;
    const found = await sql.trace.query({ runId: RUN, limit: 10, filter: `text:"${text}" kind:event agent:ugv-001 detector:late-decision source:ugv-001/planner t:1..9 cause:#12 parent:#13` });
    expect(found).toEqual([]);
    const ran = statements.filter((s) => s.sql.includes("trace_records"));
    expect(ran.length).toBeGreaterThan(0);
    for (const s of ran) {
      for (const value of [text, "DROP", "ugv-001", "late-decision", "planner", "event", "run-000001#12"]) expect(s.sql, value).not.toContain(value);
    }
    const q = ran[ran.length - 1] as { sql: string; params: unknown[] };
    expect(q.params).toEqual(expect.arrayContaining([text.toLowerCase(), "event", "ugv-001", "late-decision", "planner", "run-000001#12", "run-000001#13"]));
    expect(await sql.trace.count(RUN)).toBe(fixture.records.length);
    // The same for the metrics query.
    statements.length = 0;
    await sql.metrics.query({ runId: RUN, limit: 10, filter: "metric:agent.soc source:ugv-001/body agent:ugv-001 t:>1" });
    const m = statements.find((s) => s.sql.includes("FROM metrics"));
    expect(m).toBeDefined();
    for (const value of ["agent.soc", "ugv-001", "body"]) expect(m?.sql, value).not.toContain(value);
  });
});

// ---- a live run -------------------------------------------------------------------------------------------------------------------

describe("a subscription delivers records and samples while a run goes on", () => {
  it("takes what each stretch of the run stored, batched on the interval, before the run is over; the total is what a history query returns", async () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, checkpoints: { everyTicks: 20, snapshotEveryS: 5 } })));
    t.explore();
    const out: LiveBatch[] = [];
    let now = 0;
    const timers: (() => void)[] = [];
    const live = new LiveSubscriptions({ emit: (b) => out.push(b), now: () => now, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
    expect(live.subscribe("tail", RUN, "kind:observation agent:ugv-001").ok).toBe(true);
    expect(live.subscribe("soc", RUN, "metric:agent.soc agent:ugv-001").ok).toBe(true);
    let batchesSeen = 0;
    let itemsSeen = 0;
    const deliveredDuringRun: number[] = [];
    for (let stretch = 0; stretch < 20; stretch++) {
      t.step(10);
      // What the storage worker would have stored of this stretch, offered after it is stored.
      for (const b of t.batches.slice(batchesSeen)) live.offerRecords(b.records);
      for (const i of t.items.slice(itemsSeen)) if (i.type === "metrics") live.offerSamples(RUN, i.samples as MetricSample[]);
      batchesSeen = t.batches.length;
      itemsSeen = t.items.length;
      now += 100; // a tenth of a second of wall time between stretches
      for (const fn of timers.splice(0)) fn();
      deliveredDuringRun.push(out.length);
    }
    // Deliveries began while the run was still going and kept coming.
    expect(deliveredDuringRun[2]).toBeGreaterThan(0);
    expect(deliveredDuringRun[deliveredDuringRun.length - 1]).toBeGreaterThan(deliveredDuringRun[2] ?? 0);
    live.flushNow();
    const liveRecords = out.filter((b) => b.viewId === "tail").flatMap((b) => b.records.map((r) => r.seq));
    const liveSamples = out.filter((b) => b.viewId === "soc").flatMap((b) => b.samples.map((s) => `${s.source}|${s.name}|${s.tick}`));
    expect(liveRecords.length).toBeGreaterThan(20);
    expect(liveSamples.length).toBeGreaterThan(10);
    // The same filters over what the run stored give the same set.
    const store = createMemoryPorts(() => 1);
    const profile = RECORDING_PRESETS["default-research"];
    await store.runs.create({ runId: RUN, schemaVersion: 0, createdAtWallMs: 1, label: "live", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) });
    await store.trace.append(t.records());
    await store.metrics.append(RUN, t.items.flatMap((i) => (i.type === "metrics" ? [...i.samples] : [])).sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.tick - b.tick)));
    expect(liveRecords).toEqual((await store.trace.query({ runId: RUN, limit: PAGE, filter: "kind:observation agent:ugv-001" })).map((r) => r.seq));
    expect([...liveSamples].sort()).toEqual((await store.metrics.query({ runId: RUN, limit: PAGE, filter: "metric:agent.soc agent:ugv-001" })).map((s) => `${s.source}|${s.name}|${s.tick}`).sort());
    live.unsubscribe("tail");
    live.unsubscribe("soc");
    expect(live.size).toBe(0);
  });
});
