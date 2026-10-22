import type { Page } from "@playwright/test";

/** sRGB of the pixel (x, y) of a PNG, read back through a canvas in the page. */
export async function pixel(page: Page, png: Buffer, x: number, y: number): Promise<[number, number, number]> {
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

export const luminance = ([r, g, b]: [number, number, number]) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
export const ratio = (a: [number, number, number], b: [number, number, number]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

