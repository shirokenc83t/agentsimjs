import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, runCommand, waitForStorageReady } from "./helpers.ts";

// F4 M4 (T-123): the LLM inspector and the Compute inspector on a real run whose mind is a model over a provider (a fake server on localhost): a looped decision (the model asks for tools, gets their results,
// answers) after a failed first call that is retried, and what the panels show of it. The server is told what to do in the test: no real model, no key.

interface Fake {
  readonly server: Server;
  readonly port: number;
}

/** A server whose decisions go: a 503 the first time (so a retry), then for each decision: tool calls on the first step, the answer once it has the results. */
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
      const parsed = JSON.parse(body || "{}") as { messages?: { role?: string; content?: string }[]; tools?: unknown };
      const text = JSON.stringify(parsed.messages ?? []);
      const usage = { prompt_tokens: 900, completion_tokens: 40 };
      if (!text.includes("Who you are")) return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage }));
      const hasResults = (parsed.messages ?? []).some((m) => m.role === "tool");
      if (!hasResults) {
        decisions++;
        if (decisions === 1) {
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

async function startRun(page: Page, port: number) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("fake-local");
  await page.getByTestId("pv-address").fill(`http://localhost:${port}`);
  await page.getByTestId("pv-save").click();
  const started = await page.evaluate(() => window.__agentsim?.startMindsRun?.({ provider: "fake-local", model: "fake-7b" }).then(() => "ok", (e: unknown) => String(e)));
  expect(started).toBe("ok");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("step").click();
    await expect(page.getByTestId("status-tick")).toHaveText(`tick ${i + 1}`, { timeout: 30_000 });
  }
}

/** Picks the first record of the log that the filter shows. */
async function pickFirst(page: Page, filter: string, shows: RegExp) {
  await openWorkspace(page, "debug");
  await page.getByTestId("log-filter").fill(filter);
  // The list is the filter's once its first row is what the filter selects (before that it is the unfiltered log).
  await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(shows, { timeout: 30_000 });
  await expect(async () => {
    await page.locator('[data-testid^="event-row-"]').first().click({ timeout: 5_000 });
    await expect(page.getByTestId("trace-tree-selected")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

test("the LLM inspector shows the chain of a looped decision in order, after a failed call that was retried; the Compute inspector draws the call on the agent's belief", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fake();
  try {
    await startRun(page, f.port);
    await pickFirst(page, "agent:uav-001 kind:thought text:llm-call", /llm-call/);
    await runCommand(page, "Open panel: LLM inspector (the decision of a language-model mind)");
    const lane = page.getByTestId("llm-lane");
    await expect(lane).toBeVisible({ timeout: 30_000 });
    // The lane: the request, the model calls (the first failed and was retried), the compute calls the model asked for, the answer and the action.
    const kinds = await lane.locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    expect(kinds[0]).toBe("request");
    expect(kinds.filter((k) => k === "call").length).toBeGreaterThanOrEqual(3); // 503, tool calls, answer
    expect(kinds.filter((k) => k === "tool")).toEqual(["tool", "tool"]);
    expect(kinds.indexOf("tool")).toBeGreaterThan(kinds.indexOf("call"));
    expect(kinds.slice(-2)).toEqual(["answer", "action"]);
    await expect(lane).toContainText("estimateCost");
    await expect(lane).toContainText("planPath");
    await expect(lane).toContainText("cost checked, go");
    await expect(page.getByTestId("llm-title")).toContainText("decision #1");
    await expect(page.getByTestId("llm-tiles")).toContainText("fake-7b");
    // A model call opens with its prompt by section (each with its size), and the notebook.
    await page.locator('[data-testid^="llm-step-"][data-testid]').nth(1).click();
    await expect(page.getByTestId("llm-detail")).toBeVisible();
    await expect(page.getByTestId("llm-section-0")).toContainText("tok");
    await page.getByTestId("llm-tab-raw JSON").click();
    await expect(page.getByTestId("llm-raw")).toContainText("llm-call");

    // The compute call: pick it in the lane (it becomes the selected record) and open the Compute inspector.
    await lane.locator('li[data-kind="tool"] button').last().click();
    await runCommand(page, "Open panel: Compute inspector (a compute call of a mind)");
    await expect(page.getByTestId("compute-title")).toHaveText("planPath", { timeout: 30_000 });
    await expect(page.getByTestId("compute-result")).toContainText("waypoint");
    await expect(page.getByTestId("compute-params")).toContainText('"to"');
    await expect(page.getByTestId("compute-map")).toBeVisible();
    await expect(page.getByTestId("compute-belief-note")).toContainText("own belief");
    await expect(page.getByTestId("compute-belief-note")).toContainText("never the truth");
  } finally {
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});

test("the Log and the Trace write a summary line for a model call and a compute call", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fake();
  try {
    await startRun(page, f.port);
    await openWorkspace(page, "debug");
    await page.getByTestId("log-filter").fill("agent:uav-001 kind:thought,compute text:llm-call");
    await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/llm-call\s*·\s*attempt\s*\d/);
    await page.getByTestId("log-filter").fill("agent:uav-001 kind:compute");
    await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText(/tool\s*·\s*(estimateCost|planPath)\s*·\s*found/);
  } finally {
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});
