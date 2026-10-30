import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { closeFloats, loadF2, openPanelTab, openWorkspace, runCommand, waitForStorageReady } from "./helpers.ts";

// F4 M4 review material (T-127): the LLM inspector (a looped decision after a retried call; retries ending in the fallback; the limit records), the Compute inspector, the Library (a profile and a version diff, the
// template editor with a lint mark) and the Configurations `minds` table with its estimate, in both themes at 1440 and 1000 px. The servers are fake ones on localhost (no model, no real key). Skipped unless
// AGENTSIM_REVIEW_DIR names the folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");

type Mode = "loop" | "down";
async function fake(mode: Mode): Promise<{ server: Server; port: number }> {
  let decisions = 0;
  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "fake-7b" }] }));
      const parsed = JSON.parse(body || "{}") as { messages?: { role?: string }[] };
      const text = JSON.stringify(parsed.messages ?? []);
      const usage = { prompt_tokens: 900, completion_tokens: 40 };
      if (!text.includes("Who you are")) return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage }));
      if (mode === "down") {
        res.statusCode = 503;
        return void res.end("{}");
      }
      if (!(parsed.messages ?? []).some((m) => m.role === "tool")) {
        if (++decisions === 1) {
          res.statusCode = 503;
          return void res.end("{}");
        }
        return void res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "estimateCost", arguments: JSON.stringify({ route: [{ xM: 40, yM: 20 }, "home"] }) } }, { id: "call_b", type: "function", function: { name: "planPath", arguments: JSON.stringify({ to: { xM: 40, yM: 20 } }) } }] } }],
            usage,
          }),
        );
      }
      return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"takeoff","params":{"altitudeM":20},"rationale":"cost checked, go"}' } }], usage }));
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

async function startRun(page: Page, name: string, port: number, limits?: { calls?: number; tokens?: number }) {
  // A fresh page for each run: the one before may be looking at its own recording (a record picked in the Log moves the view into the replay).
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill(name);
  await page.getByTestId("pv-address").fill(`http://localhost:${port}`);
  await page.getByTestId("pv-save").click();
  await expect(page.getByTestId(`pv-row-${name}`)).toBeVisible();
  const started = await page.evaluate((o) => window.__agentsim?.startMindsRun?.(o).then(() => "ok", (e: unknown) => String(e)), { provider: name, model: "fake-7b", ...(limits === undefined ? {} : { limits }) });
  expect(started).toBe("ok");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("step").click();
    await page.waitForTimeout(600);
  }
}

