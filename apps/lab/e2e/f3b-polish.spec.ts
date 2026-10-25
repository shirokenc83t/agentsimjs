import { expect, test } from "@playwright/test";
import { loadDemo, openWorkspace } from "./helpers.ts";

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
