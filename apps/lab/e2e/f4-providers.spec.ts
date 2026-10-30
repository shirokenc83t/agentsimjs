import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, runCommand, waitForStorageReady } from "./helpers.ts";

// F4 M3 (T-121): Settings → Providers against fake servers on localhost (no real model, no real key): add, test, save, edit, remove, and what is never visible. The server answers like an OpenAI-compatible
// one (`/v1/models`, `/v1/chat/completions`, a tool call when a tool is offered) and with the CORS headers a page needs, or without them for the blocked case.

const KEY = "planted-e2e-key-31415926535";

interface Fake {
  readonly server: Server;
  readonly port: number;
  readonly seen: { url: string; auth: string | undefined }[];
}

async function fake(opts: { cors: boolean; flaky?: boolean } = { cors: true }): Promise<Fake> {
  const seen: Fake["seen"] = [];
  let decisions = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const cors = opts.cors ? { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } : {};
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ object: "list", data: [{ id: "fake-7b" }, { id: "fake-1b" }] }));
      if (req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body || "{}") as { tools?: unknown; messages?: unknown };
        // A decision of a mind (its prompt has the template's sections): idle, after one error when the server is told to be flaky. The probes of Settings: a tool call, or {"ok": true}.
        if (JSON.stringify(parsed.messages ?? []).includes("Who you are")) {
          if (opts.flaky === true && decisions++ === 0) {
            res.statusCode = 503;
            return void res.end("{}");
          }
          return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"idle","timers":[{"op":"set","tag":"wake","delayS":2}]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 12 } }));
        }
        const message = parsed.tools !== undefined ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] } : { role: "assistant", content: '{"ok":true}' };
        return void res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, seen };
}
const stop = (f: Fake) => new Promise<void>((r) => f.server.close(() => r()));

async function openProviders(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await expect(page.getByTestId("settings-panel")).toBeVisible();
}

/** Everything the page shows and holds in its DOM, as one string: text, attributes and input values. */
const everything = (page: Page) =>
  page.evaluate(() => {
    const parts: string[] = [document.documentElement.outerHTML];
    for (const el of document.querySelectorAll("input, textarea")) parts.push((el as HTMLInputElement).value);
    return parts.join("\n");
  });

test("add, test, save a provider with a key typed into a masked field: the key is never shown again, and only the fake server saw it", async ({ page }) => {
  const f = await fake();
  try {
    await openProviders(page);
    await expect(page.getByTestId("pv-empty")).toBeVisible();
    await page.getByTestId("pv-add").click();
    await page.getByTestId("pv-name").fill("fake-local");
    await page.getByTestId("pv-address").fill(`http://localhost:${f.port}/v1`);
    const key = page.getByTestId("pv-key");
    await expect(key).toHaveAttribute("type", "password");
    await key.fill(KEY);
    await page.getByTestId("pv-test-new").click();
    await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "ok");
    await expect(page.getByTestId("pv-result")).toContainText("2 models: fake-1b, fake-7b");
    await expect(page.getByTestId("pv-result")).toContainText("tool calls: answered (probe)");
    await expect(page.getByTestId("pv-result")).toContainText("structured output: json_schema supported");
    await page.getByTestId("pv-save").click();
    // The row says what is held, never the key; the form and its key field are gone.
    await expect(page.getByTestId("pv-key-fake-local")).toHaveText("●●●● set · this session");
    await expect(page.getByTestId("pv-row-fake-local")).toContainText(`http://127.0.0.1`.replace("127.0.0.1", "localhost"));
    await expect(page.getByTestId("pv-row-fake-local")).toContainText("2 · fake-1b …");
    await expect(page.getByTestId("pv-status-fake-local")).toContainText("✓ tested");
    await expect(page.getByTestId("pv-form")).toHaveCount(0);
    expect(await everything(page)).not.toContain(KEY);
    // The server saw the key in the header of the calls to its own address, and nowhere else.
    expect(f.seen.length).toBeGreaterThanOrEqual(3);
    expect(f.seen.every((s) => s.auth === `Bearer ${KEY}` && s.url.startsWith("/v1/"))).toBe(true);
    // Editing never shows it back either: the field is empty and says a key is set.
    await page.getByTestId("pv-edit-fake-local").click();
    await expect(page.getByTestId("pv-key")).toHaveValue("");
    await expect(page.getByTestId("pv-key")).toHaveAttribute("placeholder", /●●●● set/);
    expect(await everything(page)).not.toContain(KEY);
    await page.getByTestId("pv-cancel").click();
  } finally {
    await stop(f);
  }
});

