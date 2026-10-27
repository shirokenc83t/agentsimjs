import { expect, test, type Page } from "@playwright/test";
import { loadDemo, runCommand, step } from "./helpers.ts";

// F3c M2, fix round 1 (U-016): the top bar at 1000 px in a live run, a replay and a derived replay. The workspace tabs never hide, the brand does not run into them, the replay segment is
// not cut, and the palette key stays on screen: the bar gives way in steps (layout fold, theme word, brand name and run label), the tabs never.

async function recorded(page: Page): Promise<void> {
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
}

async function checkBar(page: Page, width: number, where: string, replaying: boolean): Promise<void> {
  const bar = await page.evaluate(() => {
    const top = document.querySelector("header.top") as HTMLElement;
    const box = (e: Element | null) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { l: r.left, r: r.right, cut: (e as HTMLElement).scrollWidth - (e as HTMLElement).clientWidth };
    };
    return {
      overflow: top.scrollWidth - top.clientWidth,
      brand: box(top.querySelector(".brand")),
      nav: box(top.querySelector(".ws-nav")),
      tabs: Array.from(top.querySelectorAll(".ws")).map((e) => box(e)),
      segment: box(top.querySelector('[data-testid="replay-segment"]')),
      key: box(top.querySelector('[aria-label="Command palette"]')),
    };
  });
  expect(bar.tabs, `${where}: seven workspace tabs`).toHaveLength(7);
  for (const [i, t] of bar.tabs.entries()) {
    expect(t?.r ?? Infinity, `${where}: tab ${i + 1} inside the window`).toBeLessThanOrEqual(width);
    expect(t?.cut ?? 1, `${where}: tab ${i + 1} not cut`).toBeLessThanOrEqual(1);
  }
  expect(bar.brand?.r ?? Infinity, `${where}: the brand does not run into the tabs`).toBeLessThanOrEqual((bar.nav?.l ?? 0) + 1);
  expect(bar.overflow, `${where}: the bar does not overflow`).toBeLessThanOrEqual(1);
  expect(bar.key?.r ?? Infinity, `${where}: the palette key stays on screen`).toBeLessThanOrEqual(width);
  if (replaying) {
    expect(bar.segment, `${where}: the replay segment is there`).not.toBeNull();
    expect(bar.segment?.cut ?? 1, `${where}: the replay segment is not cut`).toBeLessThanOrEqual(1);
  }
}

for (const width of [1000, 1440]) {
  test(`the top bar at ${width} px keeps its tabs whole, in a live run, a replay and a derived replay`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    await recorded(page);
    await checkBar(page, width, "live", false);
    await page.getByTestId("scrub-back").click();
    await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
    await checkBar(page, width, "replay", true);
    await page.getByTestId("replay-close").click();
    await runCommand(page, "Re-simulate window…");
    await expect(page.getByTestId("resim-notice")).toContainText("re-simulated as run-000002", { timeout: 120_000 });
    await page.getByTestId("resim-notice-open").click();
    await expect(page.getByTestId("player-derived")).toBeVisible({ timeout: 30_000 });
    await checkBar(page, width, "derived replay", true);
  });
}

test("the brand is the drawn mark (an agent in a cell, from the glyph font) at a size that reads as a mark, not the boxed glyph it replaced", async ({ page }) => {
  await loadDemo(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const mark = await page.evaluate(() => {
    const m = document.querySelector(".brand .mark") as HTMLElement;
    const cs = getComputedStyle(m);
    return { code: m.textContent?.codePointAt(0), size: Number.parseFloat(cs.fontSize), font: cs.fontFamily, loaded: document.fonts.check("24px 'AgentSim Glyphs'", "") };
  });
  expect(mark.code).toBe(0xe000);
  expect(mark.size).toBeGreaterThanOrEqual(20);
  expect(mark.font).toContain("AgentSim Glyphs");
  expect(mark.loaded).toBe(true);
});
