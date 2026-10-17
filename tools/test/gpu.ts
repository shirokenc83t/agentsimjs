import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Hardware-GPU launch flags for headless Chromium (ADR-0022). Default headless Chromium renders WebGL
 * in software (SwiftShader); `pnpm test:e2e:gpu` and `pnpm bench:gpu` use these flags instead.
 */
const GPU_ARGS: Record<string, string[]> = {
  win32: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"],
  darwin: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
  linux: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan"],
};

export function gpuLaunchArgs(enabled: boolean): string[] {
  return enabled ? (GPU_ARGS[process.platform] ?? []) : [];
}

/** WebGL renderer string of the page's realm (reported with GPU-gated results). */
export const RENDERER_PROBE = `(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
})()`;

export const isSoftwareRenderer = (renderer: string): boolean => /SwiftShader|llvmpipe|software/i.test(renderer);

/** Where `pnpm test:e2e:gpu` writes its evidence (git-ignored), one entry per GPU-gated test. */
export const GPU_RECORD_FILE = "bench/local/e2e-gpu.json";

/**
 * Merges one test's record into `bench/local/e2e-gpu.json` (several GPU-gated tests share the file, which goes
 * into the CHANGELOG at phase close). Node-side only (Playwright specs).
 */
export function writeGpuRecord(key: string, record: Record<string, unknown>): void {
  mkdirSync("bench/local", { recursive: true });
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(readFileSync(GPU_RECORD_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all[key] = { ...record, measuredAt: new Date().toISOString() };
  writeFileSync(GPU_RECORD_FILE, JSON.stringify(all, null, 2) + "\n");
}
