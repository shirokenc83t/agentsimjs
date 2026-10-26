import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openWorkspace, sendTo, stepUntilEnded } from "./helpers.ts";

// ADR-0042 §4: one glyph per meaning, and no glyph from a system font. The JetBrains Mono we serve is the Latin subset, so the symbols of the chrome come from
// the face drawn for them ("AgentSim Glyphs"); the browser says which font drew each run of text.

async function fontsOf(page: Page, testId: string): Promise<{ family: string; glyphs: number }[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-testid="${testId}"]` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f: { familyName: string; glyphCount: number }) => ({ family: f.familyName, glyphs: f.glyphCount }));
  } finally {
    await cdp.detach();
  }
}

test("the symbols of the chrome are drawn by the glyph font, never by a system font", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await sendTo(page, "ugv-001", 50, 45); // a failure: ✕ in the player's attention tile and ▲ for the low battery
  await stepUntilEnded(page, 5);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  for (const id of ["status-state", "attention-tile", "player-state", "tab-scene"]) {
    const fonts = await fontsOf(page, id);
    // The faces we serve (a weight can carry its own name, "JetBrains Mono SemiBold"): nothing from the system.
    for (const f of fonts) expect(f.family, `${id}: ${f.family}`).toMatch(/^(JetBrains Mono|IBM Plex Sans|AgentSim Glyphs)/);
  }
  const status = await fontsOf(page, "status-state");
  expect(status.find((f) => f.family === "AgentSim Glyphs")?.glyphs, "❚❚ or ▶ in the status bar").toBeGreaterThan(0);
  // Each count is its own element (a zero is neutral, the others take their role colour): the symbols are drawn in them.
  for (const id of ["attention-count-alarm", "attention-count-warning"]) {
    const count = await fontsOf(page, id);
    expect(count.find((f) => f.family === "AgentSim Glyphs")?.glyphs, `${id}: ✕ or ▲ in the attention tile`).toBeGreaterThan(0);
  }
});

test("a key state quoted in Settings prose is a mono chip: its symbols are drawn by the glyph font at the chrome's size, not by the sans text's face", async ({ page }) => {
  await loadDemo(page);
  await openWorkspace(page, "settings");
  await expect(page.getByTestId("key-state-set")).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  for (const id of ["key-state-set", "key-state-unset"]) {
    const fonts = await fontsOf(page, id);
    expect(fonts.find((f) => f.family === "AgentSim Glyphs")?.glyphs, `${id}: the circle`).toBeGreaterThan(0);
    for (const f of fonts) expect(f.family, `${id}: ${f.family}`).toMatch(/^(JetBrains Mono|AgentSim Glyphs)/); // never IBM Plex Sans
    const size = await page.getByTestId(id).evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("12px");
  }
});
