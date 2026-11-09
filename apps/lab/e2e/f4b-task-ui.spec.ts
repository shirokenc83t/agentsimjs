import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { openPanelTab, openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F4b M2 (T-150, the designer's U-024): what the task list of a language-model mind looks like in the inspector, the Log and the Library. The mind is a fake server on localhost (no model, no key) that answers,
// decision by decision: a list of three steps with the first action, the next action with a timer, the same action again at the timer (the brain turns it into `continue`), the last action with a new list.

interface Fake {
  readonly server: Server;
  readonly port: number;
}

const STEPS = [{ text: "take off to 20 m" }, { text: "inspect P1", action: "goTo", params: { xM: 20, yM: 40 } }, { text: "return to base", action: "returnToBase" }];
const ANSWERS: readonly Record<string, unknown>[] = [
  { action: "takeoff", params: { altitudeM: 20 }, task: { steps: STEPS }, step: 1, rationale: "write the plan, then take off" },
  { action: "goTo", params: { xM: 20, yM: 40 }, step: 2, timers: [{ op: "set", tag: "look", delayS: 2 }] },
  { action: "goTo", params: { xM: 20, yM: 40 }, step: 2, rationale: "still going" },
  { action: "returnToBase", params: {}, step: 1, task: { steps: [{ text: "return to base", action: "returnToBase" }, { text: "finish" }] } },
];

async function fake(): Promise<Fake> {
  let decisions = 0;
  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "fake-7b" }] }));
      const parsed = JSON.parse(body || "{}") as { messages?: unknown[] };
      const text = JSON.stringify(parsed.messages ?? []);
      const usage = { prompt_tokens: 900, completion_tokens: 40 };
      // The connection test of the provider has no prompt of a mind.
      if (!text.includes("Who you are")) return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage }));
      const answer = ANSWERS[decisions++] ?? { action: "idle" };
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function startRun(page: Page, port: number) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("fake-task");
  await page.getByTestId("pv-address").fill(`http://localhost:${port}`);
  await page.getByTestId("pv-save").click();
  const started = await page.evaluate(() => window.__agentsim?.startMindsRun?.({ provider: "fake-task", model: "fake-7b", task: true, mission: "Inspect P1 and return to base.", limits: { calls: 100, tokens: 1_000_000 } }).then(() => "ok", (e: unknown) => String(e)));
  expect(started).toBe("ok");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
  await step(page, 6, 60_000);
}