test("a key remembered on this device survives a reload and is in no table the SQL console can read; a key not remembered is gone with the page", async ({ page }) => {
  const f = await fake();
  try {
    await openProviders(page);
    await page.getByTestId("pv-add").click();
    await page.getByTestId("pv-name").fill("kept");
    await page.getByTestId("pv-address").fill(`http://localhost:${f.port}`);
    await page.getByTestId("pv-key").fill(KEY);
    await page.getByTestId("pv-remember").check();
    await page.getByTestId("pv-save").click();
    await expect(page.getByTestId("pv-key-kept")).toHaveText("●●●● set · remembered on this device");
    await page.getByTestId("pv-add").click();
    await page.getByTestId("pv-name").fill("gone");
    await page.getByTestId("pv-address").fill(`http://localhost:${f.port}`);
    await page.getByTestId("pv-key").fill(KEY + "-2");
    await page.getByTestId("pv-save").click();
    await expect(page.getByTestId("pv-key-gone")).toHaveText("●●●● set · this session");

    await page.reload();
    await waitForStorageReady(page);
    await openWorkspace(page, "settings");
    await expect(page.getByTestId("pv-key-kept")).toHaveText("●●●● set · remembered on this device");
    await expect(page.getByTestId("pv-key-gone")).toHaveText("none");
    expect(await everything(page)).not.toContain(KEY);

    // The SQL console reads research data, not user_data: asked for it, it refuses; asked for everything else, the key is nowhere.
    await openWorkspace(page, "data");
    const editor = page.getByTestId("sql-editor");
    await editor.fill("SELECT * FROM user_data");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-error")).toHaveAttribute("data-code", "denied", { timeout: 15_000 });
    await editor.fill("SELECT name, sql FROM sqlite_schema");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-status")).toContainText("rows", { timeout: 15_000 });
    expect(await everything(page)).not.toContain(KEY);
  } finally {
    await stop(f);
  }
});

test("a server that does not allow this page (CORS), one that is not there, and an address the page's policy does not allow each say so in words; nothing goes to the last", async ({ page }) => {
  const blocked = await fake({ cors: false });
  const down = await fake();
  const downPort = down.port;
  await stop(down);
  const outside: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("http://192.168.1.20")) outside.push(r.url());
  });
  try {
    await openProviders(page);
    const tryAddress = async (address: string) => {
      await page.getByTestId("pv-add").click();
      await page.getByTestId("pv-name").fill("probe");
      await page.getByTestId("pv-address").fill(address);
      await page.getByTestId("pv-test-new").click();
      const r = page.getByTestId("pv-result");
      await expect(r).toBeVisible({ timeout: 20_000 });
      const kind = await r.getAttribute("data-kind");
      const text = (await r.textContent()) ?? "";
      await page.getByTestId("pv-cancel").click();
      return { kind, text };
    };
    const cors = await tryAddress(`http://localhost:${blocked.port}`);
    expect(cors.kind).toBe("cors");
    expect(cors.text).toContain("blocked by the browser (CORS)");
    expect(cors.text).toContain("OLLAMA_ORIGINS=");
    const gone = await tryAddress(`http://localhost:${downPort}`);
    expect(gone.kind).toBe("unreachable");
    const remote = await tryAddress("http://192.168.1.20:8000");
    expect(remote.kind).toBe("not_allowed");
    expect(remote.text).toContain("may not call 192.168.1.20:8000");
    expect(outside).toEqual([]);
  } finally {
    await stop(blocked);
  }
});

test("an address the page's policy does not list is saved with ▲ endpoint not allowed yet, listed in Endpoints with the line a server adds, and removing a provider asks first", async ({ page }) => {
  await openProviders(page);
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("lab-vllm");
  await page.getByTestId("pv-address").fill("http://192.168.1.20:8000/v1");
  await page.getByTestId("pv-save").click();
  await expect(page.getByTestId("pv-status-lab-vllm")).toContainText("▲ endpoint not allowed yet");
  await page.getByTestId("st-jump-endpoints").click();
  await expect(page.getByTestId("pv-csp-line")).toHaveText("connect-src 'self' http://localhost:* http://127.0.0.1:* http://192.168.1.20:8000");
  // The address of the provider is a row of its own (the reason for the line), with no ✕: it is the provider's.
  await expect(page.getByTestId("pv-endpoint")).toHaveCount(1);
  await expect(page.getByTestId("pv-endpoint")).toContainText("http://192.168.1.20:8000");
  await expect(page.getByTestId("pv-endpoint")).toContainText("▲ not allowed yet");
  await expect(page.getByTestId("pv-endpoint")).toContainText("address of lab-vllm");
  await page.getByTestId("pv-endpoint-input").fill("https://api.example.com");
  await page.getByTestId("pv-endpoint-add").click();
  await expect(page.getByTestId("pv-endpoint")).toHaveCount(2);
  await expect(page.getByTestId("pv-endpoint").filter({ hasText: "https://api.example.com:443" })).toContainText("▲ not allowed yet");
  await page.getByRole("button", { name: "Remove https://api.example.com:443" }).click();
  await expect(page.getByTestId("pv-endpoint")).toHaveCount(1);
  // Removing asks first, and Cancel keeps it.
  await page.getByTestId("pv-remove-lab-vllm").click();
  await expect(page.getByTestId("pv-confirm")).toContainText("Remove lab-vllm?");
  await page.getByTestId("pv-confirm").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("pv-row-lab-vllm")).toBeVisible();
  await page.getByTestId("pv-remove-lab-vllm").click();
  await page.getByTestId("pv-confirm-remove").click();
  await expect(page.getByTestId("pv-row-lab-vllm")).toHaveCount(0);
});

