import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { closeFloats, openPanelTab, openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F4b M2 review material (T-151): the task list of a mind in the LLM inspector (a running and a refused step, a preempted one and a rewritten list), a decision that went on with its action and one that held perception
// events back, the Log with its TSK rows and the two chips, the profile editor with `wake` and the template editor with the `task` slot and its fold, in both themes at 1440 and 1000 px. The mind is a fake server on
// localhost (no model, no key). Skipped unless AGENTSIM_REVIEW_DIR names the folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");

interface Fake {
  readonly server: Server;
  readonly port: number;
}

const STEPS = [
  { text: "take off to 20 m", action: "takeoff", params: { altitudeM: 20 } },
  { text: "inspect P1", action: "goTo", params: { xM: 20, yM: 40 } },
  { text: "check the far corner", action: "goTo", params: { xM: 5000, yM: 5000 } },
  { text: "hold and look around", action: "hold", params: { durationS: 5 } },
  { text: "inspect P2", action: "goTo", params: { xM: 40, yM: 60 } },
];
const ANSWERS: readonly Record<string, unknown>[] = [
  { action: "takeoff", params: { altitudeM: 20 }, task: { steps: STEPS }, step: 1, rationale: "write the plan, then take off" },
  { action: "goTo", params: { xM: 20, yM: 40 }, step: 2, timers: [{ op: "set", tag: "look", delayS: 2 }], rationale: "P1 first" },
  { action: "goTo", params: { xM: 20, yM: 40 }, step: 2, rationale: "still going to P1" },
  { action: "goTo", params: { xM: 5000, yM: 5000 }, step: 3, rationale: "look at the far corner (nothing the vehicle knows leads there: this fails)" },
  { action: "hold", params: { durationS: 5 }, step: 4, timers: [{ op: "set", tag: "enough", delayS: 1 }], rationale: "look around" },
  { action: "goTo", params: { xM: 40, yM: 60 }, step: 5, rationale: "enough looking, P2 now (this ends the hold)" },
  { action: "returnToBase", params: {}, step: 1, task: { steps: [{ text: "return to base", action: "returnToBase" }, { text: "finish" }] }, rationale: "P2 done: a shorter list for the way back" },
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
      const usage = { prompt_tokens: 1200, completion_tokens: 60 };
      if (!JSON.stringify(parsed.messages ?? []).includes("Who you are")) return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage }));
      const answer = ANSWERS[decisions++] ?? { action: "idle" };
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function shot(page: Page, testId: string, name: string, theme: string, width: number) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  mkdirSync(DIR as string, { recursive: true });
  await page.getByTestId(testId).screenshot({ path: `${DIR}/${name}-${width}-${theme}.png` });
}

async function startRun(page: Page, port: number) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("fake-task");
  await page.getByTestId("pv-address").fill(`http://localhost:${port}`);
  await page.getByTestId("pv-save").click();
  const started = await page.evaluate(() => window.__agentsim?.startMindsRun?.({ provider: "fake-task", model: "fake-7b", task: true, mission: "Inspect P1 and P2, look at the far corner on the way, then return to base.", limits: { calls: 100, tokens: 1_000_000 } }).then(() => "ok", (e: unknown) => String(e)));
  expect(started).toBe("ok");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
  await step(page, 9, 60_000);
}

