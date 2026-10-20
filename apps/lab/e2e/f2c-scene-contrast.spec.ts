import { expect, test, type Page } from "@playwright/test";
import { loadF2 } from "./helpers.ts";

// The scene tells its ground from its background in both themes (ADR-0032: scene colours come from tokens). Found by a manual check of the F2 20 agents preset in the
// dark theme: the ground was 1.1:1 against the background, a floor nobody sees. The rendered pixels are read from a screenshot of the Scene.

/** sRGB of the pixel (x, y) of a PNG, read back through a canvas in the page. */
async function pixel(page: Page, png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ([b64, px, py]) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("png"));
        img.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      if (!g) throw new Error("canvas");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(px as number, py as number, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number];
    },
    [png.toString("base64"), x, y] as const,
  );
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a: [number, number, number], b: [number, number, number]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

for (const theme of ["dark", "light"] as const) {
  test(`the F2 20 agents scene: the ground is distinguishable from the background, ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
    await loadF2(page, "agents");
    await page.waitForTimeout(1000);
    const png = await page.screenshot();
    // At the default 1280 × 720 viewport and the default camera: the backdrop above the horizon, between the two overlay panels; the ground below it, left of the wall.
    const background = await pixel(page, png, 600, 130);
    const ground = await pixel(page, png, 450, 560);
    expect(ratio(ground, background), `${theme}: ground ${ground} on background ${background}`).toBeGreaterThanOrEqual(1.2);
  });
}