/** Picks the n-th decision (1-based) of the UAV in the Log and opens the LLM inspector on it. */
async function openDecision(page: Page, n: number) {
  await openWorkspace(page, "debug");
  // The decisions of the UAV are the thought records that name a `brainKind` (a model call does not).
  await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:brainkind");
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
  // A new filter starts its list at the end, following the tail: each try goes to the start of the list first, where the first decision is drawn.
  await expect(async () => {
    await page.getByTestId("event-scroller").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.locator('[data-testid^="event-row-"]').nth(n - 1).click({ timeout: 5_000 });
    await expect(page.getByTestId("trace-tree-selected")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await runCommand(page, "Open panel: LLM decision (what a language-model mind was asked and did)");
  await expect(page.getByTestId("llm-lane")).toBeVisible({ timeout: 30_000 });
}

test("the LLM inspector shows the task list as the world held it at each decision, the step a decision names, what it held back and that it went on with the running action", async ({ page }) => {
  test.setTimeout(300_000);
  const f = await fake();
  try {
    await startRun(page, f.port);
    // Decision 1: the mind writes its list and takes off. The world held none: the list is the one this decision wrote, every step pending, and the lane has its task records after the answer.
    await openDecision(page, 1);
    await expect(page.getByTestId("llm-title")).toContainText("decision #1");
    await expect(page.getByTestId("llm-task")).toBeVisible();
    await expect(page.getByTestId("llm-task-source")).toContainText("written by this decision");
    await expect(page.getByTestId("llm-task-row-1")).toHaveAttribute("data-named", "true");
    const kinds = await page.getByTestId("llm-lane").locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    expect(kinds.filter((k) => k === "task").length).toBe(2); // the list, and step 1 running
    await expect(page.getByTestId("llm-lane")).toContainText("list written · 3 steps");
    await expect(page.getByTestId("llm-lane")).toContainText("step 1 of 3 ▶ running · cause: this decision");

    // Decision 2: step 1 is done (the world marked it), step 2 is the one this decision names.
    await page.getByTestId("llm-next").click();
    await expect(page.getByTestId("llm-title")).toContainText("decision #2");
    await expect(page.getByTestId("llm-task-row-1")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("llm-task-row-2")).toHaveAttribute("data-state", "pending");
    await expect(page.getByTestId("llm-task-row-2")).toHaveAttribute("data-named", "true");
    await expect(page.getByTestId("llm-task-counts")).toContainText("3 steps · 1 done");
    await expect(page.getByTestId("llm-task-source")).toContainText("written at #1, unchanged since");
    await expect(page.getByTestId("llm-task-last")).toContainText("step 1 ✓ done · takeoff");

    // Decision 3: a timer woke the mind while goTo ran; it answered the same goTo and the brain went on with it. The list shows step 2 running: ◂ ▸ shows the list change.
    await page.getByTestId("llm-next").click();
    await expect(page.getByTestId("llm-title")).toContainText("decision #3");
    await expect(page.getByTestId("llm-task-row-2")).toHaveAttribute("data-state", "running");
    await expect(page.getByTestId("llm-task-glyph-2")).toHaveText("▶");
    await expect(page.getByTestId("llm-action")).toContainText("↻ continued goTo");
    await expect(page.getByTestId("llm-held")).toHaveText(/held \d+/);
    await expect(page.getByTestId("llm-trigger")).toContainText("timer (control) · wake task");
    await expect(page.getByTestId("llm-trigger")).toContainText("the answer was the action that runs, with the same parameters");
    const answerRow = page.getByTestId("llm-lane").locator('li[data-kind="answer"]');
    await expect(answerRow).toContainText("↻ continued goTo");
    await expect(answerRow).toContainText("no new start");
    await expect(page.getByTestId("llm-lane").locator('li[data-kind="request"]')).toContainText(/\+ \d+ held perception events? \(/);
    await page.getByTestId("llm-prev").click();
    await expect(page.getByTestId("llm-task-row-2")).toHaveAttribute("data-state", "pending");
    await page.getByTestId("llm-next").click();

    // Decision 4 rewrites the list; decision 5 sees the new one and says where it came from.
    await page.getByTestId("llm-next").click();
    await expect(page.getByTestId("llm-title")).toContainText("decision #4");
    // The section shows the list this decision writes (its action is step 1 of it), and the list it replaces apart, collapsed, with nothing named in it.
    await expect(page.getByTestId("llm-task-source")).toContainText("rewritten at #4 (was 3 steps)");
    await expect(page.getByTestId("llm-task-counts")).toContainText("2 steps");
    await expect(page.getByTestId("llm-task-row-1")).toHaveAttribute("data-named", "true");
    await expect(page.getByTestId("llm-task-before")).toContainText("list before this decision · 3 steps");
    await expect(page.getByTestId("llm-task-before-row-1")).not.toHaveAttribute("data-named", "true");
    // The failed step of an earlier decision does not stop a list that goes on: no "list stopped" line at the decisions of this run.
    await expect(page.getByTestId("llm-stopped")).toHaveCount(0);
    await page.getByTestId("llm-next").click();
    await expect(page.getByTestId("llm-title")).toContainText("decision #5");
    await expect(page.getByTestId("llm-task-source")).toContainText("rewritten at #4 (was 3 steps)");
    await expect(page.getByTestId("llm-task-counts")).toContainText("2 steps");
  } finally {
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});

test("the Log tags the task records TSK, follows the cause with Enter, and its two chips filter the decisions that held events back or went on", async ({ page }) => {
  test.setTimeout(300_000);
  const f = await fake();
  try {
    await startRun(page, f.port);
    await openWorkspace(page, "debug");
    await page.getByTestId("log-filter").fill("agent:uav-001 kind:event text:task_step");
    await expect(page.locator('[data-testid^="event-row-"]').first()).toBeVisible({ timeout: 30_000 });
    const first = page.locator('[data-testid^="event-row-"]').first();
    await expect(first).toContainText("TSK");
    await expect(first).toContainText(/step\s*1\s*of\s*3\s*▶\s*running/);
    const done = page.locator('[data-testid^="event-row-"]').filter({ hasText: /step\s*1\s*of\s*3\s*✓\s*done/ }).first();
    await expect(done).toBeVisible();
    // Enter on a TSK row follows its cause: the end of the action for a step that ended.
    await expect(async () => {
      await done.click({ timeout: 5_000 });
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("trace-tree-selected")).toContainText(/end\s*·\s*takeoff/, { timeout: 3_000 });
    }).toPass({ timeout: 60_000 });

    // The chips are fixed terms of the filter text.
    await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:brainkind");
    await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText("decision");
    await page.getByTestId("event-chip-held").click();
    await expect(page.getByTestId("log-filter")).toHaveValue(/text:held/);
    await expect(page.getByTestId("event-chip-held")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => page.locator('[data-testid^="event-row-"]').count()).toBeGreaterThan(0);
    for (const t of await page.locator('[data-testid^="event-row-"]').allTextContents()) expect(t).toContain("held");
    await page.getByTestId("event-chip-continued").click();
    await expect(page.getByTestId("log-filter")).toHaveValue(/text:continued/);
    await expect.poll(async () => page.locator('[data-testid^="event-row-"]').count()).toBe(1);
    await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/↻\s*continued/);
    await page.getByTestId("event-chip-held").click();
    await page.getByTestId("event-chip-continued").click();
    await expect(page.getByTestId("log-filter")).not.toHaveValue(/text:(held|continued)/);
  } finally {
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});

const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "fake-task", model: "fake-7b", promptTemplate: { id: "default", version: 1 }, tools: { allow: ["goTo", "hold", "task"] } } };
const TEMPLATE = { schemaVersion: 1, kind: "prompt-template", system: "You are a careful scout.", sections: ["role", "mission", "events", "actions"] };

async function importJson(page: Page, name: string, doc: unknown) {
  await page.evaluate(
    ([n, text]) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="lib-import-file"]');
      if (input === null) throw new Error("no import input");
      const dt = new DataTransfer();
      dt.items.add(new File([text as string], n as string, { type: "application/json" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [name, JSON.stringify(doc)],
  );
  await expect(page.getByTestId("lib-message")).toContainText("imported as");
}

test("the profile editor has a wake control: an unset profile reads all events and is not changed by saving it; the diff lists wake only once it is set; the tools line says the mind can write a list", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Library");
  await expect(page.getByTestId("library-panel")).toBeVisible({ timeout: 20_000 });
  await importJson(page, "scout-llm.json", PROFILE);
  await expect(page.getByTestId("lib-profile-table")).toContainText("the mind can write a task list");
  await expect(page.getByTestId("lib-profile-table")).toContainText("all events (not set)");

  await page.getByTestId("lib-edit").click();
  await expect(page.getByTestId("lib-wake-all")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("lib-wake-task")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("lib-wake-help")).toContainText("perception events (detected, lost, frontier exhausted) wait");
  await page.getByTestId("lib-save").click();
  await expect(page.getByTestId("lib-message")).toContainText("saved as scout-llm v2");
  await page.getByTestId("lib-compare").check();
  await expect(page.getByTestId("lib-diff")).toBeVisible();
  await page.getByTestId("lib-showall").check();
  await expect(page.getByTestId("lib-diff")).not.toContainText("wake");
  await page.getByTestId("lib-compare").uncheck();

  await page.getByTestId("lib-edit").click();
  await page.getByTestId("lib-wake-task").click();
  await expect(page.getByTestId("lib-wake-task")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("lib-wake-all")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("lib-save").click();
  await expect(page.getByTestId("lib-message")).toContainText("saved as scout-llm v3");
  await expect(page.getByTestId("lib-profile-table")).toContainText("wake");
  await page.getByTestId("lib-compare").check();
  const diff = page.getByTestId("lib-diff");
  await expect(diff).toContainText("s2.wake");
  await expect(diff.locator("tr", { hasText: "s2.wake" })).toContainText("— (all events)");
  await expect(diff.locator("tr", { hasText: "s2.wake" })).toContainText("task");
});

test("the template editor has the task slot: ten slots to add from, a chip that inserts it at the end, and the fold of the slot as it was rendered", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Library");
  await expect(page.getByTestId("library-panel")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("lib-tab-template").click();
  await importJson(page, "scout.json", TEMPLATE);
  await expect(page.getByTestId("lib-item-scout")).toContainText("4 slots");
  await expect(page.getByTestId("lib-item-scout")).not.toContainText("has ‹task›");
  await page.getByTestId("lib-edit").click();
  // Ten slots exist: the four of the template are not offered again, the six others are, `task` among them.
  for (const s of ["task", "notebook", "decisions", "self", "beliefs", "space"]) await expect(page.getByTestId(`lib-slot-${s}`)).toBeVisible();
  await expect(page.getByTestId("lib-task-fold")).toHaveCount(0);
  await page.getByTestId("lib-slot-task").click();
  await expect(page.getByTestId("lib-tokens")).toContainText("task");
  await expect(page.getByTestId("lib-slot-task")).toHaveCount(0);
  const fold = page.getByTestId("lib-task-fold");
  await expect(fold).toBeVisible();
  await expect(fold).toContainText("‹task› as rendered at");
  await fold.locator("summary").click();
  await expect(fold).toContainText("Pick a decision of a language-model mind in the Log");
  await page.getByTestId("lib-save").click();
  await expect(page.getByTestId("lib-message")).toContainText("saved as scout v2");
  await expect(page.getByTestId("lib-item-scout")).toContainText("5 slots · has ‹task›");
});
