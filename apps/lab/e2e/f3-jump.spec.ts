import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";
import { LABEL_PX, LANE_PX, RULER_PX } from "../src/panels/debug/timeline-geometry.ts";

// F3a M3: a click on a row of the event list moves the shared cursor: the Scene's agents and the belief overlay go to that instant. The overlay at the
// instant equals that of a live run paused at the same tick (exact), and the agent's position equals the live one (a record of an action is also a pose
// sample: the transition samples), so the replay shows what the run showed.

const AGENT = "ugv-001";

/** The believed state of every 4th cell of the map as the Scene draws it now (0 unknown, 1 free, 2 occupied). */
const beliefGrid = (page: Page) =>
  page.evaluate(() => {
    const out: (number | undefined)[] = [];
    for (let j = 0; j < 128; j += 4) for (let i = 0; i < 128; i += 4) out.push(window.__agentsim?.scene?.beliefCell(i, j));
    return out;
  });

async function overlayOn(page: Page) {
  await page.getByTestId("overlay-belief").click();
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.pages)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.chunksPending)).toBe(0);
}

async function stepTo(page: Page, tick: number) {
  const tickNow = () => page.evaluate(() => (window.__agentsim?.sim() as { tick: number } | undefined)?.tick ?? 0);
  for (const [size, command] of [[100, "Step 100 ticks"], [10, "Step 10 ticks"], [1, "Step one tick"]] as const) {
    while ((await tickNow()) + size <= tick) {
      const before = await tickNow();
      await runCommand(page, command);
      await expect.poll(tickNow, { timeout: 10_000 }).toBe(before + size);
    }
  }
  expect(await tickNow()).toBe(tick);
}

async function discoveryRun(page: Page) {
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
}

test("clicking an event moves the cursor: the belief overlay and the agent are what a live run paused at that tick shows", async ({ page }) => {
  test.setTimeout(240_000);
  await discoveryRun(page);
  await step(page, 6); // 600 ticks (60 s)
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 20_000 });

  // The event list of the Debug workspace: the rover's actions, from storage.
  await openWorkspace(page, "debug");
  await page.getByTestId("event-filter-agent").selectOption(AGENT);
  await page.getByTestId("event-kind-action").click({ modifiers: ["Shift"] }); // that kind alone
  await expect(page.getByTestId("event-count")).toContainText("records");
  const rows = page.locator('[data-testid^="event-row-"][data-kind="action"]');
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(2);
  // An action record late enough that the rover has seen something: scroll the (virtualized) list to a later stretch and take a row from it.
  await page.getByRole("listbox", { name: "Events" }).evaluate((el) => {
    el.scrollTop = 4000;
  });
  await expect.poll(async () => Number(((await rows.first().textContent()) ?? "").split(" s")[0]), { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
  const candidates = await rows.evaluateAll((els) => els.map((el) => ({ testid: el.getAttribute("data-testid") ?? "", t: Number((el.textContent ?? "").split(" s")[0]) })));
  const target = [...candidates].reverse().find((c) => c.t >= 10 && c.t <= 50);
  expect(target, `an action between 10 s and 50 s among ${JSON.stringify(candidates)}`).toBeDefined();
  const tick = Math.round((target?.t ?? 0) * 10);
  expect(tick).toBeGreaterThan(100);
  // The next pose sample after it (every 0.5 s at the profile's 2 Hz): the pose there is exact. An action's own transition sample is taken at the end of the
  // tick it started in, one tick after the record, so at the record's own tick the pose is the interpolation between samples.
  const sampleTick = Math.ceil((tick + 1) / 5) * 5;

  await page.getByTestId(target?.testid ?? "").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("replay-time")).toContainText(`${((target?.t ?? 0)).toFixed(1)} s /`);
  await expect(page.getByTestId("event-detail")).toContainText('"kind": "action"');
  await expect(page.getByTestId("replay-error")).toHaveCount(0);
  await page.getByTestId(`explorer-row-${AGENT}`).waitFor({ state: "attached", timeout: 1 }).catch(() => undefined); // the Debug workspace has no Explorer: the list selected the agent
  await overlayOn(page);
  // The overlay's chunks for the new moment have landed (nearest groups first, then the rest) before the grid is read.
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.chunksPending), { timeout: 15_000 }).toBe(0);
  await page.waitForTimeout(500);
  const replayed = await beliefGrid(page);
  const inspector = await page.getByTestId("inspector-state").textContent();
  expect(replayed.some((v) => v === 1), "the rover has seen free space by then").toBe(true);
  // The cursor on the next pose sample, by the slider: the belief again, and the pose exactly.
  await page.getByTestId("replay-cursor").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, sampleTick / 10);
  await expect(page.getByTestId("replay-time")).toContainText(`${(sampleTick / 10).toFixed(1)} s /`);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.chunksPending)).toBe(0);
  await page.waitForTimeout(500); // the overlay's reads for the new tick (nearest groups, then the rest) have landed
  const replayedAtSample = await beliefGrid(page);
  const inspectorAtSample = await page.getByTestId("inspector-state").textContent();

  // A live run of the same scenario and commands, paused at that tick.
  await openWorkspace(page, "scene");
  await discoveryRun(page);
  await stepTo(page, tick);
  await overlayOn(page);
  const live = await beliefGrid(page);
  const liveState = await page.getByTestId("inspector-state").textContent();
  expect(replayed).toEqual(live); // the overlay at the event's tick: exact
  // The pose at the event's tick: between two samples, so the interpolation: within 0.25 m of the live one (the chord of a turn driven in 0.5 s at up to 2 m/s
  // leaves the path by up to about 0.1 m, and which tick the event is at depends on what the rover decided).
  const xy = (t: string | null) => (/position([\d.]+) m, ([\d.]+) m/.exec(t ?? "") ?? []).slice(1).map(Number);
  xy(inspector).forEach((v, i) => expect(Math.abs(v - (xy(liveState)[i] ?? Number.NaN))).toBeLessThan(0.25));
  await stepTo(page, sampleTick);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.chunksPending)).toBe(0);
  expect(await beliefGrid(page)).toEqual(replayedAtSample); // the overlay at the sample's tick: exact
  await expect(page.getByTestId("inspector-state")).toHaveText(inspectorAtSample ?? ""); // and the pose, battery and odometer there: exact (the panel is polled: it settles on it)
});

test("the Timeline of the Debug workspace has a lane per agent with the marks of what happened, and a click on it moves the cursor", async ({ page }) => {
  test.setTimeout(120_000);
  await discoveryRun(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  await expect.poll(async () => Number(((await page.getByText(/^\d+ marks$/).textContent()) ?? "0").split(" ")[0]), { timeout: 15_000 }).toBeGreaterThan(10);
  await expect(page.getByTestId("timeline-gap")).toHaveCount(0); // everything is saved
  const box = await page.getByTestId("timeline-canvas").boundingBox();
  if (!box) throw new Error("no timeline");
  // A click on the rover's lane (run, uav-001, ugv-001, ugv-002: the third lane) at the middle of the run: the panels show the run from storage, at that moment.
  await page.getByTestId("timeline-canvas").click({ position: { x: LABEL_PX + (box.width - LABEL_PX) * 0.5, y: RULER_PX + 2 * LANE_PX + LANE_PX / 2 } });
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 20_000 });
  const shown = Number(/^([\d.]+) s/.exec((await page.getByTestId("replay-time").textContent()) ?? "")?.[1]);
  expect(shown).toBeGreaterThan(5);
  expect(shown).toBeLessThan(25);
});
