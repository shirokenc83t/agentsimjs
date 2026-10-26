import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, openWorkspace, runCommand } from "./helpers.ts";

// F3b M5 (the maintainer's manual check): the theme control of the top bar, and the canvases that draw with the tokens (the top-down map, the Timeline) follow a change of theme.

/** The colour of a pixel of a canvas, as [r, g, b]. */
async function pixel(page: Page, testId: string, x: number, y: number): Promise<number[]> {
  return page.getByTestId(testId).evaluate((c: HTMLCanvasElement, at) => Array.from(c.getContext("2d")?.getImageData(at.x, at.y, 1, 1).data ?? []).slice(0, 3), { x, y });
}
const luminance = (rgb: number[]) => 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);

test("the theme button and Ctrl+Shift+L change the theme, and the map and the Timeline redraw with the new tokens", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => window.localStorage.setItem("agentsim.ui.theme", "dark"));
  await loadDemo(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // The Scene's 2D view is the same canvas as the Analysis map: its background is the dark token.
  await page.getByTestId("map-view-2d").click();
  await expect(page.getByTestId("map2d-canvas")).toBeVisible();
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeLessThan(90);

  // The menu: dark, light, system; the current one is checked.
  await page.getByTestId("theme-button").click();
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The canvas is drawn again with the light tokens, not left in the colours it read once.
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeGreaterThan(160);

  // Ctrl+Shift+L toggles back, from anywhere.
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeLessThan(90);

  // The Timeline of the Debug workspace follows too.
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  const dark = luminance(await pixel(page, "timeline-canvas", 40, 25));
  await page.getByTestId("theme-button").click();
  await page.getByTestId("theme-light").click();
  await expect.poll(async () => luminance(await pixel(page, "timeline-canvas", 40, 25))).toBeGreaterThan(dark + 60);
});

test("when the top bar is too narrow the layout controls fold into one `layout ▾` first: the theme button and ctrl+k stay, and the menu has the same controls", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1000, height: 700 });
  await loadDemo(page);
  await expect(page.getByTestId("layout-fold")).toBeVisible();
  await expect(page.getByTestId("layout-select")).toHaveCount(0);
  await expect(page.getByTestId("theme-button")).toBeVisible();
  await expect(page.getByLabel("Command palette").first()).toBeVisible();
  const right = async (id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    return (b?.x ?? 0) + (b?.width ?? 0);
  };
  expect(await right("theme-button")).toBeLessThanOrEqual(1000);
  await page.getByTestId("layout-fold").click();
  await expect(page.getByTestId("layout-menu")).toBeVisible();
  await expect(page.getByTestId("layout-select")).toBeVisible();
  await expect(page.getByTestId("layout-save")).toBeVisible();
  await expect(page.getByTestId("layout-reset")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layout-menu")).toHaveCount(0);
  // With room again the controls are back in the bar.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.getByTestId("layout-fold")).toHaveCount(0);
  await expect(page.getByTestId("layout-select")).toBeVisible();
});

test("a run waits in READY at tick 0 with the choice live or headless; nothing runs until it is made; Live starts it, Step and the keys still work, Headless opens the monitor", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const ready = page.getByTestId("ready-start");
  await expect(ready).toContainText("START run-000001");
  await expect(page.getByTestId("ready-summary")).toContainText(/lockstep · f1-demo v\d+ · seed \d+ · profile default-research/);
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0"); // nothing ran while it waited

  // Step is a way of going live, paused: READY is over and the run is where the step took it.
  await page.getByTestId("step").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 1");
  await expect(ready).toHaveCount(0);

  // A new run is READY again; Live starts it.
  await page.keyboard.press("Control+r");
  await expect(page.getByTestId("run-label")).toContainText("run-000002");
  await expect(page.getByTestId("ready-start")).toContainText("START run-000002");
  await page.getByTestId("play").click();
  await expect(page.getByTestId("pause")).toBeVisible();
  await expect(page.getByTestId("ready-start")).toHaveCount(0);
  await page.getByTestId("pause").click();

  // Headless from READY: the Experiments monitor follows the run.
  await page.keyboard.press("Control+r");
  await expect(page.getByTestId("ready-start")).toBeVisible();
  await page.getByTestId("ready-headless").click();
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
});

test("the player's Re-run is one split button: the label repeats the last choice and the menu has live lockstep, live realtime and headless, with what they share", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await expect(page.getByTestId("player-rerun")).toHaveText(/Re-run$/);
  await expect(page.getByTestId("rerun-in-mode")).toHaveCount(0);
  await page.getByTestId("rerun-menu").click();
  await expect(page.getByTestId("rerun-live-lockstep")).toContainText("Ctrl+R");
  await expect(page.getByTestId("rerun-live-realtime")).toBeVisible();
  await expect(page.getByTestId("rerun-headless")).toContainText("Ctrl+Shift+R");
  await expect(page.getByTestId("rerun-same")).toContainText("same scenario, config, seed and the 0 commands of run-000001");
  await page.getByTestId("rerun-live-realtime").click();
  await expect(page.getByTestId("time-mode")).toHaveText("realtime");
  await expect(page.getByTestId("player-rerun")).toContainText("Re-run · live · realtime"); // the label repeats the last choice
  // Ctrl+Shift+R is the headless re-run.
  await page.keyboard.press("Control+Shift+R");
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
});