test("a run whose mind is a model over a provider with a remembered key: the worker's calls carry the key to the server, and it is in no record, cache entry, run header, console line, notice or export", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const f = await fake({ cors: true, flaky: true });
  const lines: string[] = [];
  page.on("console", (m) => lines.push(m.text()));
  page.on("worker", (w) => w.on("console", (m) => lines.push(m.text())));
  page.on("pageerror", (e) => lines.push(e.message));
  try {
    await openProviders(page);
    await page.getByTestId("pv-add").click();
    await page.getByTestId("pv-name").fill("fake-local");
    await page.getByTestId("pv-address").fill(`http://localhost:${f.port}`);
    await page.getByTestId("pv-key").fill(KEY);
    await page.getByTestId("pv-remember").check();
    await page.getByTestId("pv-test-new").click();
    await expect(page.getByTestId("pv-result")).toHaveAttribute("data-kind", "ok");
    await page.getByTestId("pv-save").click();
    const started = await page.evaluate(() => window.__agentsim?.startMindsRun?.({ provider: "fake-local", model: "fake-7b" }).then(() => "ok", (e: unknown) => String(e)));
    expect(started).toBe("ok");
    await expect(page.getByTestId("status-tick")).toHaveText("tick 0", { timeout: 30_000 });
    // Let the mind decide a few times: a step is a tick, and the first request waits for the model.
    for (let i = 0; i < 6; i++) {
      await page.getByTestId("step").click();
      await expect(page.getByTestId("status-tick")).toHaveText(`tick ${i + 1}`, { timeout: 30_000 });
    }
    await expect.poll(() => f.seen.filter((s) => s.url === "/v1/chat/completions").length, { timeout: 60_000 }).toBeGreaterThan(3);
    // The decision calls reached the server with the key in the header, to its address only.
    const calls = f.seen.filter((s) => s.url === "/v1/chat/completions");
    expect(calls.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);

    // The researcher's side. First the page as it is (the queries below name the key, so they come after): no key in it.
    expect(await everything(page)).not.toContain(KEY);
    // The console reads research data; the key is in none of it (a model error is among the records: the server was flaky once).
    await openWorkspace(page, "data");
    const run = async (sql: string) => {
      await page.getByTestId("sql-editor").fill(sql);
      await page.getByTestId("sql-run").click();
      await expect(page.getByTestId("sql-status")).toContainText(/rows?/, { timeout: 15_000 });
      return (await page.getByTestId("sql-grid").textContent()) ?? "";
    };
    const modelCalls = Number(/\d+/.exec(await run("SELECT count(*) AS n FROM trace_records WHERE payload LIKE '%llm-call%'"))?.[0] ?? 0);
    expect(modelCalls).toBeGreaterThan(1);
    for (const q of [
      `SELECT count(*) AS n FROM trace_records WHERE payload LIKE '%${KEY}%' OR agent_id LIKE '%${KEY}%'`,
      `SELECT count(*) AS n FROM response_cache WHERE value LIKE '%${KEY}%' OR key LIKE '%${KEY}%' OR provider_kind LIKE '%${KEY}%'`,
      `SELECT count(*) AS n FROM runs WHERE run_config LIKE '%${KEY}%' OR label LIKE '%${KEY}%'`,
      `SELECT count(*) AS n FROM mind_profiles WHERE document LIKE '%${KEY}%'`,
    ]) {
      await run(q);
      await expect(page.getByTestId("sql-grid")).toContainText("0");
      await expect(page.getByTestId("sql-grid")).not.toContainText(KEY);
    }

    // The database export leaves the remembered key out (it is in user_data, which is not research data).
    const download = page.waitForEvent("download");
    await runCommand(page, "Export database (.sqlite)");
    const path = await (await download).path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    expect(bytes.toString("latin1").includes(KEY)).toBe(false);
    // Nothing the page or its workers printed holds the key.
    expect(lines.filter((l) => l.includes(KEY))).toEqual([]);
    testInfo.annotations.push({ type: "calls", description: String(calls.length) });
  } finally {
    await stop(f);
  }
});
