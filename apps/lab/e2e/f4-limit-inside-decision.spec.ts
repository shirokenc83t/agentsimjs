import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { openWorkspace, waitForStorageReady } from "./helpers.ts";

// F4 M5 (T-128): a limit passed inside the first decision of a stepped run pauses it with the notice (it used to stay "waiting for S2" with nothing to answer), and the raise lets the decision finish. A fake
// server on localhost: the first call fails (503, counted by estimate), the next two answer with 940 tokens each, against a token limit of 2 300.

async function fake(): Promise<{ server: Server; port: number }> {
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
      const usage = { prompt_tokens: 900, completion_tokens: 40 };
      if (!(parsed.messages ?? []).some((m) => m.role === "tool")) {
        if (++decisions === 1) {
          res.statusCode = 503;
          return void res.end("{}");
        }
        return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "planPath", arguments: JSON.stringify({ to: { xM: 40, yM: 20 } }) } }] } }], usage }));
      }
      return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"takeoff","params":{"altitudeM":20},"rationale":"go"}' } }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

test("a token limit passed inside the first decision of a stepped run pauses it with the notice; the raise lets the decision finish", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fake();
  try {
    await page.goto("/?probe");
    await waitForStorageReady(page);
    await openWorkspace(page, "settings");
    await page.getByTestId("pv-add").click();
    await page.getByTestId("pv-name").fill("fake-local");
    await page.getByTestId("pv-address").fill(`http://localhost:${f.port}`);
    await page.getByTestId("pv-save").click();
    const started = await page.evaluate(() => window.__agentsim?.startMindsRun?.({ provider: "fake-local", model: "fake-7b", limits: { tokens: 2300 } }).then(() => "ok", (e: unknown) => String(e)));
    expect(started).toBe("ok");
    await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
    await openWorkspace(page, "scene");
    await page.getByTestId("step").click();
    // Nobody plays: the step waits for the decision, whose last call passes the limit. The notice is there, with the limit's figures.
    const notice = page.getByTestId("limit-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute("data-limit", "tokens");
    await page.getByTestId("limit-raise").click();
    await page.getByTestId("raise-input").fill("8000");
    await page.getByTestId("raise-confirm").click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("status-tick")).toHaveText("tick 1", { timeout: 30_000 });
  } finally {
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});
