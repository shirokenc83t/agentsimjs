import { expect, type Page } from "@playwright/test";

/** Collects CSP-related problems from the page and all its workers (console + violation events). */
export function watchCsp(page: Page): string[] {
  const problems: string[] = [];
  const isCsp = (t: string) => /Content Security Policy|unsafe-eval|EvalError|Refused to/i.test(t);
  page.on("console", (m) => {
    if (isCsp(m.text())) problems.push(`page: ${m.text()}`);
  });
  page.on("worker", (w) =>
    w.on("console", (m) => {
      if (isCsp(m.text())) problems.push(`worker ${w.url()}: ${m.text()}`);
    }),
  );
  page.on("pageerror", (e) => {
    if (isCsp(e.message)) problems.push(`pageerror: ${e.message}`);
  });
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`Refused to (securitypolicyviolation) ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return problems;
}

export async function waitForStorageReady(page: Page): Promise<void> {
  await expect(page.getByTestId("status-storage")).toHaveText(/db: (opfs-sahpool|memory-fallback)/, { timeout: 30_000 });
}

export async function openWorkspace(page: Page, id: "scene" | "debug" | "author" | "data" | "settings"): Promise<void> {
  await page.getByTestId(`tab-${id}`).click();
  await expect(page.getByTestId(`workspace-${id}`)).toBeVisible();
}

/** Opens the lab with the probe and loads the F1 demo as a new run (paused at tick 0, atlas uploaded). */
export async function loadDemo(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  await page.keyboard.press("Escape");
  await sceneSettled(page);
}

/** The 1 km² world uploads 1,024 chunks at 16 per frame: allow for slow software GL. */
export async function referenceSettled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__agentsim?.scene?.stats();
          return s !== undefined && s.pages > 0 && s.chunksPending === 0;
        }),
      { timeout: 120_000 },
    )
    .toBe(true);
}

export async function loadReference(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-reference").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-reference-1km v\d+$/, { timeout: 60_000 });
}

/** Loads an F2 demo preset from the palette ("discovery" or "agents"): new run, `unknown` maps, paused at tick 0. */
export async function loadF2(page: Page, which: "discovery" | "agents") {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await runCommand(page, which === "discovery" ? "Load F2 discovery demo" : "Load F2 20 agents demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(which === "discovery" ? /^f2-discovery v\d+$/ : /^f2-20-agents v\d+$/, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await sceneSettled(page);
}

/**
 * The visible scene has a grid (at least one atlas page) and every chunk uploaded. Checking pending chunks
 * alone is not enough: a renderer without a grid also has none pending.
 */
export async function sceneSettled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__agentsim?.scene?.stats();
        return s !== undefined && s.pages > 0 && s.chunksPending === 0;
      }),
    )
    .toBe(true);
}

/**
 * Runs a command from the palette, waiting for it to open and close. Enter runs the first listed match and does nothing
 * when the list is empty, so the entry must be listed first: the agent and preset entries come from a lazy module that
 * the first open still has to fetch.
 */
export async function runCommand(page: Page, title: string) {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill(title);
  await expect(palette.getByRole("option", { name: title }).first()).toBeVisible();
  await palette.getByRole("textbox").press("Enter");
  await expect(palette).toHaveCount(0);
}

/**
 * Steps `hundreds` × 100 ticks (lockstep, deterministic), waiting for each batch. `timeoutMs` per batch:
 * raise it for heavy batches (e.g. a cross-map query on the 1 km² world) on slow CI runners.
 */
export async function step(page: Page, hundreds: number, timeoutMs = 5_000) {
  // The tick the sim is at now, from the client (updated on every state message), not from the status line: that is polled at
  // ≤ 10 Hz and right after a load can still show the previous world's tick (a dummy-world "tick 3" over a run at tick 0), which
  // made the target wrong by that much (seen in 7 of 60 loads on a hardware GPU).
  const start = await page.evaluate(() => (window.__agentsim?.sim() as { tick: number } | undefined)?.tick);
  if (start === undefined) throw new Error("step() needs the probe: open the page with ?probe");
  for (let k = 1; k <= hundreds; k++) {
    await runCommand(page, "Step 100 ticks");
    try {
      await expect(page.getByTestId("status-tick")).toHaveText(`tick ${start + k * 100}`, { timeout: timeoutMs });
    } catch (e) {
      const status = await page.getByTestId("statusline").textContent();
      const sim = await page.evaluate(() => JSON.stringify(window.__agentsim?.sim()));
      throw new Error(`step stalled; status: ${status}; sim: ${sim}`, { cause: e });
    }
  }
}

/** Steps 100 ticks at a time until the selected agent's action has ended (at most `maxHundreds` batches). */
export async function stepUntilEnded(page: Page, maxHundreds: number) {
  // A command applies at the next tick: step once before reading the action, or the previous one is read.
  await step(page, 1);
  for (let k = 1; k < maxHundreds; k++) {
    const label = (await page.getByTestId("inspector-action-label").textContent()) ?? "";
    if (/succeeded|failed|preempted/.test(label)) return;
    await step(page, 1);
  }
}

/** Selects an agent in the Explorer and sends it to (x, y) m with the "send to" mode. */
export async function sendTo(page: Page, agentId: string, x: number, y: number) {
  await page.getByTestId(`explorer-row-${agentId}`).click();
  await page.getByTestId("send-to").click();
  await expect(page.getByTestId("send-to")).toHaveAttribute("aria-pressed", "true");
  const p = await page.evaluate(([px, py]) => window.__agentsim?.scene?.screenOfGround(px ?? 0, py ?? 0), [x, y]);
  await page.mouse.click(p?.x ?? 0, p?.y ?? 0);
  await expect(page.getByTestId("send-to")).toHaveAttribute("aria-pressed", "false");
}

/** Activates a dockview panel tab (e.g. "Run configuration" next to the scenario editor in Author). */
export async function openPanelTab(page: Page, title: string) {
  await page.getByRole("tab", { name: title, exact: true }).click();
  await expect(page.getByRole("tab", { name: title, exact: true })).toHaveAttribute("aria-selected", "true");
}

/** Counts what the main thread posts to the sim worker (`window.__simMsgs`): install before the page loads. */
export async function countSimMessages(page: Page) {
  await page.addInitScript(() => {
    const W = window.Worker;
    const log: string[] = [];
    (window as unknown as { __simMsgs: string[] }).__simMsgs = log;
    const Patched = function (this: Worker, url: string | URL, opts?: WorkerOptions) {
      const w = new W(url, opts);
      if (opts?.name === "sim") {
        const post = w.postMessage.bind(w) as (m: unknown, t?: unknown) => void;
        w.postMessage = ((m: { type?: string }, t?: unknown) => {
          log.push(m?.type ?? "?");
          post(m, t);
        }) as Worker["postMessage"];
      }
      return w;
    } as unknown as typeof Worker;
    Patched.prototype = W.prototype;
    window.Worker = Patched;
  });
}

export const simMessages = (page: Page) => page.evaluate(() => (window as unknown as { __simMsgs: string[] }).__simMsgs.slice());

export async function setReplayCursor(page: Page, seconds: number) {
  await page.getByTestId("replay-cursor").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
  await expect(page.getByTestId("replay-time")).toContainText(`${seconds.toFixed(1)} s /`);
}

