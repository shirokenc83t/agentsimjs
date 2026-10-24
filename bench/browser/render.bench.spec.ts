import { expect, test } from "@playwright/test";
import { recordRenderer, recordResults, summarize } from "../../tools/bench/measure.ts";
import { isSoftwareRenderer, RENDERER_PROBE } from "../../tools/test/gpu.ts";
import { loadF2, openPanelTab, openWorkspace, runCommand, sendTo, waitForStorageReady } from "../../apps/lab/e2e/helpers.ts";

// Reference scene (F0): empty ground, lights, orbit camera, one interpolated dummy entity.
// Thresholds in bench/thresholds.json; wall-clock frame intervals are reported only (ADR-0021).
test("render loop and worker messaging on the reference scene", async ({ page }) => {
  await page.goto("/?probe");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await page.waitForFunction(() => (window.__agentsim?.frameWorkMs().count ?? 0) >= 120, null, { timeout: 30_000 });
  // Let the steady state settle, then sample for 5 s.
  await page.waitForTimeout(1000);
  await page.evaluate(() => (window.__agentsim ? (window.__agentsim.frames.length = 0) : undefined));
  await page.waitForTimeout(5000);

  const r = await page.evaluate(() => {
    const p = window.__agentsim;
    if (!p) throw new Error("probe missing");
    return { work: p.frameWorkMs(), interval: p.frameIntervalMs(), latency: p.stateLatencyMs(), frames: p.frames.map((f) => f[0]) };
  });
  const renderer = String(await page.evaluate(RENDERER_PROBE));
  if (process.env["AGENTSIM_BENCH_GPU"]) expect(isSoftwareRenderer(renderer), `bench:gpu needs a hardware GPU (ADR-0022), got ${renderer}`).toBe(false);
  recordRenderer(renderer);
  const intervals = r.frames.slice(1).map((t, i) => t - (r.frames[i] ?? t));

  recordResults("browser.json", {
    "render.frameWork": { mean: r.work.mean, p95: r.work.p95, unit: "ms", samples: r.work.count },
    "render.frameInterval": summarize(intervals),
    "sim.stateLatency": { mean: r.latency.mean, p95: r.latency.p95, unit: "ms", samples: 120 },
  });
});

// Worker → main delivery without rendering (Data workspace). Separates messaging cost from frame
// scheduling: with software GL (SwiftShader in headless CI) messages queue behind frame production.
test("worker messaging latency without rendering", async ({ page }) => {
  await page.goto("/?probe");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await page.getByTestId("tab-data").click();
  await page.waitForTimeout(12_500); // refill the 120-sample window at 10 Hz
  const l = await page.evaluate(() => window.__agentsim?.stateLatencyMs() ?? { mean: Number.NaN, p95: Number.NaN });
  recordResults("browser.json", { "sim.stateLatency.noRender": { mean: l.mean, p95: l.p95, unit: "ms", samples: 120 } });
});

test("initial load (time to interactive, first workspace visible)", async ({ browser }) => {
  const samples: number[] = [];
  const workspace: number[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/?probe");
    await page.waitForFunction(() => window.__agentsim?.loadMarks["interactive"] !== undefined, null, { timeout: 30_000 });
    samples.push(await page.evaluate(() => window.__agentsim?.loadMarks["interactive"] ?? Number.NaN));
    // Dockview loads after first paint (issue #4): the first workspace must not become slow unseen.
    await page.waitForFunction(() => window.__agentsim?.loadMarks["workspaceVisible"] !== undefined, null, { timeout: 30_000 });
    workspace.push(await page.evaluate(() => window.__agentsim?.loadMarks["workspaceVisible"] ?? Number.NaN));
    await ctx.close();
  }
  recordResults("browser.json", { "load.interactive": summarize(samples), "load.workspaceVisible": summarize(workspace) });
});

