import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, waitForStorageReady } from "./helpers.ts";

// F4 M3 review material: Settings → Providers and keys in both themes at 1440 and 1000 px, in the states the designer's board draws: empty, one provider, a test that succeeded, a test that failed, and a key
// entered and masked. The server is a fake one on localhost (no model, no real key). Skipped unless AGENTSIM_REVIEW_DIR names the folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");

async function fakeServer(withCors = true) {
  const server = createServer((req, res) => {
    const cors = !withCors ? {} : { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "Qwen2.5-7B-Instruct" }, { id: "Llama-3.1-8B" }, { id: "Mistral-7B" }] }));
      const tools = (JSON.parse(body || "{}") as { tools?: unknown }).tools !== undefined;
      res.end(JSON.stringify({ choices: [{ message: tools ? { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "ping", arguments: "{}" } }] } : { role: "assistant", content: '{"ok":true}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function shot(page: Page, name: string, theme: string, width: number) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  mkdirSync(DIR as string, { recursive: true });
  await page.getByTestId("workspace-settings").screenshot({ path: `${DIR}/${name}-${width}-${theme}.png` });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 1000] as const) {
    test(`Settings → Providers, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(120_000);
      const ok = await fakeServer();
      const down = await fakeServer();
      const downPort = down.port;
      await new Promise<void>((r) => down.server.close(() => r()));
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
        await page.goto("/?probe");
        await waitForStorageReady(page);
        await openWorkspace(page, "settings");
        await page.getByTestId("st-jump-providers").click();
        await expect(page.getByTestId("pv-empty")).toBeVisible();
        await shot(page, "providers-empty", theme, width);

        // A test that succeeded, in the form, before saving; the key typed and masked.
        await page.getByTestId("pv-add").click();
        await page.getByTestId("pv-name").fill("local-ollama");
        await page.getByTestId("pv-address").fill(`http://localhost:${ok.port}`);
        await page.getByTestId("pv-key").fill("planted-review-key-0123456789");
        await shot(page, "providers-key-masked", theme, width);
        await page.getByTestId("pv-test-new").click();
        await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "ok");
        await shot(page, "providers-test-ok", theme, width);

        // One provider saved: the key says set, never its value.
        await page.getByTestId("pv-save").click();
        await expect(page.getByTestId("pv-key-local-ollama")).toContainText("●●●● set");
        await page.getByTestId("st-jump-providers").click();
        await shot(page, "providers-one", theme, width);

        // A test that failed: a server that is not there.
        await page.getByTestId("pv-add").click();
        await page.getByTestId("pv-name").fill("lab-sglang");
        await page.getByTestId("pv-address").fill(`http://localhost:${downPort}`);
        await page.getByTestId("pv-test-new").click();
        await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "unreachable", { timeout: 20_000 });
        await shot(page, "providers-test-failed", theme, width);
      } finally {
        await new Promise<void>((r) => ok.server.close(() => r()));
      }
    });
  }
}

// The two states the designer could not review (U-022): an endpoint the page's policy does not allow yet (with the server's line and the copy button, the row marked ▲, the Endpoints chip too), and a failure
// by CORS (a server that answers without allowing this origin, with the start lines for Ollama and vLLM). At 1440 px, in both themes.
for (const theme of ["dark", "light"] as const) {
  test(`Settings → Providers, endpoint not allowed and CORS failure, ${theme}, 1440 px`, async ({ page }) => {
    test.setTimeout(120_000);
    const plain = await fakeServer(false);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await page.goto("/?probe");
      await waitForStorageReady(page);
      await openWorkspace(page, "settings");
      await page.getByTestId("st-jump-providers").click();
      // CORS: the server is there and answers, but not to this page.
      await page.getByTestId("pv-add").click();
      await page.getByTestId("pv-name").fill("local-vllm");
      await page.getByTestId("pv-address").fill(`http://localhost:${plain.port}`);
      await page.getByTestId("pv-test-new").click();
      await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "cors", { timeout: 20_000 });
      await shot(page, "providers-test-cors", theme, 1440);
      await page.getByTestId("pv-cancel").click();
      // An address the page's policy does not list: the test says so without a request, the row and the Endpoints chip carry ▲, and the line for the server's policy has its copy button.
      await page.getByTestId("pv-add").click();
      await page.getByTestId("pv-name").fill("team-gpu");
      await page.getByTestId("pv-address").fill("http://gpu-box.internal.example:8000");
      await page.getByTestId("pv-test-new").click();
      await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "not_allowed");
      await page.getByTestId("pv-save").click();
      await expect(page.getByTestId("pv-status-team-gpu")).toContainText("endpoint not allowed yet");
      await expect(page.getByTestId("st-jump-endpoints")).toContainText("▲");
      await page.getByTestId("st-jump-providers").click();
      await shot(page, "providers-not-allowed", theme, 1440);
      await page.getByTestId("st-jump-endpoints").click();
      await expect(page.getByTestId("pv-csp-copy")).toBeVisible();
      await shot(page, "endpoints-not-allowed", theme, 1440);
    } finally {
      await new Promise<void>((r) => plain.server.close(() => r()));
    }
  });
}
