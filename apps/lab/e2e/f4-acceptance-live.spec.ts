import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { closeFloats, loadF2, openPanelTab, openWorkspace, runCommand } from "./helpers.ts";

// F4 M5 (T-129): the acceptance run of F4 on a LOCAL language model (Ollama, qwen2.5:7b-instruct, started by hand: see the manual-check notes). It is not a test of the suite: it needs the server and a few
// minutes of the GPU, so it is skipped unless AGENTSIM_ACCEPTANCE_DIR names the folder the evidence goes to. It does what a researcher does in the lab (Settings, Library, Configurations, play), reads the
// trace with SQL, and writes the profile, the template, the mission, the response cache and a summary of the run as files. The replay runs are in `f4-acceptance-replay.spec.ts`.

const OUT = process.env["AGENTSIM_ACCEPTANCE_DIR"];
test.skip(!OUT, "the acceptance run needs a local Ollama server and AGENTSIM_ACCEPTANCE_DIR");

const MODEL = process.env["AGENTSIM_ACCEPTANCE_MODEL"] ?? "qwen2.5:7b-instruct";
const ADDRESS = process.env["AGENTSIM_ACCEPTANCE_ADDRESS"] ?? "http://localhost:11434";
const MISSION =
  "Inspect these three points (x, y in metres): P1 (20, 40), P2 (40, 60) and P3 (58, 20), and return to base. Procedure: (1) choose the order of the visits with the lowest total cost: call the function tool estimateCost for three different orders and keep the order with the smallest lengthM; " +
  "(2) take off with altitudeM 20; (3) goTo each point in the chosen order, one goTo for each turn; (4) returnToBase; (5) land.";

const TEMPLATE = {
  schemaVersion: 1,
  kind: "prompt-template",
  system:
    "You are the mind of one vehicle in a simulation. You see only what the vehicle senses and believes, never the world itself. Each turn you receive what happened, what you may do, and your own notes. " +
    "You have function tools (estimateCost, planPath, kShortestPaths, querySpace): call them with a function call when you need to know something; never write a tool call inside your answer. " +
    "Your answer, when you have what you need, is exactly one JSON object with one of the allowed actions, and nothing else: no sentence around it, and no params for an action that has none. Answer idle only to wait for the next event. " +
    "You may keep notes for yourself; they are returned to you in every prompt. " +
    "When the mission names several places to visit, your first step, before any action, is to choose the order: call estimateCost for three different orders (at most), each time with the points in another order, compare the lengthM they return, and keep the cheapest order in the note of your takeoff answer, (the note is an object with a text and the mode replace). " +
    "After the tool results you always answer with the JSON action: if you want to say something, put it in the note of the answer, not around it. " +
    "Once your notes hold the order, do not call estimateCost again: do the next step of the procedure (the next goTo, then returnToBase, then land), and keep the order in your notes. " +
    "Then answer with an action: takeoff with altitudeM 20, then goTo the first place, and so on, one action each turn, and after the last place returnToBase and land.",
  sections: ["role", "mission", "notebook", "decisions", "self", "beliefs", "space", "events", "actions"],
};
const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model: MODEL, promptTemplate: { id: "inspect-order", version: 1 }, params: { temperature: 0 } } };

