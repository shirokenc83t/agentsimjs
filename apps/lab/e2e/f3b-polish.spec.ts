import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// F3b M5 polish (the designer's review of 2026-10-25): nothing is cut off, empty screens say what goes there, the shell keeps its shape. What can be measured is measured here.

for (const width of [1440, 1000]) {
  test(`the run popover has no scrollbar of its own at ${width} px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await loadDemo(page);
    await page.getByTestId("run-label").click();
    const pop = page.locator(".run-info");
    await expect(pop).toBeVisible();
    // What would show a scrollbar: the popover and its ancestors that scroll sideways (overflow auto or scroll) and are wider inside than outside, and the page itself.
    const over = await pop.evaluate((el) => {
      const out: { tag: string; cls: string; over: number }[] = [];
      const scrolls = (e: Element) => ["auto", "scroll"].includes(getComputedStyle(e).overflowX);
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const h = e as HTMLElement;
        if (scrolls(h) && h.scrollWidth - h.clientWidth > 1) out.push({ tag: h.tagName, cls: h.className.toString().slice(0, 40), over: h.scrollWidth - h.clientWidth });
      }
      for (const c of el.querySelectorAll<HTMLElement>("*")) if (scrolls(c) && c.scrollWidth - c.clientWidth > 1) out.push({ tag: c.tagName, cls: c.className.toString().slice(0, 40), over: c.scrollWidth - c.clientWidth });
      const root = document.scrollingElement as HTMLElement;
      if (root.scrollWidth - root.clientWidth > 1) out.push({ tag: "PAGE", cls: "", over: root.scrollWidth - root.clientWidth });
      // Nothing of the popover's own content runs past its right edge.
      const box = el.getBoundingClientRect();
      for (const c of el.querySelectorAll<HTMLElement>("*")) if (c.getBoundingClientRect().right > box.right + 1 && c.getBoundingClientRect().width > 0) out.push({ tag: c.tagName, cls: c.className.toString().slice(0, 40), over: Math.round(c.getBoundingClientRect().right - box.right) });
      return out;
    });
    expect(over, `elements of the popover that scroll sideways: ${JSON.stringify(over)}`).toEqual([]);
  });
}

test("an empty screen says what goes there and the one action that fills it: Experiments, the SQL results, the Trace, the Scenario editor", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await openWorkspace(page, "experiments");
  await expect(page.getByTestId("hm-empty")).toContainText("No headless run");
  await expect(page.getByTestId("hm-rerun-headless")).toContainText("Re-run headless");
  await expect(page.getByTestId("hm-rerun-headless")).toContainText("Ctrl+Shift+R");
  await openWorkspace(page, "data");
  await expect(page.getByTestId("sql-empty")).toContainText("No result yet");
  await expect(page.getByTestId("sql-empty-run")).toBeVisible();
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("trace-tree-empty")).toContainText("No record selected");
  await openWorkspace(page, "configurations");
  await page.getByRole("tab", { name: /Scenario editor/ }).click();
  await expect(page.getByTestId("ed-empty")).toContainText("No scenario open");
  await page.getByTestId("ed-empty-new").click();
  await expect(page.getByTestId("ed-new-id")).toBeVisible();
});

test("Re-run headless from the empty Experiments screen starts a headless run", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await openWorkspace(page, "experiments");
  await page.getByTestId("hm-rerun-headless").click();
  await expect(page.getByTestId("hm-state")).toBeVisible({ timeout: 30_000 });
});

test("the player keeps one height and the same cells in every workspace, and the Explorer's footer is one line", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  const heights: Record<string, number> = {};
  const cells: Record<string, number> = {};
  for (const ws of ["scene", "debug", "configurations", "data", "settings", "experiments", "analysis"] as const) {
    await openWorkspace(page, ws);
    await expect(page.getByTestId("attention-tile")).toBeVisible(); // the last tile is a lazy one
    const box = await page.getByTestId("player").boundingBox();
    heights[ws] = Math.round(box?.height ?? 0);
    cells[ws] = await page.getByTestId("player").locator(".telem > *").count();
  }
  expect(new Set(Object.values(heights)).size, `player height by workspace: ${JSON.stringify(heights)}`).toBe(1);
  expect(new Set(Object.values(cells)).size, `telemetry cells by workspace: ${JSON.stringify(cells)}`).toBe(1);
  await openWorkspace(page, "scene");
  const legend = await page.getByTestId("explorer").locator(".legend").boundingBox();
  expect(legend?.height ?? 99, "the footer is one line").toBeLessThan(24);
});

test("the live track is neutral: only the head is the accent", async ({ page }) => {
  await loadDemo(page);
  await page.getByTestId("step").click();
  const fill = page.locator(".track .sv").first();
  await expect(fill).toBeVisible();
  const same = await page.evaluate(() => {
    const sv = document.querySelector(".track .sv");
    const probe = document.createElement("div");
    probe.style.background = "var(--bg3)";
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(sv as Element).backgroundColor === want;
  });
  expect(same, "the recorded part of the track is the neutral fill").toBe(true);
});

test("the Scene's collapsed windows sit in one row along its bottom edge and do not cover each other", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  const wins = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".dv-resize-container"))
      .filter((e) => e.querySelector(".collapsed") !== null || e.classList.contains("collapsed") || e.getBoundingClientRect().height <= 31)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.left), right: Math.round(r.right), y: Math.round(r.top), h: Math.round(r.height) };
      })
      .sort((a, b) => a.x - b.x),
  );
  expect(wins.length, "three collapsed windows (Overview, Legend, Performance)").toBeGreaterThanOrEqual(3);
  expect(new Set(wins.map((w) => w.y)).size, `one row: ${JSON.stringify(wins)}`).toBe(1);
  for (let i = 1; i < wins.length; i++) expect((wins[i] as { x: number }).x, "no overlap").toBeGreaterThanOrEqual((wins[i - 1] as { right: number }).right);
});

/** No cell of the player (the launch row, the clock, the scrub, the tiles) overlaps another, and none runs past the window. */
async function playerHasNoOverlap(page: Page, width: number, where: string): Promise<void> {
  const boxes = await page.evaluate(() => {
    const player = document.querySelector('[data-testid="player"]') as HTMLElement;
    const cells = [...Array.from(player.children), ...Array.from(player.querySelectorAll(".telem > *"))] as HTMLElement[];
    return cells.map((e) => {
      const r = e.getBoundingClientRect();
      return { name: `${e.tagName}.${e.className.toString().slice(0, 24)}`, l: r.left, r: r.right, t: r.top, b: r.bottom };
    });
  });
  for (const a of boxes) expect(a.r, `${where}: ${a.name} runs past the window`).toBeLessThanOrEqual(width + 1);
  const top = boxes.filter((b) => !b.name.includes("tile")); // the player's own children, side by side
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i] as (typeof top)[number];
      const b = top[j] as (typeof top)[number];
      const apart = a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1;
      expect(apart, `${where}: ${a.name} overlaps ${b.name}`).toBe(true);
    }
  const tiles = boxes.filter((b) => b.name.includes("tile"));
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i] as (typeof tiles)[number];
      const b = tiles[j] as (typeof tiles)[number];
      expect(a.r <= b.l + 1 || b.r <= a.l + 1, `${where}: tiles overlap`).toBe(true);
    }
}

for (const width of [1440, 1000]) {
  test(`no cell of the player overlaps another at ${width} px: READY with a command queued, live, replay and a derived replay`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    await loadF2(page, "discovery");
    await openWorkspace(page, "scene");
    await page.getByTestId("explorer-row-ugv-001").click();
    await expect(page.getByTestId("ready-start")).toBeVisible();
    await page.getByTestId("command-explore").click();
    await expect(page.getByTestId("player-queued")).toContainText("1 command queued");
    await playerHasNoOverlap(page, width, "READY with a command queued");
    await step(page, 3); // a step starts the run: it is live, paused
    await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
    await playerHasNoOverlap(page, width, "live");
    await page.getByTestId("scrub-back").click();
    await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
    await playerHasNoOverlap(page, width, "replay");
    await page.getByTestId("replay-close").click();
    await runCommand(page, "Re-simulate window…");
    await expect(page.getByTestId("resim-notice")).toContainText("re-simulated as run-", { timeout: 120_000 });
    await page.getByTestId("resim-notice-open").click();
    await expect(page.getByTestId("player-derived")).toBeVisible({ timeout: 30_000 });
    await playerHasNoOverlap(page, width, "derived replay");
  });
}

/** An exploring rover recorded to tick 300, in the Debug workspace. */
async function exploringDebug(page: Page): Promise<void> {
  await loadF2(page, "discovery");
  await openWorkspace(page, "scene");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  await openWorkspace(page, "debug");
  await expect.poll(async () => await page.locator('[data-testid^="event-row-"]').count(), { timeout: 20_000 }).toBeGreaterThan(5);
}

test("the Log's summary has at least 200 px at 1440 in both Debug layouts, and its title bar keeps the title and a one-line switch in two columns", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await exploringDebug(page);
  const summaryWidth = () => page.locator(".event-row .sum").first().evaluate((e) => e.getBoundingClientRect().width);
  expect(await summaryWidth(), "1 col: the summary column").toBeGreaterThanOrEqual(200);
  await page.keyboard.press("Alt+L");
  await expect(page.getByTestId("layout-select")).toHaveValue("debug · two columns");
  await expect.poll(summaryWidth, { message: "2 col: the summary column" }).toBeGreaterThanOrEqual(200);
  // The title bar of the Log: its title is shown whole, the switch is one line.
  const bar = page.getByTestId("window-buttons-eventList");
  const sw = await page.getByTestId("cols-switch").boundingBox();
  expect(sw?.height ?? 99, "the switch is one line").toBeLessThanOrEqual(26);
  const title = page.locator(".dv-tab", { hasText: "Log" }).first();
  await expect(title).toContainText("Log");
  const t = await title.evaluate((e) => ({ clip: e.scrollWidth > e.clientWidth + 1, w: e.getBoundingClientRect().width }));
  expect(t.clip, "the title is not cut").toBe(false);
  // (The hidden tooltips make scrollWidth useless: measure the buttons themselves.)
  const out = await bar.evaluate((e) => {
    const right = e.getBoundingClientRect().right;
    return Array.from(e.children).filter((c) => c.getBoundingClientRect().right > right + 1).length;
  });
  expect(out, "nothing of the buttons runs out of the bar").toBe(0);
});

test("the Timeline is as tall as its lanes (no empty band, no horizontal scrollbar) and the Scene's windows sit on its bottom edge in the Debug too", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await exploringDebug(page);
  const panel = page.getByTestId("timeline");
  await expect.poll(async () => await panel.evaluate((e) => e.clientHeight - ((e.querySelector(".timeline-lanes") as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0) + e.getBoundingClientRect().top), { timeout: 10_000 }).toBeLessThan(24);
  expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "no horizontal scrollbar").toBe(true);
  const winsNow = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-testid="scene"]')?.closest(".dv-groupview")?.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>(".dv-resize-container"))
        .filter((e) => e.getBoundingClientRect().height <= 31)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { host: host ? { b: Math.round(host.bottom), l: Math.round(host.left), r: Math.round(host.right) } : undefined, b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) };
        });
    });
  // The windows are placed again once the Scene has its size (the Timeline under it is sized to its lanes after the marks are read): wait for that.
  await expect
    .poll(async () => (await winsNow()).every((w) => w.host !== undefined && Math.abs(w.host.b - w.b) <= 14), { timeout: 10_000, message: `the windows on the Scene's bottom edge: ${JSON.stringify(await winsNow())}` })
    .toBe(true);
  const wins = await winsNow();
  expect(wins.length, "the Performance window, collapsed").toBeGreaterThanOrEqual(1);
  for (const w of wins) {
    expect(w.l).toBeGreaterThanOrEqual((w.host?.l ?? 0) - 1);
    expect(w.r).toBeLessThanOrEqual((w.host?.r ?? 0) + 1);
  }
});

