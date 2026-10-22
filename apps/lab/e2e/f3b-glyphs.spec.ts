import { expect, test, type Page } from "@playwright/test";
import { loadDemo, sendTo, stepUntilEnded } from "./helpers.ts";

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
  const tile = await fontsOf(page, "attention-tile");
  expect(tile.find((f) => f.family === "AgentSim Glyphs")?.glyphs, "✕ ▲ in the attention tile").toBeGreaterThan(0);
});
