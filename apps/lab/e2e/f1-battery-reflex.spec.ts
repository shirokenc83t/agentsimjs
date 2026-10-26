import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openInspectorSections, sendTo, step } from "./helpers.ts";

interface Rec {
  readonly seq: number;
  readonly kind: string;
  readonly agentId?: string;
  readonly simTime: number;
  readonly payload: { op?: string; name?: string; status?: string; actionId?: string; reflex?: string; code?: string; then?: string; preemptedActionId?: string };
}

const recordsOf = (page: Page, agentId: string) =>
  page.evaluate((id) => (window.__agentsim?.records?.() ?? []).filter((r) => (r as Rec).agentId === id) as Rec[], agentId);

// ROADMAP F1 acceptance: critical battery during goTo → the reflex interrupts it (preempted) and returns to base.
test("critical battery during goTo: the reflex preempts it and the agent returns to base", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);

  // `low` (ugv-002) starts at 17 % with a 15 % critical level and its base at (5, 5).
  await sendTo(page, "ugv-002", 25, 60);
  await openInspectorSections(page);
  const label = page.getByTestId("inspector-action-label");
  for (let k = 0; k < 20 && !/returnToBase · succeeded/.test((await label.textContent()) ?? ""); k++) await step(page, 1);

  // What the researcher sees in the Inspector.
  await expect(label).toContainText("returnToBase · succeeded");
  await expect(page.getByTestId("inspector-reflex")).toBeVisible();
  // The pose shown is the interpolated one and can trail the action label by a frame or two (they travel in different
  // messages): wait for it to arrive instead of reading it once (this read failed 1 run in 12 when it was immediate).
  const distanceToBase = async () => {
    const pos = ((await page.getByTestId("inspector-state").textContent()) ?? "").match(/position\s*([\d.]+) m, ([\d.]+) m/);
    return Math.hypot(Number(pos?.[1]) - 5, Number(pos?.[2]) - 5);
  };
  await expect.poll(distanceToBase, { message: "the rover is at its base", timeout: 5000 }).toBeLessThan(1);
  const battery = Number(((await page.getByTestId("inspector-battery").textContent()) ?? "").match(/^([\d.]+) %/)?.[1]);
  expect(battery).toBeGreaterThan(0);
  expect(battery).toBeLessThan(15.5);

  // The order of events, from the trace: goTo starts, the reflex fires, goTo ends preempted, returnToBase
  // starts and succeeds.
  const recs = await recordsOf(page, "ugv-002");
  const goToStart = recs.find((r) => r.kind === "action" && r.payload.op === "start" && r.payload.name === "goTo");
  const reflex = recs.find((r) => r.kind === "reflex");
  const preempted = recs.find((r) => r.kind === "action" && r.payload.op === "end" && r.payload.status === "preempted");
  const rtbStart = recs.find((r) => r.kind === "action" && r.payload.op === "start" && r.payload.name === "returnToBase");
  const rtbEnd = recs.find((r) => r.kind === "action" && r.payload.op === "end" && r.payload.status === "succeeded" && (r.seq ?? 0) > (rtbStart?.seq ?? Infinity));
  for (const [name, r] of Object.entries({ goToStart, reflex, preempted, rtbStart, rtbEnd })) expect(r, name).toBeDefined();
  // The battery reflex preempted exactly that goTo, then started returnToBase.
  expect(reflex?.payload).toMatchObject({ reflex: "battery", code: "battery_critical", then: "returnToBase", preemptedActionId: goToStart?.payload.actionId });
  expect(preempted?.payload.actionId).toBe(goToStart?.payload.actionId);
  expect((goToStart?.seq ?? 0) < (reflex?.seq ?? 0)).toBe(true);
  expect((reflex?.seq ?? 0) < (rtbStart?.seq ?? 0)).toBe(true);
  expect((preempted?.seq ?? 0) < (rtbStart?.seq ?? 0)).toBe(true);
  expect((rtbStart?.seq ?? 0) < (rtbEnd?.seq ?? 0)).toBe(true);
  expect(rtbEnd?.payload.actionId).toBe(rtbStart?.payload.actionId);
});