async function importJson(page: Page, name: string, doc: unknown) {
  await page.evaluate(
    ([n, text]) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="lib-import-file"]');
      if (input === null) throw new Error("no import input");
      const dt = new DataTransfer();
      dt.items.add(new File([text as string], n as string, { type: "application/json" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [name, JSON.stringify(doc)],
  );
  await expect(page.getByTestId("lib-message")).toContainText("imported as");
}

interface SqlRows {
  columns: string[];
  rows: (string | number | null)[][];
  cellsCut: boolean;
}
async function sql(page: Page, statement: string, maxRows = 20_000): Promise<SqlRows> {
  return (await page.evaluate(([s, m]) => window.__agentsim?.sql?.(s as string, m as number), [statement, maxRows] as const)) as unknown as SqlRows;
}
const text = (c: string | number | null | undefined): string => (c === null || c === undefined ? "" : String(c));
const json = (c: string | number | null | undefined): unknown => {
  try {
    return JSON.parse(text(c));
  } catch {
    return text(c);
  }
};

/** What a run did, from its records (the long payloads of a model call are read field by field: a cell is cut at 4 096 characters). */
async function summarize(page: Page, runId: string) {
  const rec = await sql(
    page,
    `SELECT seq, sim_time, kind, json_extract(payload, '$.op'), json_extract(payload, '$.outcome'), json_extract(payload, '$.cacheHit'), json_extract(payload, '$.tool'), json_extract(payload, '$.params'), json_extract(payload, '$.status'), json_extract(payload, '$.limit'), substr(payload, 1, 700), substr(json_extract(payload, '$.response'), 1, 500), json_extract(payload, '$.validationError'), json_extract(payload, '$.attempt'), substr(json_extract(payload, '$.result'), 1, 400) FROM trace_records WHERE run_id = '${runId}' AND agent_id = 'uav-001' ORDER BY seq`,
  );
  const rows = rec.rows.map((r) => ({ seq: r[0] as number, simTime: r[1] as number, kind: text(r[2]), op: text(r[3]), outcome: text(r[4]), cacheHit: r[5] === 1 || r[5] === "true", tool: text(r[6]), params: json(r[7]), status: text(r[8]), limit: text(r[9]), head: text(r[10]), response: text(r[11]), why: text(r[12]), attempt: text(r[13]), result: text(r[14]) }));
  const calls = rows.filter((r) => r.op === "llm-call");
  return {
    runId,
    records: rows.length,
    llmCalls: calls.length,
    calls: calls.map((c) => ({ seq: c.seq, attempt: c.attempt, outcome: c.outcome, response: c.response, why: c.why })),
    cacheHits: calls.filter((c) => c.cacheHit).length,
    outcomes: Object.fromEntries([...new Set(calls.map((c) => c.outcome))].map((o) => [o, calls.filter((c) => c.outcome === o).length])),
    tools: rows.filter((r) => r.kind === "compute" && r.op === "tool").map((t) => ({ seq: t.seq, simTime: t.simTime, tool: t.tool, params: t.params, status: t.status, result: t.result })),
    decisions: rows.filter((r) => r.op === "decision").map((d) => ({ seq: d.seq, simTime: d.simTime, head: d.head })),
    actions: rows.filter((r) => r.kind === "action").map((a) => ({ seq: a.seq, simTime: a.simTime, head: a.head })),
    limitRecords: rows.filter((r) => r.op.startsWith("limit") || r.op === "raiseLimit").map((r) => ({ seq: r.seq, op: r.op, limit: r.limit })),
    fallbacks: rows.filter((r) => r.op === "fallback").length,
  };
}

async function currentRunId(page: Page): Promise<string> {
  return page.evaluate(() => (window.__agentsim?.sim() as { run?: { runId?: string } } | undefined)?.run?.runId ?? "");
}

/** Plays until the scout has landed (a `land` action that succeeded) or `maxMs` pass; a limit notice is raised through the dialog (and said in the log). */
async function playToEnd(page: Page, maxMs: number, log: string[]) {
  const t0 = Date.now();
  await openWorkspace(page, "scene");
  await page.getByTestId("play").click();
  let raised = 0;
  let stalled = 0;
  let lastCalls = -1;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(4000);
    if ((await page.getByTestId("limit-notice").count()) > 0) {
      const limit = await page.getByTestId("limit-notice").getAttribute("data-limit");
      log.push(`limit notice (${limit}) after ${Math.round((Date.now() - t0) / 1000)} s: raised through the dialog`);
      await page.getByTestId("limit-raise").click();
      await page.getByTestId("raise-input").fill(limit === "calls" ? "60" : limit === "tokens" ? "160000" : "0.5");
      await page.getByTestId("raise-confirm").click();
      raised++;
      await expect(page.getByTestId("limit-notice")).toHaveCount(0, { timeout: 30_000 });
      if (raised > 3) break;
      continue;
    }
    const done = await sql(page, `SELECT count(*) FROM trace_records WHERE run_id = '${await currentRunId(page)}' AND kind = 'action' AND json_extract(payload, '$.action') = 'land' AND json_extract(payload, '$.op') = 'succeeded'`);
    const state = await page.getByTestId("player-state").textContent();
    writeFileSync(`${OUT}/log.txt`, log.join(String.fromCharCode(10)));
    log.push(`t+${Math.round((Date.now() - t0) / 1000)} s · ${state?.trim()} · landed rows ${String(done.rows[0]?.[0])}`);
    if (Number(done.rows[0]?.[0]) > 0) return;
    // The mind has nothing more to say: no new model call for 40 s (it waits for an event, or it fell back to idle).
    const n = Number((await sql(page, `SELECT count(*) FROM trace_records WHERE run_id = '${await currentRunId(page)}' AND json_extract(payload, '$.op') = 'llm-call'`)).rows[0]?.[0]);
    stalled = n === lastCalls ? stalled + 1 : 0;
    lastCalls = n;
    if (stalled >= 10) {
      log.push("no new model call for 40 s: the mind is done or idle");
      return;
    }
  }
}

test("a UAV with a language-model mind on a local server: inspect three points, return to base", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  mkdirSync(OUT as string, { recursive: true });
  const log: string[] = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await loadF2(page, "discovery");

  // Settings: the provider (no key: a local server needs none). The test goes to the server for real.
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("local-ollama");
  await page.getByTestId("pv-address").fill(ADDRESS);
  await page.getByTestId("pv-test-new").click();
  await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "ok", { timeout: 60_000 });
  log.push(`provider test: ${(await page.getByTestId("pv-result").textContent())?.trim()}`);
  await page.getByTestId("pv-save").click();

  // Library: the template and the profile (they are exported as files below).
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Library");
  await expect(page.getByTestId("library-panel")).toBeVisible({ timeout: 30_000 });
  await importJson(page, "inspect-order.json", TEMPLATE);
  await page.getByTestId("lib-tab-profile").click();
  await importJson(page, "scout-llm.json", PROFILE);

  // Configurations: the scout's mind, its mission, the run.
  await openPanelTab(page, "Run configuration");
  await page.getByTestId("rc-minds-row-scout").scrollIntoViewIfNeeded();
  await page.getByTestId("rc-minds-kind-scout").selectOption("s2");
  await page.getByTestId("rc-minds-profile-scout").selectOption("scout-llm@1");
  await page.getByTestId("rc-minds-mission-scout").fill(MISSION);
  // The planning tools work on the vehicle's own map: the acceptance run gives it the ideal one (ground truth, labelled "ideal" in the Explorer), so that a route to a far point can be found at all.
  await page.getByTestId("rc-beliefs-init").selectOption("ideal");
  log.push(`estimate: calls ${await page.getByTestId("rc-minds-est-calls-scout").textContent()} · tokens ${await page.getByTestId("rc-minds-est-tokens-scout").textContent()}`);

  /** Starts the configuration of the form as it is (the run mode and the time mode chosen), plays it to its end and reads what it did. */
  const stage = async (name: string, runMode: "live" | "replay-strict", timeMode: "lockstep" | "latency-modeled") => {
    await openWorkspace(page, "configurations");
    await openPanelTab(page, "Run configuration");
    await page.getByTestId("rc-minds-row-scout").scrollIntoViewIfNeeded();
    await page.getByTestId(`rc-minds-mode-${runMode}`).check();
    await page.getByTestId("rc-time-mode").selectOption(timeMode);
    await page.getByTestId("rc-run").click();
    await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 60_000 });
    log.push(`== ${name}: ${runMode}, ${timeMode}`);
    await playToEnd(page, 4 * 60_000, log);
    await page.getByTestId("pause").click().catch(() => undefined);
    const runId = await currentRunId(page);
    await page.screenshot({ path: `${OUT}/${name}-scene.png` });
    const sum = await summarize(page, runId);
    const cps = await sql(page, `SELECT sim_time, substr(payload, 1, 300) FROM trace_records WHERE run_id = '${runId}' AND kind = 'event' AND json_extract(payload, '$.op') = 'checkpoint' ORDER BY seq`);
    const out = { ...sum, runMode, timeMode, checkpoints: cps.rows.map((r) => [r[0], text(r[1])]) };
    writeFileSync(`${OUT}/${name}-summary.json`, JSON.stringify(out, null, 2));
    return out;
  };

  /** The response cache as it is now: the lockstep run and the latency-modeled one start from the same first request, and a live run writes over the answer of the one before, so each is exported when its replay has just checked it. */
  const exportCache = async (file: string) => {
    const c = await sql(page, "SELECT key, model, value, created_at_wall_ms, provider_kind, tools_hash, outcome, usage, latency_ms FROM response_cache");
    writeFileSync(`${OUT}/${file}`, JSON.stringify(c.rows.map((r) => ({ key: r[0], entry: { model: r[1], value: json(r[2]), createdAtWallMs: r[3], providerKind: r[4], toolsHash: r[5], outcome: r[6], usage: r[7] === null ? undefined : json(r[7]), latencyMs: r[8] } })), null, 2));
    return c.rows.length;
  };
  const A = await stage("A-live-lockstep", "live", "lockstep");
  writeFileSync(`${OUT}/log.txt`, log.join(String.fromCharCode(10)));
  const B = await stage("B-replay-lockstep", "replay-strict", "lockstep");
  await exportCache("cache-lockstep.json");
  // The captures of the run just made (A): the LLM inspector at its decision (the model calls with their tool calls and the answer), the Compute inspector at one estimateCost, and the Log filtered to the queries.
  await openWorkspace(page, "debug");
  await closeFloats(page);
  await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:llm-call");
  await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/llm-call/, { timeout: 30_000 });
  await expect(async () => {
    await page.locator('[data-testid^="event-row-"]').first().click({ timeout: 5_000 });
    await expect(page.getByTestId("trace-tree-selected")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await runCommand(page, "Open panel: LLM decision (what a language-model mind was asked and did)");
  await expect(page.getByTestId("llm-lane")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.getByTestId("workspace-debug").screenshot({ path: `${OUT}/capture-llm-inspector.png` });
  await page.getByTestId("llm-lane").locator('li[data-kind="tool"] button').first().click();
  await runCommand(page, "Open panel: Compute call (a tool a mind called)");
  await expect(page.getByTestId("compute-title")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.getByTestId("workspace-debug").screenshot({ path: `${OUT}/capture-compute-inspector.png` });
  await page.getByTestId("log-filter").fill("agent:uav-001 kind:compute");
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.mouse.move(2, 2);
  await page.getByTestId("workspace-debug").screenshot({ path: `${OUT}/capture-trace-of-the-queries.png` });
  const C = await stage("C-live-latency", "live", "latency-modeled");
  const D = await stage("D-replay-latency", "replay-strict", "latency-modeled");
  await exportCache("cache-latency-modeled.json");
  writeFileSync(`${OUT}/log.txt`, log.join(String.fromCharCode(10)));

  // What replay must reproduce: the decisions and actions at their sim times, and the checkpoints (the state hash) at the ticks they share.
  const shape = (r: typeof A) => ({ tools: r.tools.map((t) => [t.simTime, t.tool, JSON.stringify(t.params)]), decisions: r.decisions.map((d) => [d.simTime, d.head.replace(/"latencyMs":[0-9]+/g, "")]), actions: r.actions.map((x) => [x.simTime, x.head]) });
  const common = (x: typeof A, y: typeof A) => {
    const m = new Map(y.checkpoints.map((c) => [String(c[0]), c[1]]));
    const shared = x.checkpoints.filter((c) => m.has(String(c[0])));
    return { shared: shared.length, equal: shared.filter((c) => m.get(String(c[0])) === c[1]).length };
  };
  const verdict = {
    A: { runId: A.runId, llmCalls: A.llmCalls, cacheHits: A.cacheHits, outcomes: A.outcomes, fallbacks: A.fallbacks, limitRecords: A.limitRecords },
    B: { runId: B.runId, llmCalls: B.llmCalls, cacheHits: B.cacheHits, sameShapeAsA: JSON.stringify(shape(B)) === JSON.stringify(shape(A)), checkpoints: common(A, B) },
    C: { runId: C.runId, llmCalls: C.llmCalls, cacheHits: C.cacheHits, outcomes: C.outcomes, fallbacks: C.fallbacks },
    D: { runId: D.runId, llmCalls: D.llmCalls, cacheHits: D.cacheHits, sameShapeAsC: JSON.stringify(shape(D)) === JSON.stringify(shape(C)), checkpoints: common(C, D) },
  };
  writeFileSync(`${OUT}/verdict.json`, JSON.stringify(verdict, null, 2));

  // The run's documents and its cache, as files (CI fixtures).
  const cache = await sql(page, "SELECT key, model, value, created_at_wall_ms, provider_kind, tools_hash, outcome, usage, latency_ms FROM response_cache");
  writeFileSync(`${OUT}/cache.json`, JSON.stringify(cache.rows.map((r) => ({ key: r[0], entry: { model: r[1], value: json(r[2]), createdAtWallMs: r[3], providerKind: r[4], toolsHash: r[5], outcome: r[6], usage: r[7] === null ? undefined : json(r[7]), latencyMs: r[8] } })), null, 2));
  writeFileSync(`${OUT}/profile.json`, JSON.stringify(PROFILE, null, 2));
  writeFileSync(`${OUT}/template.json`, JSON.stringify(TEMPLATE, null, 2));
  writeFileSync(`${OUT}/mission.txt`, MISSION);
  expect(cache.rows.length).toBeGreaterThan(0);
  expect(A.llmCalls).toBeGreaterThan(0);
});
