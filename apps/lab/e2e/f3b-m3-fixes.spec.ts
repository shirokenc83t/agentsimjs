import { expect, test, type Page } from "@playwright/test";
import { layoutControls, loadDemo, loadF2, openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F3b M3, fix round 1 (the designer's review of the observability panels): what the review found, each as a check that fails without the fix.

/** A recorded demo run with a derived run of it open in replay. */
async function derivedReplay(page: Page): Promise<void> {
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  await runCommand(page, "Re-simulate window…");
  await expect(page.getByTestId("resim-notice")).toContainText("re-simulated as run-000002", { timeout: 120_000 });
  await page.getByTestId("resim-notice-open").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-derived")).toBeVisible();
}

for (const width of [1440, 1000]) {
  test(`in a derived replay the palette key and the attention tile stay on screen at ${width} px, and the derived marking is compact with its whole text in a tooltip`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: 900 });
    await derivedReplay(page);
    const key = await page.getByLabel("Command palette").first().boundingBox();
    expect(key, "the palette key").not.toBeNull();
    expect((key?.x ?? 0) + (key?.width ?? 0)).toBeLessThanOrEqual(width);
    const tile = await page.getByTestId("attention-tile").boundingBox();
    expect(tile, "the attention tile").not.toBeNull();
    expect((tile?.x ?? 0) + (tile?.width ?? 0)).toBeLessThanOrEqual(width);
    const back = await page.getByTestId("replay-close").boundingBox();
    expect((back?.x ?? 0) + (back?.width ?? 0), "Back to live").toBeLessThanOrEqual(width);
    // Nothing of the page is wider than the window (a bar that overflows is clipped, and what is in it is gone).
    const wide = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("header.top, .player")).map((el) => el.scrollWidth - el.clientWidth));
    expect(wide.every((w) => w <= 1)).toBe(true);
    const seg = page.getByTestId("replay-segment");
    await expect(seg).toContainText("◇");
    await expect(seg).not.toContainText("matches");
    await expect(seg).toHaveAttribute("title", /re-simulated window/);
  });
}

/** A recorded F2 run with an agent exploring: marks, flags and records for the panels to show. */
async function explored(page: Page): Promise<void> {
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
}

test("N1: the Logs are a layout of the Debug: the inspector fills the area with the Timeline below and no Scene; 'Back to debug' puts the dock back as it was; Alt+6 is the same as the command", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await explored(page);
  await openWorkspace(page, "debug");
  const tabs = page.locator(".dv-tab");
  await expect(tabs.filter({ hasText: "SCENE" })).toHaveCount(1);
  await expect(page.getByTestId("log-inspector")).toHaveCount(0); // not a tab of the dock any more
  const before = await tabs.allTextContents();

  await runCommand(page, "Open panel: Logs");
  await expect(page.getByTestId("log-inspector")).toBeVisible();
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("debug · logs");
  await expect(tabs.filter({ hasText: "SCENE" })).toHaveCount(0);
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  // The sources are a 200 px column, collapsible to a rail; the panes take the rest in a grid.
  const tree = page.getByTestId("source-tree");
  expect((await tree.boundingBox())?.width).toBeGreaterThanOrEqual(190);
  expect((await tree.boundingBox())?.width).toBeLessThanOrEqual(205);
  await page.getByTestId("source-tree-toggle").click();
  await expect(tree).toHaveAttribute("data-open", "false");
  expect((await tree.boundingBox())?.width).toBeLessThan(50);
  await page.getByTestId("source-tree-toggle").click();
  await expect(page.getByTestId("inspector-panes")).toHaveAttribute("data-layout", "grid");

  // Back to debug: the dock as it was.
  await page.getByTestId("inspector-back").click();
  await expect(page.getByTestId("log-inspector")).toHaveCount(0);
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("");
  await expect.poll(async () => tabs.allTextContents()).toEqual(before);
  await expect(page.getByTestId("event-list")).toBeVisible();

  // Alt+6 is the Logs; the palette has "Back to debug" while the layout is open.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("Alt+6");
  await expect(page.getByTestId("log-inspector")).toBeVisible();
  await runCommand(page, "Back to debug");
  await expect(page.getByTestId("event-list")).toBeVisible();

  // The working layout was not overwritten by the other one: after a reload the Debug is the Debug.
  await runCommand(page, "Open panel: Logs");
  await expect(page.getByTestId("log-inspector")).toBeVisible();
  await page.waitForTimeout(800);
  await page.reload();
  await waitForStorageReady(page);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("event-list")).toBeVisible();
  await expect(page.getByTestId("log-inspector")).toHaveCount(0);
});