// F1 acceptance: frame time stays within budget on the 1 km² reference world while agents move and a path is
// planned. The initial atlas upload (1,024 chunks at ≤ 16 per frame) is measured on its own, outside the
// gated window (ADR-0027 budget).
test("render loop on the 1 km² reference world, agents moving and a path being planned", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  await page.getByTestId("load-reference").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-reference-1km v\d+$/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s !== undefined && s.pages > 0 && s.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);

  // Upload window: the frames that rendered with chunks still queued.
  const log = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  const uploading = log.filter(([, , pending]) => pending > 0);
  expect(uploading.length).toBeGreaterThan(0);
  const first = uploading[0]?.[0] ?? 0;
  const last = uploading.at(-1)?.[0] ?? 0;

  // The rover gets a slow onboard computer (500 expansions per tick, run configuration byAgent): its cross-map
  // A* (about 71k expansions) then spans about 140 ticks, so the measured window really runs while a path is
  // being planned. Set from the Run configuration panel, as a researcher would.
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-planning-scope").selectOption("byAgent.rover");
  await panel.getByTestId("rc-per-tick").fill("500");
  await expect(panel.getByTestId("rc-effective-ugv-001")).toContainText("500");
  await panel.getByTestId("rc-run").click();
  await openWorkspace(page, "scene");
  await expect
    .poll(() => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s !== undefined && s.pages > 0 && s.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);

  // Steady window: the airborne scout flies about 320 m (its plan is quick: it clears most buildings) while the
  // rover plans a cross-map ground route (~980 m); the sim plays. Targets lie inside the default camera view
  // (points near the south edge fall off the canvas).
  await sendTo(page, "uav-001", 200, 250);
  await sendTo(page, "ugv-001", 700, 700);
  await page.getByTestId("play").click();
  await page.waitForTimeout(500);
  const windowStartS = await page.evaluate(() => (window.__agentsim?.sim() as { simTimeS: number }).simTimeS);
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  await page.waitForTimeout(5000);
  const steady = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  const plan = await page.evaluate(() =>
    (window.__agentsim?.records?.() ?? []).find((r) => {
      const x = r as { kind?: string; agentId?: string; payload?: { op?: string; status?: string } };
      return x.kind === "compute" && x.agentId === "ugv-001" && x.payload?.op === "plan" && x.payload.status === "found";
    }) as { simTime: number } | undefined,
  );
  // Planning covers the window: the rover's plan is found at least 4 s (sim) after the window starts, or not yet.
  expect(plan === undefined || plan.simTime >= windowStartS + 4, `plan found at ${plan?.simTime} s, window from ${windowStartS} s`).toBe(true);
  expect(steady.length).toBeGreaterThan(30);

  recordResults("browser.json", {
    "render.frameWork.reference": summarize(steady.map(([, w]) => w)),
    "render.frameWork.referenceUpload": summarize(uploading.map(([, w]) => w)),
    "render.referenceUploadFrames": summarize([uploading.length], "count"),
    "render.referenceUploadMs": summarize([last - first]),
  });
  console.log(
    JSON.stringify({
      uploadFrames: uploading.length,
      uploadMs: Math.round(last - first),
      steadyFrames: steady.length,
      planFoundAtS: plan?.simTime ?? null,
      windowStartS,
    }),
  );
});

// F3b (ADR-0042 section 8): frame time with the Overview window open on the 1 km² reference world, agents moving. The Overview is drawn from its own timer, from the
// atlases the Scene holds, never inside the frame loop: this measures that it does not cost the frame anything (budget 4 ms p95, ADR-0013). Reported as
// `render.frameWork.overview` (a threshold entry for it is Max's to add).
test("render loop on the 1 km² reference world with the Overview window open", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-reference").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-reference-1km v\d+$/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s !== undefined && s.pages > 0 && s.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);
  await page.getByTestId("wb-collapse-overview").click();
  await expect(page.getByTestId("overview-canvas")).toBeVisible();
  await sendTo(page, "uav-001", 200, 250);
  await sendTo(page, "ugv-001", 700, 700);
  await page.getByTestId("play").click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  await page.waitForTimeout(5000);
  const steady = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  expect(steady.length).toBeGreaterThan(30);
  recordResults("browser.json", { "render.frameWork.overview": summarize(steady.map(([, w]) => w)) });
  console.log(JSON.stringify({ overviewOpen: { steadyFrames: steady.length } }));
});

