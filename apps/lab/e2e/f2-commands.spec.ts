import { expect, test } from "@playwright/test";
import { loadDemo, runCommand, sendTo, step, stepUntilEnded } from "./helpers.ts";

// ADR-0015 addition of 2026-10-12: researcher commands (world scope, preconditions still apply) from the Inspector, the
// palette and the Scene. A refusal shows its stable code.
test("takeoff, land, explore, hold and send-to from the UI; a command the agent cannot be given now is off, with its reason and the step to do first", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const result = page.getByTestId("inspector-command-result");
  const label = page.getByTestId("inspector-action-label");

  await page.getByTestId("explorer-row-uav-001").click();
  // The scout (uav-001) starts on the ground: what needs flight is off before the click (explore, land, send-to), each with its reason and the step to do first; takeoff is on.
  for (const op of ["explore", "land"]) {
    await expect(page.getByTestId(`command-${op}`)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId(`command-${op}`)).toHaveAttribute("title", /needs airborne · take off first/); // focusable, with its tooltip
  }
  await expect(page.getByTestId("command-hint")).toContainText("→ Land needs airborne · take off first · Explore needs airborne · take off first");
  await expect(page.getByTestId("command-takeoff")).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("send-to")).toBeDisabled();
  await expect(page.getByTestId("send-to")).toHaveAttribute("title", /Send to needs airborne · take off first/);

  // Takeoff from the Inspector is accepted and runs to success; then explore and send-to are on, and takeoff is the one that is off.
  await page.getByTestId("command-takeoff").click();
  await stepUntilEnded(page, 6);
  await expect(result).toContainText("takeoff · accepted");
  await expect(label).toContainText("takeoff · succeeded");
  await expect(page.getByTestId("command-explore")).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("command-takeoff")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("command-hint")).toContainText("Takeoff needs to be on the ground · land first");
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

  // Explore from the Inspector button; a UAV-only command on a ground vehicle is off, and says so.
  await page.getByTestId("command-explore").click();
  await step(page, 1);
  await expect(result).toContainText("explore");
  await expect(page.getByTestId("command-takeoff")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("command-takeoff")).toHaveAttribute("title", /Takeoff is not for a ground vehicle/);
});
