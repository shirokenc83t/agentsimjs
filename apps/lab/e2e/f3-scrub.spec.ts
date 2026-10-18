import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, setReplayCursor, step } from "./helpers.ts";

// F3a M3 (T-026, acceptance 3): a recorded run is scrubbed from storage. The cursor reaches the tick it was sent to (the Inspector shows the same state at a
// moment before and after a detour through other moments), and no query blocks a frame: while the cursor is dragged about, the render loop keeps producing frames.

const AGENT = "ugv-001";

async function frameTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => (window.__agentsim?.frames ?? []).map(([t]) => t));
}

test("a recorded run is scrubbed: the cursor reaches its tick, and the render loop is not held by the reads it makes", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await page.getByTestId("run-label").click();
  const original = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await step(page, 6); // 600 ticks (60 s)
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 20_000 });
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click(); // another run, so the first is a recording like any other
  await expect(page.getByTestId("run-id")).not.toHaveText(original);
  await page.keyboard.press("Escape");

  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByTestId(`replay-${original}`).click();
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("replay-label")).toContainText(original, { timeout: 30_000 });
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await page.getByTestId("overlay-belief").click();
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.pages), { timeout: 15_000 }).toBe(1);

  const settle = async () => {
    await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.chunksPending), { timeout: 10_000 }).toBe(0);
    await page.waitForTimeout(500);
  };
  const stateAndOverlay = async () => ({
    state: await page.getByTestId("inspector-state").textContent(),
    overlay: await page.evaluate(() => {
      const out: (number | undefined)[] = [];
      for (let j = 0; j < 128; j += 4) for (let i = 0; i < 128; i += 4) out.push(window.__agentsim?.scene?.beliefCell(i, j));
      return out;
    }),
  });

  await setReplayCursor(page, 40);
  await settle();
  const first = await stateAndOverlay();
  expect(first.overlay.some((v) => v === 1), "the rover has seen free space by 40 s").toBe(true);

  // A detour: the cursor dragged about at about 25 Hz, forward and back, while the frames are counted.
  await page.evaluate(() => (window.__agentsim && (window.__agentsim.frames.length = 0)));
  for (const t of [5, 55, 12.3, 33, 59, 1, 25, 48, 3.5, 40]) {
    await setReplayCursor(page, t);
    await page.waitForTimeout(40);
  }
  const during = await frameTimes(page);
  expect(during.length, "frames were drawn during the detour").toBeGreaterThan(10);
  const gaps = during.slice(1).map((t, i) => t - (during[i] ?? t));
  // No read holds a frame: software rendering is slow, so the bound is loose (a frame's interval, not a budget); a blocked loop would show seconds.
  expect(Math.max(...gaps), `longest gap between frames: ${Math.max(...gaps).toFixed(0)} ms`).toBeLessThan(500);

  // Back at 40 s: the same tick, so the same state and the same overlay as before the detour.
  await expect(page.getByTestId("replay-time")).toContainText("40.0 s /");
  await settle();
  const again = await stateAndOverlay();
  expect(again.state).toBe(first.state);
  expect(again.overlay).toEqual(first.overlay);
});
