import { expect, test, type Page } from "@playwright/test";
import { LABEL_PX } from "../src/panels/debug/timeline-geometry.ts";
import { loadDemo, openWorkspace, runCommand, setReplayCursor, step } from "./helpers.ts";

// F3b M2: "Re-simulate window…" from the palette (ADR-0035 section 3): a window of the recorded run around the cursor is executed again in a worker of its own, stored as a derived run
// linked to its parent with its verdict, and shown; the live run goes on untouched.

test("the palette re-simulates a window of the run into a derived run that matches, and the live run is not touched", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  const tickBefore = await page.getByTestId("status-tick").textContent();

  await runCommand(page, "Re-simulate window…");
  const note = page.getByTestId("resim-notice");
  await expect(note).toContainText("re-simulated as run-000002", { timeout: 120_000 });
  await expect(note).toContainText("it matches");
  await expect(note).not.toContainText("DIVERGENT");
  // The live run keeps its place: it is not replaced and not stepped by the re-simulation.
  await expect(page.getByTestId("replay-segment")).toHaveCount(0);
  expect((await page.getByTestId("status-tick").textContent()) ?? "").toBe(tickBefore);

  // It is a run of its own in storage, marked with its parent.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("run-row-run-000002")).toContainText("window");
  await expect(page.getByTestId("run-row-run-000001")).toBeVisible();
  await page.getByTestId("resim-notice-dismiss").click();
  await expect(note).toHaveCount(0);
});

test("a run that was not recorded cannot be re-simulated by window, and the reason is said", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("recording-opt-out").check();
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("run-id")).not.toHaveText("run-000001");
  await page.keyboard.press("Escape");
  await step(page, 2);
  await runCommand(page, "Re-simulate window…");
  await expect(page.getByTestId("resim-notice")).toContainText("was not recorded", { timeout: 30_000 });
  await expect(page.getByTestId("resim-notice")).toContainText("cannot be re-simulated");
});

/** A drag on the Timeline's ruler between two fractions of the track. */
async function dragRuler(page: Page, from: number, to: number): Promise<void> {
  const box = await page.getByTestId("timeline-canvas").boundingBox();
  if (!box) throw new Error("no timeline");
  const track = box.width - LABEL_PX;
  const y = box.y + 8; // on the ruler
  await page.mouse.move(box.x + LABEL_PX + track * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + LABEL_PX + track * ((from + to) / 2), y, { steps: 4 });
  await page.mouse.move(box.x + LABEL_PX + track * to, y, { steps: 4 });
  await page.mouse.up();
}

test("a drag on the Timeline's ruler selects a window, Esc clears it, 'Re-simulate this window' uses it, and the derived run opens in replay with its window as the range", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();

  // A selection, shown with its ends; Esc clears it.
  await dragRuler(page, 0.3, 0.6);
  const selected = page.getByTestId("timeline-selection");
  await expect(selected).toHaveText(/selected \d+\.\d–\d+\.\d s/);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);

  // A selection again; the window of the re-simulation is that one.
  await dragRuler(page, 0.3, 0.6);
  const [t0, t1] = ((await selected.textContent()) ?? "").match(/\d+\.\d/g)?.map(Number) ?? [];
  expect(t1 as number).toBeGreaterThan((t0 as number) + 3);
  await page.getByTestId("timeline-resim").click();
  const note = page.getByTestId("resim-notice");
  await expect(note).toContainText("re-simulated as run-000002", { timeout: 120_000 });
  await expect(note).toContainText(`Window ${t0}–${t1} s`);
  await expect(note).toContainText("it matches");

  // The derived run opens in the panels like any recorded run, marked as derived, and its scrub range is the window.
  await page.getByTestId("resim-notice-open").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("replay-segment")).toContainText("of run-000001");
  await expect(page.getByTestId("replay-segment")).toContainText("✓");
  await expect(page.getByTestId("replay-segment")).toHaveAttribute("title", /every recorded checkpoint in the window was reproduced/);
  await expect(page.getByTestId("player-derived")).toContainText(`${(t0 as number).toFixed(1)}–${(t1 as number).toFixed(1)} s`);
  const start = Number(await page.getByTestId("replay-cursor").getAttribute("min"));
  expect(start).toBeGreaterThan((t0 as number) - 0.3);
  expect(start).toBeLessThanOrEqual(t0 as number);
  const end = Number(await page.getByTestId("replay-cursor").getAttribute("max"));
  expect(end).toBeGreaterThan((t1 as number) - 0.3);
  expect(end).toBeLessThan((t1 as number) + 0.3);
  // The agents were built from the configuration records the window carries: the Explorer lists them, and the cursor moves inside the window.
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("explorer-row-ugv-001")).toBeVisible();
  await setReplayCursor(page, Math.round(((t0 as number) + (t1 as number)) * 5) / 10);
  await page.getByTestId("replay-close").click();
  await expect(page.getByTestId("replay-segment")).toHaveCount(0);
});

test("a window can be re-simulated from the log console, from the Timeline and from the inspector, each into a derived run that matches", async ({ page }) => {
  test.setTimeout(300_000);
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  await openWorkspace(page, "debug");
  const note = page.getByTestId("resim-notice");

  // The log console: the time in view (or the Timeline's selection).
  await expect(page.getByTestId("log-resim")).toBeEnabled();
  await page.getByTestId("log-resim").click();
  await expect(note).toContainText("re-simulated as run-000002", { timeout: 120_000 });
  await expect(note).toContainText("it matches");
  await page.getByTestId("resim-notice-dismiss").click();

  // The Timeline.
  await page.getByTestId("timeline-resim").click();
  await expect(note).toContainText("re-simulated as run-000003", { timeout: 120_000 });
  await expect(note).toContainText("it matches");
  await page.getByTestId("resim-notice-dismiss").click();

  // The multi-log inspector, in Replay.
  await runCommand(page, "Open panel: Logs");
  await page.getByTestId("inspector-replay").check();
  await page.getByTestId("inspector-resim").click();
  await expect(note).toContainText("re-simulated as run-000004", { timeout: 120_000 });
  await expect(note).toContainText("it matches");

  // All three are derived runs of the same parent, each marked with its verdict.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  for (const id of ["run-000002", "run-000003", "run-000004"]) {
    await expect(page.getByTestId(`derived-${id}`)).toContainText("of run-000001");
    await expect(page.getByTestId(`derived-${id}`)).toContainText("✓ matches");
  }
});
