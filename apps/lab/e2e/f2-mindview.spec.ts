import { expect, test } from "@playwright/test";
import { loadF2, sendTo, step, stepUntilEnded } from "./helpers.ts";

// ROADMAP F2 acceptance, from the Inspector's "What the mind receives": the decision request of the selected agent as
// its mind gets it (the world's own builder, JSON text), never a UI-side reconstruction.
test("an object beyond sensor range is not in the mind's beliefs; after approach it appears as detected", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("mind-request-status")).toContainText("would be sent now");
  await expect(page.getByTestId("mind-entities")).toHaveText("none");
  expect(await page.getByTestId("mind-request-json").textContent({ timeout: 1000 }).catch(() => "")).not.toContain("marker-1");

  // Send the rover to the marker's side of the wall (around the north end): it is seen on the way, not before.
  await sendTo(page, "ugv-001", 50, 10);
  await stepUntilEnded(page, 25);
  await expect(page.getByTestId("inspector-action-label")).toContainText("goTo · succeeded");
  await expect(page.getByTestId("mind-entity-marker-1")).toContainText("marker · detected");
  const json = (await page.getByTestId("mind-request-json").textContent()) ?? "";
  expect(JSON.parse(json).beliefs.entities.map((e: { id: string }) => e.id)).toContain("marker-1");
});

test("a grounded UAV has no allowed goTo until it takes off; the mind view says why", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-uav-001").click();
  await expect(page.getByTestId("mind-allowed")).not.toContainText("goTo");
  await expect(page.getByTestId("mind-allowed")).toContainText("takeoff");
  await expect(page.getByTestId("mind-unavailable-goTo")).toContainText("precondition_failed");

  // Send-to is refused by the same precondition, with its code, in the command result.
  await sendTo(page, "uav-001", 20, 20);
  await step(page, 1);
  await expect(page.getByTestId("inspector-command-result")).toContainText("goTo · refused · precondition_failed");

  // After takeoff the mind is allowed goTo (and no longer allowed takeoff).
  await page.getByTestId("command-takeoff").click();
  await stepUntilEnded(page, 6);
  await expect(page.getByTestId("mind-allowed")).toContainText("goTo");
  await expect(page.getByTestId("mind-allowed")).not.toContainText("takeoff");
  await expect(page.getByTestId("mind-unavailable-takeoff")).toContainText("precondition_failed");
});