// F2 M2e5 (ADR-0027, ADR-0013): frame time with the belief overlay on, on the 1 km² reference world, while agents move.
// Two measurements. (1) Showing a whole known 1 km² map (the rover's prior: 1,024 belief chunks at the shared ≤ 16 uploads
// per frame): time to show it and the frame work meanwhile, reported only, like the F1 atlas upload. (2) A steady window
// with the researcher-only difference mode on (the heaviest shader: two textures) over the airborne scout's growing map
// while it and the rover move, with the scout's lidar rays and its regions and frontier groups drawn too: the gate
// `render.frameWork.referenceOverlays`.
test("render loop on the 1 km² reference world with the belief overlay", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await runCommand(page, "Load F2 prior map demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f2-prior-1km v\d+$/, { timeout: 90_000 });
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s !== undefined && s.pages > 0 && s.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);

  // The run's agents plan with an eager refine (HPA* coarse path, A* legs), so that a run's own planning queries carry stages for the
  // stages overlay (F2b M4): a new run of the same scenario.
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const rc = page.getByTestId("run-config-panel");
  await rc.getByTestId("rc-planner").selectOption("strategy");
  await rc.getByTestId("rc-strategy-preset").selectOption("inline");
  await rc.getByTestId("rc-strategy-json").fill(
    JSON.stringify({ schemaVersion: 0, id: "stages", version: 1, origin: "human", root: { kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } }),
  );
  await expect(rc.getByTestId("rc-valid")).toBeVisible();
  await rc.getByTestId("rc-run").click();
  await openWorkspace(page, "scene");
  await expect
    .poll(() => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s !== undefined && s.pages > 0 && s.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);

  // (1) Showing the rover's whole known map.
  await page.getByTestId("explorer-row-ugv-001").click();
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  const t0 = Date.now();
  await page.getByTestId("overlay-belief").click();
  await expect
    .poll(() => page.evaluate(() => { const b = window.__agentsim?.scene?.stats().belief; return b !== undefined && b.pages === 1 && b.chunksUploaded >= 1000 && b.chunksPending === 0; }), { timeout: 180_000 })
    .toBe(true);
  const showMs = Date.now() - t0;
  const showLog = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  const uploading = showLog.filter((f) => f[3] > 0);
  expect(uploading.length).toBeGreaterThan(10);

  // (2) Steady window: the scout's map grows under the difference mode while the agents move.
  await sendTo(page, "uav-001", 200, 250);
  await sendTo(page, "ugv-001", 700, 700);
  await page.getByTestId("explorer-row-uav-001").click();
  await page.getByTestId("overlay-difference").click();
  // Rays and the frontier/region overlay of the same agent join the window (M2e6).
  await page.getByTestId("overlay-rays").click();
  await page.getByTestId("overlay-frontiers").click();
  // The stages overlay joins them (F2b M4): a researcher's Strategy test of a refine (coarse path dashed, legs, numbered joints)
  // from the scout to its target, drawn by the same class that draws a run's query stages.
  await page.getByTestId("overlay-stages").click();
  await page.getByTestId("st-strategy").selectOption("inline");
  await page.getByTestId("st-json").fill(
    JSON.stringify({ schemaVersion: 0, id: "bench", version: 1, origin: "human", root: { kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } }),
  );
  await page.getByTestId("st-x").fill("200");
  await page.getByTestId("st-y").fill("250");
  const sandboxT0 = Date.now();
  await page.getByTestId("st-run").click();
  await expect(page.getByTestId("st-status")).toBeVisible({ timeout: 120_000 });
  const sandboxMs = Date.now() - sandboxT0;
  await expect
    .poll(() => page.evaluate(() => { const b = window.__agentsim?.scene?.stats().belief; return b !== undefined && b.pages === 1 && b.chunksPending === 0; }), { timeout: 60_000 })
    .toBe(true);
  await page.getByTestId("play").click();
  // The run's own stages: the scout's plan (an eager refine) is in the trace once the sim has run a little, and the overlay draws it.
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.overlays().stages.legs), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  await page.waitForTimeout(5000);
  const steady = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  expect(steady.length).toBeGreaterThan(30);
  const drawn = await page.evaluate(() => window.__agentsim?.scene?.overlays());
  expect(drawn?.rays, "the ray overlay is drawing in the measured window").toBeGreaterThan(0);
  expect(drawn?.regions, "the region overlay is drawing").toBeGreaterThan(0);
  expect(drawn?.stages.legs, "the stages overlay is drawing a run query's stages").toBeGreaterThan(0);
  expect(drawn?.stages.coarseDashes, "…with its coarse path dashed").toBeGreaterThan(0);
  expect(drawn?.sandbox.legs, "…and a Strategy test next to it").toBeGreaterThan(0);
  expect(drawn?.sandbox.coarseDashes, "…with its coarse path dashed").toBeGreaterThan(0);
  const streamed = steady.filter((f) => f[3] > 0).length;

  recordResults("browser.json", {
    "render.frameWork.referenceOverlays": summarize(steady.map(([, w]) => w)),
    "render.frameWork.beliefUpload": summarize(uploading.map(([, w]) => w)),
    "render.beliefUploadFrames": summarize([uploading.length], "count"),
    "render.beliefShowMs": summarize([showMs]),
  });
  console.log(JSON.stringify({ belief1km: { sandboxMs, showMs, uploadFrames: uploading.length, steadyFrames: steady.length, steadyFramesWithBeliefChunks: streamed } }));
});

