import type { ResimRunner } from "./resim-controller.ts";
import { resimulateWindow } from "./resim-window.ts";

/** In place: for tests and for anything that is already off the main thread. */
export const inlineRunner: ResimRunner = async (req) => resimulateWindow({ ...req, nowWallMs: () => Date.now(), ...(req.snapshot ? { snapshot: req.snapshot } : {}) });