/** Picks the n-th decision of the UAV in the Log (the list goes to its start first: a new filter follows the tail). */
async function pickDecision(page: Page, n: number) {
  await openWorkspace(page, "debug");
  await closeFloats(page);
  await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:brainkind");
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
  await expect(async () => {
    await page.getByTestId("event-scroller").evaluate((el) => {
      el.scrollTop = 0;
    });
    // The list is the filter's once its rows are decisions (before that it is the log as it was).
    await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/decision/, { timeout: 5_000 });
    await expect(page.locator('[data-testid^="event-row-"]').nth(n - 1)).toContainText(/decision/, { timeout: 5_000 });
    await page.locator('[data-testid^="event-row-"]').nth(n - 1).click({ timeout: 5_000 });
    await expect(page.getByTestId("trace-tree-selected")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/** Goes to decision n of the inspector with its ◂ ▸ buttons, one at a time (each waits for the title to say where it is). */
async function goToDecision(page: Page, n: number) {
  for (let guard = 0; guard < 20; guard++) {
    const now = Number(/#(\d+)/.exec((await page.getByTestId("llm-title").textContent()) ?? "")?.[1]);
    if (now === n) return;
    const button = page.getByTestId(now < n ? "llm-next" : "llm-prev");
    await expect(button).toBeEnabled({ timeout: 10_000 });
    await button.click();
    await expect(page.getByTestId("llm-title")).toContainText(`decision #${now < n ? now + 1 : now - 1}`, { timeout: 10_000 });
  }
  throw new Error(`could not reach decision ${n}`);
}

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

const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "fake-task", model: "fake-7b", promptTemplate: { id: "default", version: 2 }, tools: { allow: ["takeoff", "goTo", "hold", "returnToBase", "task"] }, limits: { calls: 100 } } };
const TEMPLATE = { schemaVersion: 1, kind: "prompt-template", system: "You are a careful scout. Write your task as steps, name the step of each action and let a running action go on.", sections: ["role", "mission", "events", "actions"] };

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 1000] as const) {
    test(`M2 review material, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(420_000);
      const f = await fake();
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
        await startRun(page, f.port);

        // The inspector: a running step and a refused one (decision 6: step 4 still runs, step 3 was refused), the step it names; then the decision that ends the hold and writes a new list (7), and the list it wrote (8).
        await pickDecision(page, 6);
        await runCommand(page, "Open panel: LLM decision (what a language-model mind was asked and did)");
        await expect(page.getByTestId("llm-task")).toBeVisible({ timeout: 30_000 });
        await goToDecision(page, 6);
        await expect(page.getByTestId("llm-task-row-3")).toHaveAttribute("data-state", "refused");
        await shot(page, "workspace-debug", "inspector-running-refused", theme, width);
        await goToDecision(page, 7);
        await expect(page.getByTestId("llm-task-row-4")).toHaveAttribute("data-state", "preempted");
        await shot(page, "workspace-debug", "inspector-preempted-rewriting", theme, width);
        await goToDecision(page, 8);
        await expect(page.getByTestId("llm-task-source")).toContainText("rewritten at #7");
        await shot(page, "workspace-debug", "inspector-rewritten", theme, width);

        // A decision that held perception events back (4), and one that went on with the running action (3).
        await goToDecision(page, 4);
        await expect(page.getByTestId("llm-held")).toBeVisible();
        await shot(page, "workspace-debug", "inspector-held", theme, width);
        await goToDecision(page, 3);
        await expect(page.getByTestId("llm-action")).toContainText("↻ continued");
        await shot(page, "workspace-debug", "inspector-continued", theme, width);

        // The Log: the TSK rows, then the decisions with the two chips.
        // The inspector is a window over the Log: it is put away so that the rows can be clicked and are all in the picture (the next decision is picked again for the fold of the slot).
        const close = page.getByTestId("wb-close-llmInspector");
        if (await close.isVisible()) await close.click();
        await page.getByTestId("log-filter").fill("agent:uav-001 kind:event text:task_step");
        await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText("TSK", { timeout: 30_000 });
        await expect(async () => {
          await page.getByTestId("event-scroller").evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.locator('[data-testid^="event-row-"]').first().click({ timeout: 5_000 });
          await expect(page.locator('[data-testid^="event-row-"][aria-selected="true"]')).toHaveCount(1, { timeout: 3_000 });
        }).toPass({ timeout: 60_000 });
        await shot(page, "workspace-debug", "log-tsk", theme, width);
        await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:brainkind");
        await expect.poll(async () => page.locator('[data-testid^="event-row-"]').count()).toBeGreaterThan(3);
        await page.getByTestId("event-chip-held").click();
        await expect.poll(async () => page.locator('[data-testid^="event-row-"]').count()).toBeGreaterThan(0);
        await shot(page, "workspace-debug", "log-chips", theme, width);

        // The last decision stays the one picked, for the fold of the task slot as it was rendered there.
        await pickDecision(page, 8);
        // The Library: a profile with `wake` (the control, its help and the diff), and a template with the task slot and its fold at the decision picked above.
        await openWorkspace(page, "configurations");
        await openPanelTab(page, "Library");
        await expect(page.getByTestId("library-panel")).toBeVisible({ timeout: 20_000 });
        await importJson(page, "scout-llm.json", PROFILE);
        await page.getByTestId("lib-edit").click();
        await page.getByTestId("lib-wake-task").click();
        await page.getByTestId("lib-wake").scrollIntoViewIfNeeded();
        await shot(page, "workspace-configurations", "library-wake-control", theme, width);
        await page.getByTestId("lib-save").click();
        await expect(page.getByTestId("lib-message")).toContainText("saved as scout-llm v2");
        await page.getByTestId("lib-compare").check();
        await expect(page.getByTestId("lib-diff")).toContainText("s2.wake");
        await shot(page, "workspace-configurations", "library-wake-diff", theme, width);
        await page.getByTestId("lib-tab-template").click();
        await importJson(page, "scout.json", TEMPLATE);
        await page.getByTestId("lib-edit").click();
        await page.getByTestId("lib-slot-task").click();
        await page.getByTestId("lib-task-fold").locator("summary").click();
        await expect(page.getByTestId("lib-task-text")).toContainText("[done]");
        await shot(page, "workspace-configurations", "library-task-slot", theme, width);
      } finally {
        await new Promise<void>((r) => f.server.close(() => r()));
      }
    });
  }
}
