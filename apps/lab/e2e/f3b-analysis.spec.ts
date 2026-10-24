import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { LABEL_PX } from "../src/panels/debug/timeline-geometry.ts";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// The Analysis workspace (ADR-0029, UI-SPEC sections 3 and 4) on a run that was recorded headless (acceptance 5, the UI side): its trajectories, its events and its series are
// there to see, the filter is one text that the chips and the brush write, the cursor is shared with the other workspaces, and the view exports.

const AGENT = "ugv-001";

/** An F2 run whose rover explores, run again headless for 60 sim seconds, and opened in Analysis from its monitor. */
async function headlessInAnalysis(page: Page): Promise<void> {
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 1);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 30_000 });
  await runCommand(page, "Run headless");
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
  await page.getByTestId("hm-open-analysis").click();
  await expect(page.getByTestId("workspace-analysis")).toBeVisible();
  await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
}

test("a run recorded headless is there to see in Analysis: trajectories, events on them, the timeline and the series; the filter is one text; the cursor is shared", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await headlessInAnalysis(page);

  // The map: the rover has moved (a line), its events are on it, the other agents are there too.
  const canvas = page.getByTestId("map2d-canvas");
  await expect(canvas).toBeVisible();
  expect(Number(await canvas.getAttribute("data-trajectories"))).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => Number(await canvas.getAttribute("data-markers")), { timeout: 15_000 }).toBeGreaterThan(0);
  const a = (await page.getByTestId("an-count").textContent()) ?? "";
  expect(a).toMatch(/3\/3 agents/);

  // The series: battery and speed (recorded metrics) and the planner's (compute records, said so).
  await expect(page.getByTestId("series-battery")).toBeVisible();
  await expect(page.getByTestId("series-battery")).toContainText("recorded metric agent.soc");
  await expect(page.getByTestId("series-planner-expansions")).toContainText("compute records");
  await expect(page.getByTestId("analysis-timeline")).toBeVisible();

  // The filter is one text: an agent chip writes it, and the map shows that agent only.
  await page.getByTestId(`an-agent-${AGENT}`).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("an-filter")).toHaveValue(`agent:${AGENT}`);
  await expect(canvas).toHaveAttribute("data-trajectories", "1");
  await page.getByTestId("an-kind-reflex").click(); // hides reflexes: written as kind:...
  await expect(page.getByTestId("an-filter")).toHaveValue(new RegExp(`agent:${AGENT} kind:action,injected,degradation`));
  await page.getByTestId("an-filter").fill("");
  await expect(canvas).toHaveAttribute("data-trajectories", /^[2-9]/);

  // A filter that does not parse says so, and a typed one is the same as the chips.
  await page.getByTestId("an-filter").fill("kind:action AND");
  await expect(page.getByTestId("an-error")).toContainText("✕");
  await page.getByTestId("an-filter").fill("agent:uav-001");
  await expect(canvas).toHaveAttribute("data-trajectories", "1");
  await page.getByTestId("an-filter").fill("");

  // The brush: a drag on the timeline's ruler writes the window into the filter, and the window is the shared selection (the Debug Timeline shows the same).
  const tl = page.getByTestId("analysis-timeline-canvas");
  const box = await tl.boundingBox();
  if (!box) throw new Error("no timeline");
  const track = box.width - LABEL_PX;
  await page.mouse.move(box.x + LABEL_PX + track * 0.2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + LABEL_PX + track * 0.4, box.y + 8, { steps: 6 });
  await page.mouse.move(box.x + LABEL_PX + track * 0.6, box.y + 8, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("an-filter")).toHaveValue(/^t:\d+\.\d\.\.\d+\.\d$/);
  await expect(page.getByTestId("an-clear-window")).toBeVisible();
  const window = ((await page.getByTestId("an-filter").inputValue()).match(/(\d+\.\d)\.\.(\d+\.\d)/) ?? []).slice(1).map(Number);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-selection")).toHaveText(`selected ${window[0]?.toFixed(1)}–${window[1]?.toFixed(1)} s`);
  await openWorkspace(page, "analysis");
  await page.getByTestId("an-clear-window").click();
  await expect(page.getByTestId("an-filter")).toHaveValue("");

  // The cursor is shared: a click on the timeline moves it, and the replay of the Debug workspace is at that moment.
  await page.mouse.click(box.x + LABEL_PX + track * 0.5, box.y + 8 + 19 * 2);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
});

test("the view exports: the map as PNG and SVG, the series as CSV, the filtered trace as JSON lines", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await headlessInAnalysis(page);
  await expect.poll(async () => Number(await page.getByTestId("map2d-canvas").getAttribute("data-markers")), { timeout: 15_000 }).toBeGreaterThan(0);

  const [png] = await Promise.all([page.waitForEvent("download"), page.getByTestId("an-export-png").click()]);
  expect(png.suggestedFilename()).toMatch(/^run-\d{6}-map\.png$/);
  expect(readFileSync(await png.path()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // a PNG

  const [svg] = await Promise.all([page.waitForEvent("download"), page.getByTestId("an-export-svg").click()]);
  const svgText = readFileSync(await svg.path(), "utf8");
  expect(svgText.startsWith("<svg xmlns=")).toBe(true);
  expect(svgText).toContain("<polyline");
  expect(await page.evaluate((t) => new DOMParser().parseFromString(t, "image/svg+xml").querySelector("parsererror") === null, svgText)).toBe(true);

  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("an-export-csv").click()]);
  const csvText = readFileSync(await csv.path(), "utf8");
  expect(csvText.startsWith("agent,series,source,unit,t_s,value\r\n")).toBe(true);
  expect(csvText).toMatch(/\r\nugv-001,battery,metric,fraction,/);
  expect(csvText.split("\r\n").length).toBeGreaterThan(20);

  // The trace subset of a filter: only what it selects, one record per line.
  await page.getByTestId("an-filter").fill(`agent:${AGENT} kind:action`);
  const [jsonl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("an-export-jsonl").click()]);
  expect(jsonl.suggestedFilename()).toMatch(/-filtered\.jsonl$/);
  const lines = readFileSync(await jsonl.path(), "utf8").split("\n").filter((l) => l !== "");
  expect(lines.length).toBeGreaterThan(5);
  for (const l of lines) expect(JSON.parse(l)).toMatchObject({ kind: "action", agentId: AGENT });
});