test("the run configuration is one column with a jump row that scrolls the form only: the panel, the jump row and the page stay where they are", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "configurations");
  await page.getByRole("tab", { name: /Run configuration/ }).click();
  const panel = page.getByTestId("run-config-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("rc-nav-planning")).toHaveCount(0); // the rail is gone
  const col = await page.locator(".rc-col").boundingBox();
  expect(col?.width ?? 9999).toBeLessThanOrEqual(880);
  const before = await panel.boundingBox();
  const jumpBefore = await page.getByTestId("rc-jump").boundingBox();
  await page.getByTestId("rc-jump-beliefs").click();
  // The form scrolled as far as it could to put the Beliefs header under the jump row (a short form cannot scroll further); nothing else moved.
  const box = (await page.locator('section.fs[data-section="beliefs"] > h4').boundingBox()) ?? { y: 0, height: 0 };
  expect(box.y).toBeGreaterThanOrEqual((jumpBefore?.y ?? 0) + (jumpBefore?.height ?? 0) - 1);
  expect(box.y + box.height).toBeLessThanOrEqual((before?.y ?? 0) + (before?.height ?? 0));
  expect(await panel.boundingBox()).toEqual(before);
  expect(await page.getByTestId("rc-jump").boundingBox()).toEqual(jumpBefore);
  expect(await page.evaluate(() => window.scrollY + document.documentElement.scrollTop)).toBe(0);
  // The section header stays under the jump row while its fields scroll.
  await expect(page.getByTestId("rc-status-beliefs")).toBeVisible();
});

test("a live re-run chosen from a headless run opens the Scene and starts live", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await runCommand(page, "Run headless");
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
  await page.getByTestId("player-rerun").click();
  await expect(page.getByTestId("workspace-scene")).toBeVisible();
  await expect(page.getByTestId("run-label")).toContainText("run-000003");
  await expect(page.getByTestId("pause")).toBeVisible({ timeout: 15_000 }); // it is running, live
  await expect(page.getByTestId("ready-start")).toHaveCount(0);
});

test("a command given while the run waits is queued at once: the button says so until a tick applies it", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("ready-start")).toBeVisible(); // nothing runs: the run is waiting
  await page.getByTestId("command-explore").click();
  await expect(page.getByTestId("command-explore")).toHaveAttribute("data-state", "queued");
  await expect(page.getByTestId("command-explore")).toContainText("▷ Explore · queued · starts on ▶");
  await expect(page.getByTestId("player-queued")).toHaveText("1 command queued · ugv-001 explore"); // and the player says it next to Play
  await page.waitForTimeout(800);
  await expect(page.getByTestId("command-explore")).toHaveAttribute("data-state", "queued"); // still waiting: no tick has run
  await page.getByTestId("step").click();
  await expect(page.getByTestId("command-explore")).not.toHaveAttribute("data-state", "queued");
  await expect(page.getByTestId("player-queued")).toHaveCount(0);
  await expect(page.getByTestId("command-explore")).toHaveAttribute("data-state", /running|done/);
});

test("the Log's title bar has a 1 col | 2 col switch between the two Debug layouts", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("cols-1")).toHaveAttribute("aria-pressed", "true");
  const dockW = async () => (await page.locator(".dv-dockview").first().boundingBox())?.width ?? 1;
  const logW = async () => (await page.getByTestId("event-list").boundingBox())?.width ?? 0;
  const before = await logW();
  await page.getByTestId("cols-2").click();
  await expect(page.getByTestId("cols-2")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await logW()) / (await dockW())).toBeLessThan(0.34); // the Log leaves the 38 % column for its own of about 28 %
  expect(await logW()).toBeLessThan(before);
  await page.getByTestId("cols-1").click();
  await expect(page.getByTestId("cols-1")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await logW()) / (await dockW())).toBeGreaterThan(0.34);
});

test("the Scene Inspector opens on the ID card and the commands; every other section is one line that a click opens, with open all and fold all; what the vehicle cannot do is not offered", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-idcard")).toBeVisible();
  await expect(page.getByTestId("inspector-commands")).toBeVisible();
  // A ground vehicle is not given takeoff: no button, one line says so.
  await expect(page.getByTestId("command-takeoff")).toHaveCount(0);
  await expect(page.getByTestId("command-unsupported")).toContainText("Takeoff is not for a ground vehicle");
  // The other sections are folded to a summary.
  await expect(page.getByTestId("inspector-state")).toContainText("battery");
  await expect(page.getByTestId("inspector-battery")).toHaveCount(0);
  await page.getByTestId("fold-head-state").click();
  await expect(page.getByTestId("inspector-battery")).toBeVisible();
  await page.getByTestId("fold-head-state").click();
  await expect(page.getByTestId("inspector-battery")).toHaveCount(0);
  await page.getByTestId("inspector-expand-all").click();
  await expect(page.getByTestId("inspector-battery")).toBeVisible();
  await expect(page.getByTestId("inspector-plan")).toBeVisible();
  await page.getByTestId("inspector-collapse-all").click();
  await expect(page.getByTestId("inspector-battery")).toHaveCount(0);
  await expect(page.getByTestId("inspector-commands")).toBeVisible();
});
