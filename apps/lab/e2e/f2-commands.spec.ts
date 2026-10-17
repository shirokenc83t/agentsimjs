import { expect, test } from "@playwright/test";
import { loadDemo, runCommand, sendTo, step, stepUntilEnded } from "./helpers.ts";

// ADR-0015 addition of 2026-10-12: researcher commands (world scope, preconditions still apply) from the Inspector, the
// palette and the Scene. A refusal shows its stable code.
test("takeoff, land, explore, hold and send-to from the UI; a command the agent cannot run is refused with its code", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const result = page.getByTestId("inspector-command-result");
  const label = page.getByTestId("inspector-action-label");

  // The scout (uav-001) starts on the ground: send-to is refused by the goTo precondition, with its code.
  await sendTo(page, "uav-001", 20, 20);
  await step(page, 1);
  await expect(result).toContainText("goTo · refused · precondition_failed");

  // Takeoff from the Inspector is accepted and runs to success; the same send-to is then accepted.
  await page.getByTestId("command-takeoff").click();
  await stepUntilEnded(page, 6);
  await expect(result).toContainText("takeoff · accepted");
  await expect(label).toContainText("takeoff · succeeded");
  await sendTo(page, "uav-001", 20, 20);
  await step(page, 1);
  await expect(result).toContainText("goTo · accepted");

  // Land and hold through the palette on the selected agent.
  await runCommand(page, "Land selected agent");
  await step(page, 1);
  await expect(result).toContainText("land · accepted");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Hold selected agent");
  await step(page, 1);
  await expect(result).toContainText("hold · accepted");
  await expect(label).toContainText("hold");

  // Explore from the Inspector button; a UAV-only command on a ground vehicle is refused with its code.
  await page.getByTestId("command-explore").click();
  await step(page, 1);
  await expect(result).toContainText("explore");
  await page.getByTestId("command-takeoff").click();
  await step(page, 1);
  await expect(result).toContainText("takeoff · refused · vehicle_unsupported");
});
