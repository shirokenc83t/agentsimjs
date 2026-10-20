import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, setReplayCursor, step } from "./helpers.ts";

// F2c M1 (ADR-0040): explore works in iterations of a radius. The Inspector's Explore command takes an optional radius (its placeholder is the agent's
// configured one) and the Scene's exploration overlay draws the iteration in progress, live and from a stored run.

const AGENT = "ugv-001";
const exploration = (page: Page) => page.evaluate(() => window.__agentsim?.scene?.overlays()?.exploration);

test("explore with a radius from the Inspector: the iteration area is drawn, live and in replay, and its records name the radius", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();

  // The Inspector names the vehicle's current or last recovery (ADR-0041), from the records: none before it ever needed one.
  await expect(page.getByTestId("inspector-recovery")).toHaveText("none");

  // The radius field shows the agent's configured radius (a ground vehicle's built-in default) and takes another.
  const radius = page.getByTestId("command-explore-radius");
  await expect(radius).toHaveAttribute("placeholder", "20");
  await radius.fill("25");
  await page.getByTestId("overlay-explore").click();
  await page.getByTestId("command-explore").click();
  await step(page, 1);

  await expect.poll(async () => (await exploration(page))?.area, { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId("explore-legend")).toContainText("iteration of explore");
  const start = await page.evaluate(() =>
    (window.__agentsim?.records?.() ?? []).find((r) => {
      const x = r as { agentId?: string; payload?: { op?: string; event?: string } };
      return x.agentId === "ugv-001" && x.payload?.op === "explore-iteration" && x.payload.event === "start";
    }) as { payload: { radiusM: number; window: number[]; centre: number[] } } | undefined,
  );
  expect(start?.payload.radiusM).toBe(25);
  // The window of its searches: the square of side 2 (R + margin) = 70 m around the centre.
  const [x0 = 0, , x1 = 0] = start?.payload.window ?? [];
  expect(x1 - x0).toBeCloseTo(70, 6);

  // The run is recorded: the same overlay from the stored run, at a moment inside its first iteration.
  await step(page, 4); // 500 ticks (50 s)
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 500", { timeout: 20_000 });
  await page.getByTestId("scrub-back").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await openWorkspace(page, "scene");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  // A moment inside the first iteration (it ends when the groups within its radius are visited: how soon depends on the map, so take its middle).
  const span = await page.evaluate(() => {
    const marks = (window.__agentsim?.records?.() ?? []).filter((r) => (r as { agentId?: string; payload?: { op?: string } }).agentId === "ugv-001" && (r as { payload?: { op?: string } }).payload?.op === "explore-iteration") as { simTime: number; payload: { event: string; iteration: number } }[];
    return { start: marks.find((m) => m.payload.event === "start" && m.payload.iteration === 1)?.simTime ?? 0, end: marks.find((m) => m.payload.event === "end" && m.payload.iteration === 1)?.simTime };
  });
  const inside = Math.round((span.end === undefined ? span.start + 0.5 : (span.start + span.end) / 2) * 10) / 10;
  await setReplayCursor(page, inside);
  await expect.poll(async () => (await exploration(page))?.area, { timeout: 15_000 }).toBe(1);
});