test("N1: panes keep their minimum size: they are a grid when they fit, and when they do not they stack as tabs and never overlap", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await explored(page);
  await openWorkspace(page, "debug");
  await runCommand(page, "Open panel: Logs");
  await page.getByTestId("inspector-add").selectOption("table");
  await expect(page.getByTestId("inspector-panes")).toHaveAttribute("data-layout", "grid"); // three panes, 2 x 2, each at least its minimum
  const cells = await page.locator(".li-cell:not([hidden])").evaluateAll((els) => els.map((e) => ({ w: e.clientWidth, h: e.clientHeight, view: e.querySelector("[data-view]")?.getAttribute("data-view") })));
  const min = { log: [420, 200], table: [360, 200], series: [300, 160] } as const;
  expect(cells).toHaveLength(3);
  for (const c of cells) {
    const [w, h] = min[c.view as keyof typeof min];
    expect(c.w, `${c.view} width`).toBeGreaterThanOrEqual(w - 2);
    expect(c.h, `${c.view} height`).toBeGreaterThanOrEqual(h - 2);
  }
  // The window gets shorter: three panes no longer fit, so they are tabs, one shown, none overlapping another.
  await page.setViewportSize({ width: 1440, height: 640 });
  await expect(page.getByTestId("inspector-panes")).toHaveAttribute("data-layout", "tabs");
  await expect(page.getByTestId("pane-tabs")).toBeVisible();
  await expect(page.locator(".li-cell:not([hidden])")).toHaveCount(1);
  await page.getByTestId("pane-tab-n3").click();
  await expect(page.locator(".li-cell:not([hidden]) [data-view]")).toHaveAttribute("data-view", "table");
});

test("N2: below about 640 px the log rows drop the source column and keep time, agent, tag and summary, with the result at the right", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await explored(page);
  await openWorkspace(page, "debug");
  const row = page.locator('[data-testid^="event-row-"]').first();
  await expect(row).toBeVisible();
  const cols = await row.evaluate((el) => Array.from(el.children).filter((c) => c.tagName === "SPAN").map((c) => ({ shown: getComputedStyle(c).display !== "none", w: (c as HTMLElement).offsetWidth })));
  expect((await page.getByTestId("event-scroller").boundingBox())?.width).toBeLessThan(640);
  expect(cols[3]?.shown, "source").toBe(false);
  for (const i of [0, 1, 2, 4]) expect(cols[i]?.shown, `column ${i}`).toBe(true);
  expect(cols[4]?.w, "the summary has room").toBeGreaterThan(80);
  await expect(row).toHaveAttribute("title", /\//); // the source is in the row tooltip
});

test("N5, S1, S5: the SQL console says rows, time and limit; a narrow result has narrow columns; the Run tip never covers the message; the editor is coloured", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await step(page, 1);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 20_000 });
  await openWorkspace(page, "data");
  const editor = page.getByTestId("sql-editor");
  await editor.fill("SELECT kind, count(*) AS n FROM trace_records GROUP BY kind ORDER BY n DESC");
  await expect(page.locator(".sql-hl .sq-keyword").first()).toBeVisible(); // SELECT, FROM and the rest are drawn in their colour behind the text
  const kw = await page.locator(".sql-hl .sq-keyword").first().evaluate((el) => getComputedStyle(el).color);
  const plain = await page.locator(".sql-hl").evaluate((el) => getComputedStyle(el).color);
  expect(kw).not.toBe(plain);
  await page.getByTestId("sql-run").hover();
  await page.getByTestId("sql-run").click();
  await expect(page.getByTestId("sql-status")).toContainText("rows", { timeout: 15_000 });
  await expect(page.getByTestId("sql-status")).toContainText(/\d+ ms · limit 10000/);
  // Two narrow columns, not two stretched over the width.
  const head = await page.locator(".sql-head > span").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetWidth));
  expect(head).toHaveLength(2);
  expect(Math.max(...head)).toBeLessThan(400);
  // A refused write: its message carries the cross, and the tip of Run (it was over the message) is closed by the click.
  await editor.fill("DELETE FROM trace_records");
  await page.getByTestId("sql-run").click();
  await expect(page.getByTestId("sql-error")).toContainText("✕");
  const tip = await page.getByTestId("sql-run").evaluate((el) => getComputedStyle(el, "::after").display);
  expect(tip).toBe("none");
  const run = await page.getByTestId("sql-run").boundingBox();
  const msg = await page.getByTestId("sql-error").boundingBox();
  expect((run?.y ?? 0) + (run?.height ?? 0)).toBeLessThanOrEqual((msg?.y ?? 0) + 1); // the message is under the control, and nothing is drawn over it
});