// F3b M4 (ADR-0029): what the 2D view costs with 20 agents running: the Scene's MAP 2D redraws at the panel rate (10 Hz) with every agent's executed path, its position and the
// blocked cells of the world, on a canvas. Reported as `render.frameWork.map2d` (the wall ms of each draw; report only, no threshold).
test("the Scene's 2D view with a 20-agent run", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "agents");
  const ground = await page.locator('[data-testid^="explorer-row-ugv-"]').evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") ?? "").replace("explorer-row-", "")));
  expect(ground.length).toBeGreaterThan(2);
  for (const id of ground.slice(0, 6)) {
    await page.getByTestId(`explorer-row-${id}`).click();
    await runCommand(page, `Explore selected agent (${id})`);
  }
  await page.getByTestId("map-view-2d").click();
  await expect(page.getByTestId("scene-2d")).toBeVisible();
  await page.getByTestId("play").click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__agentsim && (window.__agentsim.map2dMs = []));
  await page.waitForTimeout(8000);
  const draws = await page.evaluate(() => window.__agentsim?.map2dMs?.slice() ?? []);
  const agents = Number(await page.getByTestId("map2d-canvas").getAttribute("data-trajectories"));
  expect(draws.length).toBeGreaterThan(30);
  expect(agents, "the map draws every agent's path").toBeGreaterThanOrEqual(20);
  recordResults("browser.json", { "render.frameWork.map2d": summarize(draws) });
  console.log(JSON.stringify({ map2d: { draws: draws.length, agents } }));
});

// F3b M3 (ADR-0013, ADR-0035 section 5): frame time with the log console tailing a recorded 20-agent run in the Debug workspace, everything the run writes pushed to it by a live
// subscription and the Timeline and the trace tree open beside it. The console is a list of at most a screenful of rows and a tail that appends and scrolls; this measures that it does
// not cost the frame anything (budget 4 ms p95). Reported as `render.frameWork.logTail` (a threshold entry for it is Max's to add).
test("render loop with the log console tailing a 20-agent run", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "agents");
  const ground = await page.locator('[data-testid^="explorer-row-ugv-"]').evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") ?? "").replace("explorer-row-", "")));
  expect(ground.length).toBeGreaterThan(2);
  for (const id of ground.slice(0, 6)) {
    await page.getByTestId(`explorer-row-${id}`).click();
    await runCommand(page, `Explore selected agent (${id})`);
  }
  await openWorkspace(page, "debug");
  await page.getByTestId("log-filter").fill("-source:*/body");
  await expect(page.getByTestId("log-tail")).toHaveAttribute("data-state", "following");
  await page.getByTestId("play").click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  await page.waitForTimeout(6000);
  const steady = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  const rows = Number(await page.getByTestId("event-scroller").getAttribute("data-count"));
  expect(steady.length).toBeGreaterThan(30);
  expect(rows, "the console received what the run wrote").toBeGreaterThan(100);
  recordResults("browser.json", { "render.frameWork.logTail": summarize(steady.map(([, w]) => w)) });
  console.log(JSON.stringify({ logTail: { steadyFrames: steady.length, consoleRows: rows } }));
});
