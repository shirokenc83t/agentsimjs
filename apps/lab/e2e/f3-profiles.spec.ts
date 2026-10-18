import { expect, test, type Page } from "@playwright/test";
import { step, waitForStorageReady } from "./helpers.ts";

// F3a M2 (T-016): the recording profile is chosen at launch, next to the run configuration, and the status line says how the run is recorded:
// the profile with its hash and the run configuration's, and how far the run is saved (ADR-0035 addition of 2026-10-17, items 2, 6 and 12).

// Pinned hashes of the presets (packages/trace, recording-profile.test.ts): a run records the one it ran under.
const HASH = { minimal: "60b7598a", "default-research": "19cfa400", "debug-full": "99ed1697" } as const;

async function openRun(page: Page) {
  await page.getByTestId("run-label").click();
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
}

test("the recording choice is offered with the run configuration; the status line names the profile and both hashes, and how far the run is saved", async ({ page }) => {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openRun(page);
  const preset = page.getByTestId("recording-preset");
  await expect(preset).toHaveValue("default-research"); // the default
  await expect(page.getByTestId("recording-opt-out")).not.toBeChecked(); // never a default
  await preset.selectOption("minimal");
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  // The header records how the run is recorded, and the popover shows it.
  await expect(page.getByTestId("run-recording")).toHaveText(`minimal · ${HASH.minimal}`);
  const configHash = (await page.getByTestId("run-config-hash").textContent()) ?? "";
  await page.keyboard.press("Escape");
  const status = page.getByTestId("status-recording");
  await expect(status).toHaveText(`● recording minimal · profile ${HASH.minimal} · config ${configHash}`);
  await step(page, 1);
  // Saved to the tick the run is at, once the writer has flushed (it follows within a moment).
  await expect(page.getByTestId("status-recording-saved")).toHaveText(/^saved to tick 100( · head \d+)?$/, { timeout: 10_000 });
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 10_000 });

  // The next run takes the profile chosen next to it: debug-full, a custom one by name.
  await openRun(page);
  await page.getByTestId("recording-preset").selectOption("debug-full");
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("run-recording")).toHaveText(`debug-full · ${HASH["debug-full"]}`);
  await page.keyboard.press("Escape");
  await expect(status).toContainText(`recording debug-full · profile ${HASH["debug-full"]}`);
});

test("a profile typed as JSON is validated before the run starts, and a valid one is the profile the run records under", async ({ page }) => {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId("recording-preset").selectOption("custom");
  const json = page.getByTestId("recording-custom-json");
  await json.fill("{ not json");
  await expect(page.getByTestId("recording-custom-error")).toBeVisible();
  // A profile with a name of its own and a snapshot interval of two minutes.
  const profile = {
    schemaVersion: 0,
    name: "my-profile",
    channels: {
      events: { level: "full" },
      transitions: { level: "transitions" },
      protocol: { level: "full" },
      compute: { level: "summary" },
      "mind-io": { level: "metadata" },
      poses: { rateHz: 1 },
      beliefs: { level: "off", keyframeEveryS: 30 },
      metrics: { rateHz: 1 },
      health: { rateHz: 1 },
      sensors: { level: "off" },
    },
    checkpoints: { everyTicks: 50, snapshotEveryS: 120 },
  };
  await json.fill(JSON.stringify(profile));
  await expect(page.getByTestId("recording-custom-error")).toHaveCount(0);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  await expect(page.getByTestId("run-recording")).toHaveText(/^my-profile · [0-9a-f]{8}$/);
});

test("a realtime run with a heavy profile is warned about before it starts", async ({ page }) => {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId("recording-preset").selectOption("debug-full");
  await expect(page.getByTestId("recording-heavy-warning")).toHaveCount(0); // the time mode shown is lockstep
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Time mode" }).selectOption("realtime");
  await openRun(page);
  await expect(page.getByTestId("recording-heavy-warning")).toContainText("storage_backpressure");
});