test("N7: the Storage browser keeps a run id, label and status on one line; what it holds wraps", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await explored(page);
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  const row = page.getByTestId("run-row-run-000001");
  await expect(row).toBeVisible();
  const cells = await row.locator("td").evaluateAll((els) => els.map((e) => ({ h: (e as HTMLElement).offsetHeight, text: (e.textContent ?? "").trim() })));
  const line = Math.min(...cells.map((c) => c.h));
  for (const i of [0, 1, 2]) expect(cells[i]?.h, `${cells[i]?.text}`).toBeLessThanOrEqual(line + 4);
  await expect(row.locator("td").first()).toHaveText("run-000001");
});

test("N6: a hover on the Timeline tells what is under it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await explored(page);
  await openWorkspace(page, "debug");
  const canvas = page.getByTestId("timeline-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no timeline");
  // Find a bin of the ugv-001 lane by hovering along it.
  const laneY = box.y + 18 + 19 * 2 + 9;
  let title = "";
  for (let x = box.x + 100; x < box.x + box.width - 10 && !title; x += 9) {
    await page.mouse.move(x, laneY);
    title = (await canvas.getAttribute("title")) ?? "";
  }
  expect(title).toMatch(/\d+ marks?: .*×\d+|action|reflex/);
});

test("S2: a derived run is marked in the Log, the Timeline and the Logs, and its copied records in the rows", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await derivedReplay(page);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("event-list").getByTestId("derived-tag")).toContainText("◇ derived");
  await expect(page.getByTestId("timeline").getByTestId("derived-tag")).toContainText("◇ derived");
  await expect(page.locator('[data-testid^="row-copy-"]').first()).toBeVisible({ timeout: 15_000 }); // the configuration records the window carries from its parent
  await runCommand(page, "Open panel: Logs");
  await expect(page.getByTestId("log-inspector").getByTestId("derived-tag")).toBeVisible();
});

test("S4: a parse error that has a known fix says it", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await openWorkspace(page, "debug");
  await page.getByTestId("log-filter").fill("kind:action AND agent:ugv-001");
  await expect(page.getByTestId("log-filter-error")).toContainText("terms are already joined by AND; remove it");
});

test("S6: no agent label is covered by another label or by its badge", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await explored(page);
  for (const ws of ["scene", "debug"] as const) {
    await openWorkspace(page, ws);
    await page.waitForTimeout(800);
    const overlaps = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll<HTMLElement>(".agent-label"))
        .filter((el) => getComputedStyle(el).display !== "none" && el.offsetWidth > 0)
        .map((el) => {
          let r = el.getBoundingClientRect();
          let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
          for (const c of Array.from(el.children)) {
            if ((c as HTMLElement).hidden) continue;
            r = c.getBoundingClientRect();
            [l, t, rt, b] = [Math.min(l, r.left), Math.min(t, r.top), Math.max(rt, r.right), Math.max(b, r.bottom)];
          }
          return { id: el.getAttribute("data-agent"), l, t, r: rt, b };
        });
      const hits: string[] = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i] as (typeof boxes)[number];
          const c = boxes[j] as (typeof boxes)[number];
          const w = Math.min(a.r, c.r) - Math.max(a.l, c.l);
          const h = Math.min(a.b, c.b) - Math.max(a.t, c.t);
          if (w > 1 && h > 1) hits.push(`${a.id} / ${c.id}`);
        }
      return { hits, n: boxes.length };
    });
    expect(overlaps.n, `${ws}: labels measured`).toBeGreaterThanOrEqual(3);
    expect(overlaps.hits, ws).toEqual([]);
  }
});