async function openDecision(page: Page) {
  await openWorkspace(page, "debug");
  await closeFloats(page);
  for (const id of ["llmInspector", "computeInspector"]) {
    const close = page.getByTestId(`wb-close-${id}`);
    if (await close.isVisible()) await close.click();
  }
  await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought text:llm-call");
  await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/llm-call/, { timeout: 30_000 });
  await expect(async () => {
    await page.locator('[data-testid^="event-row-"]').first().click({ timeout: 5_000 });
    await expect(page.getByTestId("trace-tree-selected")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await runCommand(page, "Open panel: LLM inspector (the decision of a language-model mind)");
  await expect(page.getByTestId("llm-lane")).toBeVisible({ timeout: 30_000 });
}

const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "fake-loop", model: "fake-7b", promptTemplate: { id: "default", version: 1 }, limits: { calls: 20 } } };
const TEMPLATE = { schemaVersion: 1, kind: "prompt-template", system: "You are a careful scout. Check the cost of a route before you fly it.", sections: ["role", "mission", "beliefs", "actions"], instructions: { mission: "Read the mission first." } };
async function importJson(page: Page, name: string, doc: unknown) {
  // The file goes in through the page (a DataTransfer), as the file chooser would hand it over.
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

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 1000] as const) {
    test(`M4 review material, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(240_000);
      const loop = await fake("loop");
      const down = await fake("down");
      const tight = await fake("loop");
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
        await page.goto("/?probe");
        await waitForStorageReady(page);

        // 1 · A looped decision after a retried call, and the compute call of it.
        await startRun(page, "fake-loop", loop.port);
        await openDecision(page);
        await expect(page.getByTestId("llm-lane")).toContainText("cost checked, go");
        await page.locator('[data-testid^="llm-step-"]').nth(1).click();
        await expect(page.getByTestId("llm-detail")).toBeVisible();
        await shot(page, "workspace-debug", "llm-inspector-looped", theme, width);
        await page.getByTestId("llm-lane").locator('li[data-kind="tool"] button').last().click();
        await runCommand(page, "Open panel: Compute inspector (a compute call of a mind)");
        await expect(page.getByTestId("compute-map")).toBeVisible({ timeout: 30_000 });
        await shot(page, "workspace-debug", "compute-inspector", theme, width);

        // 2 · A server that is down: invalid or failed calls, the retries, the fallback.
        await startRun(page, "fake-down", down.port);
        await openDecision(page);
        await expect(page.getByTestId("llm-lane")).toContainText(/fallback|retry/i, { timeout: 30_000 });
        await shot(page, "workspace-debug", "llm-inspector-retry-fallback", theme, width);

        // 3 · A low token limit: the 80 % warning as a record of the first decision (the failed call counted by estimate, the two that answered by the server's usage).
        await startRun(page, "fake-tight", tight.port, { tokens: 2500 });
        await openDecision(page);
        await expect(page.getByTestId("llm-lane").locator('li[data-kind="limit"]').first()).toBeVisible({ timeout: 30_000 });
        await shot(page, "workspace-debug", "llm-inspector-limits", theme, width);

        // A fresh page for the rest: the run before is paused at its limit, and the Library and the providers are in the browser's storage.
        await page.goto("/?probe");
        await waitForStorageReady(page);
        // 4 · The Library: a profile with a new version and the diff; a template with a lint mark.
        await openWorkspace(page, "configurations");
        await openPanelTab(page, "Library");
        await expect(page.getByTestId("library-panel")).toBeVisible({ timeout: 20_000 });
        await importJson(page, "scout-llm.json", PROFILE);
        await page.getByTestId("lib-edit").click();
        await page.getByTestId("lib-f-model").fill("qwen2.5:7b");
        await page.getByTestId("lib-f-calls").fill("30");
        await page.getByTestId("lib-save").click();
        await expect(page.getByTestId("lib-message")).toContainText("saved as scout-llm v2");
        await page.getByTestId("lib-compare").check();
        await expect(page.getByTestId("lib-diff")).toBeVisible();
        await shot(page, "workspace-configurations", "library-profile-diff", theme, width);
        await page.getByTestId("lib-compare").uncheck();
        await page.getByTestId("lib-tab-template").click();
        await importJson(page, "inspect.json", TEMPLATE);
        await page.getByTestId("lib-edit").click();
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.type("{{weather}}");
        await expect(page.getByTestId("lib-issues")).toContainText("template_slot_unknown");
        await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({ timeout: 10_000 });
        await shot(page, "workspace-configurations", "library-template-editor", theme, width);

        // 5 · The minds table with the estimate (the profile of step 4, the provider of step 1).
        await loadF2(page, "discovery");
        await openWorkspace(page, "configurations");
        await openPanelTab(page, "Run configuration");
        await page.getByTestId("rc-minds-row-scout").scrollIntoViewIfNeeded();
        await page.getByTestId("rc-minds-kind-scout").selectOption("s2");
        await page.getByTestId("rc-minds-profile-scout").selectOption("scout-llm@2");
        await page.getByTestId("rc-minds-mission-scout").fill("Inspect P1 (20, 40), P2 (50, 20) and P3 (70, 55), then return to base and land.");
        await expect(page.getByTestId("rc-minds-est-calls-scout")).toBeVisible();
        await page.getByTestId("rc-minds").scrollIntoViewIfNeeded();
        await shot(page, "rc-minds", "configurations-minds-table", theme, width);
      } finally {
        for (const f of [loop, down, tight]) await new Promise<void>((r) => f.server.close(() => r()));
      }
    });
  }
}