test("Configurations opens on the Run configuration, Settings' jump row warns on Storage while it is not persistent, and the theme button is in lower case", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await openWorkspace(page, "configurations");
  await expect(page.getByRole("tab", { name: /Run configuration/ })).toHaveAttribute("aria-selected", "true");
  await openWorkspace(page, "settings");
  await expect(page.getByTestId("st-jump-storage")).toContainText("▲");
  const tt = await page.getByTestId("theme-button").evaluate((e) => getComputedStyle(e).textTransform);
  expect(tt).toBe("none");
});

test("the Debug's right column is Log 40 · Trace 22 · Inspector 38 % of the dock", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("event-list")).toBeVisible();
  await expect(page.getByTestId("trace-tree")).toBeVisible();
  const h = await page.evaluate(() => {
    const of = (id: string) => (document.querySelector(`[data-testid="${id}"]`)?.closest(".dv-groupview") as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
    return { log: of("event-list"), trace: of("trace-tree"), inspector: of("inspector") };
  });
  const total = h.log + h.trace + h.inspector;
  expect(h.log / total, JSON.stringify(h)).toBeCloseTo(0.4, 1);
  expect(h.trace / total, JSON.stringify(h)).toBeCloseTo(0.22, 1);
  expect(h.inspector / total, JSON.stringify(h)).toBeCloseTo(0.38, 1);
});
