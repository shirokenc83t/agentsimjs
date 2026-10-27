import { expect, test } from "@playwright/test";
import { loadF2, runCommand, step } from "./helpers.ts";

// F3c M2 (ADR-0043 section 7): the swarm knowledge band in the player, derived from the recorded belief-vs-truth samples of the observer: what the swarm believes it knows, how much of
// that matches the truth, labelled as observer data, with its rate and its agents in the tooltip.

test("the player draws the swarm knowledge band from the recorded observer samples, labelled as observer data, and it grows as the swarm explores", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  const band = page.getByTestId("player-knowledge-band");
  await expect(band).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Number(await band.getAttribute("data-points"))).toBeGreaterThan(2);
  const label = page.getByTestId("player-knowledge");
  await expect(label).toContainText("observer");
  await expect(label).toContainText(/(agents|swarm) know/); // the mean first, the union when the worker has rebuilt the maps
  await expect(label).toContainText("match");
  // The tooltip carries the facts of the definition: that it is observer data and the rate of the samples.
  const tip = (await label.getAttribute("title")) ?? "";
  expect(tip).toContain("observer data");
  expect(tip).toContain("each agent every 10 s");
  expect(tip).toMatch(/mean of|the union of what its agents know/); // which it is, whichever it is
  const early = Number(await band.getAttribute("data-known"));
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 30_000 });
  await expect.poll(async () => Number(await band.getAttribute("data-known"))).toBeGreaterThanOrEqual(early);
});

for (const width of [1440, 1000]) {
  test(`the band's label never cuts its numbers, at ${width} px (the tag is what gives way)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await loadF2(page, "discovery");
    await page.getByTestId("explorer-row-ugv-001").click();
    await runCommand(page, "Explore selected agent (ugv-001)");
    await step(page, 2);
    await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 30_000 });
    const label = page.getByTestId("player-knowledge");
    await expect(label).toContainText(/(agents|swarm) know/);
    const room = await label.evaluate((el) => {
      // The width the numbers need: the label's text up to the end of the failure count, in the label's own font.
      const full = el.textContent ?? "";
      const head = full.slice(0, full.indexOf("✕") + 3);
      const probe = el.cloneNode(false) as HTMLElement;
      probe.textContent = head;
      Object.assign(probe.style, { position: "absolute", visibility: "hidden", width: "auto", maxWidth: "none", overflow: "visible" });
      el.parentElement?.append(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      return { need, have: el.getBoundingClientRect().width };
    });
    expect(room.have, `the label has ${room.have} px, its numbers need ${room.need} px`).toBeGreaterThanOrEqual(room.need - 1);
  });
}

test("the headless monitor shows the knowledge band, and its metric boxes keep their values once the run has ended and the writer has flushed", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "agents");
  await runCommand(page, "Run headless");
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
  await expect(page.getByTestId("hm-knowledge")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("hm-knowledge-line")).toContainText(/(agents|swarm) know/);
  await expect(page.getByTestId("hm-knowledge-line")).toContainText("observer data");
  // The three metric boxes: samples, not "no samples yet", after the end (the writer had records left when the run was done).
  for (const name of ["sim.tickMs", "sim.planExpansions"]) await expect(page.getByTestId(`hm-spark-${name}`)).not.toContainText("no samples yet", { timeout: 30_000 });
});
